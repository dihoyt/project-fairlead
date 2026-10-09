import type { Database } from "better-sqlite3";
import type { Events } from "../../contracts/events.js";
import type { Status } from "../../contracts/health.js";
import type { ChannelKind, WebhookPayload } from "../../contracts/notify.js";
import type { Logger, SecretStore } from "../../contracts/index.js";
import { product } from "../../product.js";
import { deliver, type DeliveryResult } from "./channels.js";
import type { Mailer } from "./mailer.js";
import { getChannelRow, listChannelRows, markResult, parseConfig, type ChannelRow } from "./store.js";

export const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 30_000;

export interface Timing {
  // A change is sent once its check has held the new status this long, so a
  // check that flaps and comes back inside the window sends nothing.
  debounceMs: number;
  // A check that keeps flapping is sent anyway once its first change is this
  // old, with whatever status it has then; the next change starts a new hold.
  maxHoldMs: number;
}

interface PendingRow {
  provider_id: string;
  check_id: string;
  label: string;
  from_status: Status;
  to_status: Status;
  detail: string;
  first_at: number;
  last_at: number;
  rev: number;
  attempts: number;
}

type Change = Events["health.changed"];

const ALERT_RANK: Partial<Record<Status, number>> = { warn: 1, crit: 2 };

// What a channel should be told, given the settled status of a check and the
// last status that channel was told about for it ("ok" when never told).
// Only warn/crit at or above the channel's minimum are alerts; a return to
// "ok" is sent only to channels that were told about the problem.
export function shouldSend(minSeverity: "warn" | "crit", lastSent: Status, to: Status): boolean {
  const rank = ALERT_RANK[to];
  if (rank !== undefined) return rank >= ALERT_RANK[minSeverity]! && lastSent !== to;
  if (to === "ok") return lastSent === "warn" || lastSent === "crit";
  return false;
}

export function createEngine(deps: {
  db: Database;
  orgId: string;
  secrets: SecretStore;
  log: Logger;
  timing: () => Timing;
  mailer?: Mailer;
  now?: () => number;
}) {
  const { db, orgId, secrets, log } = deps;
  const now = deps.now ?? Date.now;

  const upsertPending = db.prepare(`
    INSERT INTO notify_pending (org_id, provider_id, check_id, label, from_status, to_status, detail, first_at, last_at)
    VALUES (@orgId, @providerId, @checkId, @label, @from, @to, @detail, @at, @at)
    ON CONFLICT (org_id, provider_id, check_id) DO UPDATE SET
      label = excluded.label, to_status = excluded.to_status, detail = excluded.detail,
      last_at = excluded.last_at, rev = rev + 1, attempts = 0, next_attempt_at = 0
  `);
  const duePending = db.prepare(`
    SELECT provider_id, check_id, label, from_status, to_status, detail, first_at, last_at, rev, attempts
    FROM notify_pending
    WHERE org_id = ? AND next_attempt_at <= ? AND (last_at <= ? OR first_at <= ?)
    ORDER BY first_at
  `);
  const deletePending = db.prepare(
    "DELETE FROM notify_pending WHERE org_id = ? AND provider_id = ? AND check_id = ? AND rev = ?"
  );
  const retryPending = db.prepare(`
    UPDATE notify_pending SET attempts = attempts + 1, next_attempt_at = ?
    WHERE org_id = ? AND provider_id = ? AND check_id = ? AND rev = ?
  `);
  const getSent = db.prepare(
    "SELECT status, sent_at FROM notify_sent WHERE org_id = ? AND channel_id = ? AND provider_id = ? AND check_id = ?"
  );
  const putSent = db.prepare(`
    INSERT INTO notify_sent (org_id, channel_id, provider_id, check_id, status, sent_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id, channel_id, provider_id, check_id) DO UPDATE SET status = excluded.status, sent_at = excluded.sent_at
  `);
  const dropSent = db.prepare(
    "DELETE FROM notify_sent WHERE org_id = ? AND channel_id = ? AND provider_id = ? AND check_id = ?"
  );

  // Decides and records in one write transaction, so when two pods flush the
  // same change during a rollout only one of them sends it.
  const claim = db.transaction(
    (channel: ChannelRow, row: PendingRow): { previous: { status: Status; sent_at: string } | undefined } | null => {
      const previous = getSent.get(orgId, channel.id, row.provider_id, row.check_id) as
        { status: Status; sent_at: string } | undefined;
      if (!shouldSend(channel.min_severity, previous?.status ?? "ok", row.to_status)) return null;
      putSent.run(orgId, channel.id, row.provider_id, row.check_id, row.to_status, new Date(now()).toISOString());
      return { previous };
    }
  );

  function release(channel: ChannelRow, row: PendingRow, previous: { status: Status; sent_at: string } | undefined) {
    if (previous) putSent.run(orgId, channel.id, row.provider_id, row.check_id, previous.status, previous.sent_at);
    else dropSent.run(orgId, channel.id, row.provider_id, row.check_id);
  }

  async function send(channel: ChannelRow, payload: WebhookPayload, signal?: AbortSignal): Promise<DeliveryResult> {
    const config = parseConfig(channel.config);
    const kind = channel.kind as ChannelKind;
    const result =
      kind === "email"
        ? deps.mailer
          ? await deps.mailer.send(channel.id, config.email, payload, signal)
          : { ok: false, error: "Email is not set up in this process." }
        : await deliver({ kind, config, secret: await secrets.get("notify", channel.id), payload }, signal);
    markResult(db, orgId, channel.id, result, new Date(now()).toISOString());
    return result;
  }

  async function flushRow(row: PendingRow, signal?: AbortSignal): Promise<void> {
    const payload: WebhookPayload = {
      source: product.displayName,
      providerId: row.provider_id,
      checkId: row.check_id,
      label: row.label,
      from: row.from_status,
      to: row.to_status,
      detail: row.detail,
      at: new Date(row.last_at).toISOString(),
    };
    let failed = false;
    for (const channel of listChannelRows(db, orgId)) {
      if (!channel.enabled) continue;
      const claimed = claim.immediate(channel, row);
      if (!claimed) continue;
      const result = await send(channel, payload, signal);
      if (!result.ok) {
        failed = true;
        release(channel, row, claimed.previous);
        log.warn("Notification failed", { channel: channel.id, kind: channel.kind, error: result.error });
      }
    }
    // Keyed on rev: a change that arrived while this one was being sent stays
    // pending and is judged on its own.
    if (failed && row.attempts + 1 < MAX_ATTEMPTS) {
      retryPending.run(now() + RETRY_BASE_MS * 2 ** row.attempts, orgId, row.provider_id, row.check_id, row.rev);
    } else {
      deletePending.run(orgId, row.provider_id, row.check_id, row.rev);
    }
  }

  return {
    record(change: Change): void {
      upsertPending.run({ orgId, ...change, at: now() });
    },

    async flush(signal?: AbortSignal): Promise<void> {
      const { debounceMs, maxHoldMs } = deps.timing();
      const t = now();
      const rows = duePending.all(orgId, t, t - debounceMs, t - maxHoldMs) as PendingRow[];
      for (const row of rows) {
        if (signal?.aborted) return;
        await flushRow(row, signal);
      }
    },

    async test(channelId: string): Promise<DeliveryResult | null> {
      const channel = getChannelRow(db, orgId, channelId);
      if (!channel) return null;
      return send(channel, {
        source: product.displayName,
        providerId: "notify",
        checkId: "test",
        label: "Test notification",
        from: "ok",
        to: "warn",
        detail: `A test from ${product.displayName}. If you can read this, the "${channel.label}" channel works.`,
        at: new Date(now()).toISOString(),
      });
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
