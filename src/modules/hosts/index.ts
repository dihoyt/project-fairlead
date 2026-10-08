import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import type { HostView } from "../../contracts/hosts.js";
import type { Module, ModuleContext } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";
import { errorMessage } from "../../runtime/log.js";
import { migrations } from "./migrations.js";
import { startHosts, TICK_MS, type HostsService } from "./service.js";
import { credentialProblem } from "./ssh.js";
import { toView, type HostFields, type HostRow } from "./store.js";

const absolutePath = z
  .string()
  .trim()
  .max(1024)
  .refine((p) => p.startsWith("/") && !p.includes("\0") && !p.includes("\n"), "Must be an absolute path.")
  .transform((p) => {
    const normal = posix.normalize(p);
    return normal.length > 1 ? normal.replace(/\/+$/, "") : normal;
  });

const hostRequest = z.object({
  label: z.string().trim().min(1).max(100),
  // Handed to the SSH client as the address only, never to a shell.
  address: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]{1,253}$/, "A hostname or IP address."),
  port: z.number().int().min(1).max(65535).optional(),
  username: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/, "Letters, digits, '.', '_' and '-', up to 64."),
  auth: z.enum(["key", "password"]),
  kind: z.enum(["auto", "linux", "synology", "truenas"]).optional(),
  backupTargetPaths: z.array(absolutePath).max(16).optional(),
  credential: z.string().max(16_384).optional(),
  useGeneratedKey: z.boolean().optional(),
  hostKeyFingerprint: z
    .string()
    .trim()
    .regex(/^SHA256:[A-Za-z0-9+/]{43}$/, 'As OpenSSH prints it: "SHA256:" and 43 characters.')
    .optional()
    .or(z.literal("")),
});

type ParsedRequest = z.infer<typeof hostRequest>;

function parseRequest(body: unknown): ParsedRequest {
  const parsed = hostRequest.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  const req = parsed.data;
  if (req.useGeneratedKey) {
    if (req.auth !== "key") throw new HttpError(400, 'useGeneratedKey: only with auth "key".');
    delete req.credential;
  }
  // Keys pasted from a browser textarea may carry CRLF or lose the trailing newline.
  if (req.credential !== undefined && req.auth === "key")
    req.credential = `${req.credential.replace(/\r\n/g, "\n").trim()}\n`;
  if (req.credential !== undefined && req.credential.trim() !== "") {
    const problem = credentialProblem(req.auth, req.credential);
    if (problem) throw new HttpError(400, `credential: ${problem}`);
  }
  return req;
}

function fields(req: ParsedRequest, pin: string | null): HostFields {
  return {
    label: req.label,
    address: req.address,
    port: req.port ?? 22,
    username: req.username,
    auth: req.auth,
    kind: req.kind ?? "auto",
    backupTargetPaths: [...new Set(req.backupTargetPaths ?? [])],
    hostKeyFingerprint: pin,
    generatedKey: !!req.useGeneratedKey,
  };
}

const sameEndpoint = (row: HostRow, f: Pick<HostFields, "address" | "port" | "username" | "auth">) =>
  row.address === f.address && row.port === f.port && row.username === f.username && row.auth === f.auth;

function register(ctx: ModuleContext): HostsService {
  const interval = ctx.settings.declare({
    key: "hosts.intervalSeconds",
    label: "Collect every (seconds)",
    help: "How often each host is visited over SSH.",
    schema: z.number().int().min(30).max(3600),
    default: 60,
    env: "HOSTS_INTERVAL_SECONDS",
  });
  const diskWarn = ctx.settings.declare({
    key: "hosts.diskWarnPercent",
    label: "Disk space warning at (% used)",
    schema: z.number().min(1).max(100),
    default: 85,
  });
  const diskCrit = ctx.settings.declare({
    key: "hosts.diskCritPercent",
    label: "Disk space critical at (% used)",
    schema: z.number().min(1).max(100),
    default: 95,
  });
  const loadWarn = ctx.settings.declare({
    key: "hosts.loadWarnPerCpu",
    label: "Load warning at (1-minute load per CPU)",
    schema: z.number().min(0.1).max(100),
    default: 2,
  });

  const service = startHosts(ctx, {
    intervalMs: () => interval.get() * 1000,
    thresholds: () => ({
      diskWarnPercent: diskWarn.get(),
      diskCritPercent: diskCrit.get(),
      loadWarnPerCpu: loadWarn.get(),
    }),
  });
  const { store, keypair } = service;

  // Secrets are keyed by row id and cannot join the transaction, so the ids
  // are read before the rows go.
  let doomed: string[] = [];
  ctx.reset.add({
    scope: "hosts",
    clear() {
      doomed = store.list().map((row) => row.id);
      for (const id of doomed) service.forget(id);
      return ctx.db.prepare("DELETE FROM hosts_inventory WHERE org_id = ?").run(ctx.orgId).changes;
    },
    async clearAfter() {
      let removed = 0;
      for (const id of doomed) {
        if (await ctx.secrets.has("hosts", id)) {
          await ctx.secrets.delete("hosts", id);
          removed++;
        }
      }
      return removed;
    },
  });
  ctx.reset.add({
    scope: "sshKey",
    async clearAfter() {
      return (await keypair.remove()) ? 1 : 0;
    },
  });

  ctx.health.addProvider(service.provider);
  service.syncCapacities();
  ctx.scheduler.every("collect", TICK_MS, (signal) => service.collectDue(signal), { timeoutMs: 120_000 });

  const view = async (row: HostRow): Promise<HostView> =>
    toView(row, row.generated_key ? await keypair.exists() : await ctx.secrets.has("hosts", row.id));
  const requireKeypair = async () => {
    if (!(await keypair.exists())) throw new HttpError(400, "useGeneratedKey: generate the key pair first.");
  };
  const mustGet = (id: string): HostRow => {
    const row = store.get(id);
    if (!row) throw new HttpError(404, "No such host.");
    return row;
  };
  // Stored before the host row is written, so a refused secret (no
  // SECRETS_KEY) leaves nothing half-saved behind.
  const storeCredential = async (id: string, credential: string) => {
    try {
      await ctx.secrets.put("hosts", id, credential);
    } catch (err) {
      throw new HttpError(503, `The credential could not be stored: ${errorMessage(err)}`);
    }
  };
  // Collected in the background so the response doesn't wait on SSH.
  const kick = (id: string) => {
    void service
      .collectHost(id)
      .catch((err: unknown) => ctx.log.warn("Host collection failed", { host: id, error: String(err) }));
  };

  ctx.route("GET /api/hosts", async () => Promise.all(store.list().map(view)));

  // Bound before "/:id" so "keypair" is never read as a host id.
  ctx.route("GET /api/hosts/keypair", async () => ({ keypair: await keypair.get() }));

  ctx.route("POST /api/hosts/keypair", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const rotate = req.query.rotate === "1";
    const existed = await keypair.exists();
    let generated;
    try {
      generated = await keypair.generate(rotate);
    } catch (err) {
      throw new HttpError(503, `The key pair could not be stored: ${errorMessage(err)}`);
    }
    if (!generated) throw new HttpError(409, "A key pair already exists; rotate it to replace it.");
    if (existed) for (const row of store.list()) if (row.generated_key) service.forget(row.id);
    ctx.audit.record({
      actor: user.id,
      action: existed ? "hosts.rotate-keypair" : "hosts.generate-keypair",
      target: generated.fingerprint,
    });
    return generated;
  });

  ctx.route("GET /api/hosts/:id", async (req) => view(mustGet(req.params.id)));

  ctx.route("POST /api/hosts", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const body = parseRequest(req.body);
    if (body.useGeneratedKey) await requireKeypair();
    else if (!body.credential?.trim())
      throw new HttpError(400, `credential: a ${body.auth === "key" ? "private key" : "password"} is required.`);
    const id = `host_${randomBytes(8).toString("hex")}`;
    const f = fields(body, body.hostKeyFingerprint || null);
    if (body.credential) await storeCredential(id, body.credential);
    store.insert(id, f, new Date().toISOString());
    service.syncCapacities();
    ctx.audit.record({
      actor: user.id,
      action: "hosts.create",
      target: id,
      detail: `"${f.label}" ${f.username}@${f.address}:${f.port} (${f.auth}${f.generatedKey ? ", generated key" : ""})`,
    });
    kick(id);
    return view(mustGet(id));
  });

  ctx.route("PUT /api/hosts/:id", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const existing = mustGet(req.params.id);
    const body = parseRequest(req.body);
    const changedAuth = body.auth !== existing.auth;
    if (body.useGeneratedKey) await requireKeypair();
    else if (changedAuth && !body.credential?.trim()) {
      throw new HttpError(400, "credential: switching between key and password needs the new credential.");
    } else if (existing.generated_key && !body.credential?.trim()) {
      throw new HttpError(400, "credential: leaving the generated key needs a private key or password.");
    }
    const draft = fields(body, null);
    const moved = !sameEndpoint(existing, draft);
    // A fingerprint in the request replaces the pin; moving the host to a
    // different address or port without one clears it, to be pinned again
    // on the next successful connection.
    const addressChanged = existing.address !== draft.address || existing.port !== draft.port;
    const pin = body.hostKeyFingerprint
      ? body.hostKeyFingerprint
      : addressChanged || body.hostKeyFingerprint === ""
        ? null
        : existing.host_key_fingerprint;
    const f = { ...draft, hostKeyFingerprint: pin };
    const switchedKey = f.generatedKey !== !!existing.generated_key;
    const credentialChanged = !!body.credential?.trim() || switchedKey;
    if (body.credential?.trim()) await storeCredential(existing.id, body.credential);
    store.update(
      existing.id,
      f,
      new Date().toISOString(),
      moved || credentialChanged || pin !== existing.host_key_fingerprint
    );
    if (f.generatedKey) await ctx.secrets.delete("hosts", existing.id);
    if (moved || credentialChanged) service.forget(existing.id);
    service.syncCapacities();
    ctx.audit.record({
      actor: user.id,
      action: "hosts.update",
      target: existing.id,
      detail:
        `"${f.label}" ${f.username}@${f.address}:${f.port} (${f.auth})` +
        (switchedKey ? (f.generatedKey ? ", now the generated key" : ", own credential") : "") +
        (credentialChanged && !switchedKey ? ", credential changed" : "") +
        (pin !== existing.host_key_fingerprint ? `, host key ${pin ? `pinned to ${pin}` : "unpinned"}` : ""),
    });
    kick(existing.id);
    return view(mustGet(existing.id));
  });

  ctx.route("DELETE /api/hosts/:id", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const existing = mustGet(req.params.id);
    store.remove(existing.id);
    await ctx.secrets.delete("hosts", existing.id);
    service.forget(existing.id);
    ctx.audit.record({
      actor: user.id,
      action: "hosts.delete",
      target: existing.id,
      detail: `"${existing.label}" ${existing.username}@${existing.address}:${existing.port}`,
    });
    return { ok: true as const };
  });

  ctx.route("POST /api/hosts/test", async (req, res) => {
    const user = ctx.require(req, res, "write");
    if (!user) return undefined;
    const body = parseRequest(req.body);
    const target = fields(body, body.hostKeyFingerprint || null);
    let credential = body.credential?.trim() ? body.credential : undefined;
    if (body.useGeneratedKey) {
      await requireKeypair();
      credential = (await keypair.privateKey()) ?? undefined;
    } else if (!credential) {
      // Testing an edit without re-entering the secret: the stored credential
      // is only ever used against the endpoint it was saved for.
      const match = store.list().find((row) => sameEndpoint(row, target));
      credential = match ? ((await ctx.secrets.get("hosts", match.id)) ?? undefined) : undefined;
    }
    if (!credential) {
      throw new HttpError(
        400,
        `credential: a ${body.auth === "key" ? "private key" : "password"} is required to test.`
      );
    }
    const result = await service.probe({
      label: target.label,
      address: target.address,
      port: target.port,
      username: target.username,
      auth: target.auth,
      credential,
      ...(target.hostKeyFingerprint ? { pin: target.hostKeyFingerprint } : {}),
    });
    ctx.audit.record({
      actor: user.id,
      action: "hosts.test",
      target: `${target.username}@${target.address}:${target.port}`,
      result: result.ok ? "ok" : "error",
      ...(result.error ? { detail: result.error } : {}),
    });
    return result;
  });

  return service;
}

const mod: Module = {
  id: "hosts",
  milestone: "A",
  migrations,
  register: (ctx) => void register(ctx),
};

export { register };
export default mod;
