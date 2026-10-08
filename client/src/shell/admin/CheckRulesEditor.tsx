import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Group, Loader, NumberInput, Select, Stack, Switch, Table, Text } from "@mantine/core";
import type { SettingView } from "@contracts/auth";
import { CATEGORIES, type ProviderState } from "@contracts/health";
import { apiRequest } from "../../ui/api";
import { SettingNotes } from "./SettingField";

// Mirrors the health module's rule shape (src/modules/health/settings.ts).
export interface CheckRule {
  warnAbove?: number;
  critAbove?: number;
  warnBelow?: number;
  critBelow?: number;
  maxStatus?: "ok" | "warn";
  disabled?: boolean;
}

export type Rules = Record<string, CheckRule>;

export interface RuleRow {
  key: string;
  provider: string;
  label: string;
  // Thresholds only mean something for a check that reports a number.
  numeric: boolean;
}

export function rowsOf(providers: ProviderState[]): RuleRow[] {
  return providers.flatMap((p) =>
    p.results.map((r) => ({
      key: `${p.id}/${r.id}`,
      provider: p.label,
      label: r.label,
      numeric: typeof r.value === "number",
    }))
  );
}

export function parseRules(value: unknown): Rules {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Rules) : {};
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// Sets or clears one field of one rule, dropping a rule left with no fields.
export function withField<K extends keyof CheckRule>(
  rules: Rules,
  key: string,
  field: K,
  value: CheckRule[K] | undefined
): Rules {
  const rule: CheckRule = { ...rules[key] };
  if (value === undefined) delete rule[field];
  else rule[field] = value;
  const next = { ...rules };
  if (Object.keys(rule).length) next[key] = rule;
  else delete next[key];
  return next;
}

export type Direction = "above" | "below";

export function directionOf(rule: CheckRule | undefined): Direction | undefined {
  if (rule?.warnBelow !== undefined || rule?.critBelow !== undefined) return "below";
  if (rule?.warnAbove !== undefined || rule?.critAbove !== undefined) return "above";
  return undefined;
}

// Moves a rule's thresholds to the other side, keeping their numbers.
export function withDirection(rules: Rules, key: string, direction: Direction): Rules {
  const rule = rules[key];
  if (!rule || directionOf(rule) === direction || directionOf(rule) === undefined) return rules;
  const { warnAbove, critAbove, warnBelow, critBelow, ...rest } = rule;
  const moved: CheckRule =
    direction === "below"
      ? { ...rest, ...defined({ warnBelow: warnAbove, critBelow: critAbove }) }
      : { ...rest, ...defined({ warnAbove: warnBelow, critAbove: critBelow }) };
  return { ...rules, [key]: moved };
}

function defined(fields: Partial<CheckRule>): Partial<CheckRule> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

const CAP_OPTIONS = [
  { value: "", label: "No cap" },
  { value: "warn", label: "Warning at most" },
  { value: "ok", label: "Always OK" },
];

function useProviders() {
  const [providers, setProviders] = useState<ProviderState[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    Promise.all(
      CATEGORIES.map((category) => apiRequest("GET /api/health/categories/:category", { params: { category } }))
    )
      .then((details) => live && setProviders(details.flatMap((d) => d.providers)))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, []);
  return { providers, error };
}

const numberOrUndefined = (value: string | number) => (typeof value === "number" ? value : undefined);

export function CheckRulesEditor({ setting, onSaved }: { setting: SettingView; onSaved: () => void }) {
  const { providers, error: loadError } = useProviders();
  const stored = useMemo(() => parseRules(setting.value), [setting.value]);
  const [draft, setDraft] = useState<Rules>(stored);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The side a row's thresholds apply to while it has none set yet.
  const [chosen, setChosen] = useState<Record<string, Direction>>({});
  useEffect(() => setDraft(stored), [stored]);

  const rows = useMemo(() => (providers ? rowsOf(providers) : []), [providers]);
  const shown = new Set(rows.map((r) => r.key));
  const others = Object.keys(draft).filter((key) => !shown.has(key));
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const locked = setting.locked === true;

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      // A JSON setting is sent as its JSON text; the server parses it against the schema.
      await apiRequest("PUT /api/admin/settings/:key", {
        params: { key: setting.key },
        body: { value: JSON.stringify(draft) },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof CheckRule>(key: string, field: K, value: CheckRule[K] | undefined) =>
    setDraft((rules) => withField(rules, key, field, value));

  return (
    <Stack gap="xs" data-setting={setting.key}>
      <Text size="sm" fw={500}>
        {setting.label}
      </Text>
      <Text size="xs" c="dimmed">
        Every check the board knows about. Thresholds apply to the number a check reports (latency in ms for HTTP
        checks, a count for most others); the cap limits how bad a check may look; switching one off hides it from the
        board.
      </Text>
      {loadError ? <Alert color="red">{loadError}</Alert> : null}
      {!providers && !loadError ? <Loader size="sm" /> : null}
      {providers && rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          No checks are reporting yet.
        </Text>
      ) : null}
      {rows.length > 0 ? (
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing={4} fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Check</Table.Th>
                <Table.Th>Thresholds on the value</Table.Th>
                <Table.Th>Warn at</Table.Th>
                <Table.Th>Critical at</Table.Th>
                <Table.Th>Cap</Table.Th>
                <Table.Th>On</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => {
                const rule = draft[row.key] ?? {};
                const direction = directionOf(rule) ?? chosen[row.key] ?? "above";
                return (
                  <Table.Tr key={row.key} data-rule={row.key}>
                    <Table.Td>
                      <Text size="sm">{row.label}</Text>
                      <Text size="xs" c="dimmed">
                        {row.provider}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {row.numeric ? (
                        <Select
                          size="xs"
                          w={100}
                          aria-label={`${row.label} direction`}
                          data={[
                            { value: "above", label: "Above" },
                            { value: "below", label: "Below" },
                          ]}
                          value={direction}
                          allowDeselect={false}
                          disabled={locked}
                          onChange={(v) => {
                            const next: Direction = v === "below" ? "below" : "above";
                            setChosen((c) => ({ ...c, [row.key]: next }));
                            setDraft((rules) => withDirection(rules, row.key, next));
                          }}
                        />
                      ) : (
                        <Text size="xs" c="dimmed">
                          not numeric
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {row.numeric ? (
                        <NumberInput
                          size="xs"
                          w={100}
                          aria-label={`${row.label} warn at`}
                          value={(direction === "below" ? rule.warnBelow : rule.warnAbove) ?? ""}
                          disabled={locked}
                          onChange={(v) =>
                            set(row.key, direction === "below" ? "warnBelow" : "warnAbove", numberOrUndefined(v))
                          }
                        />
                      ) : null}
                    </Table.Td>
                    <Table.Td>
                      {row.numeric ? (
                        <NumberInput
                          size="xs"
                          w={100}
                          aria-label={`${row.label} critical at`}
                          value={(direction === "below" ? rule.critBelow : rule.critAbove) ?? ""}
                          disabled={locked}
                          onChange={(v) =>
                            set(row.key, direction === "below" ? "critBelow" : "critAbove", numberOrUndefined(v))
                          }
                        />
                      ) : null}
                    </Table.Td>
                    <Table.Td>
                      <Select
                        size="xs"
                        w={150}
                        aria-label={`${row.label} cap`}
                        data={CAP_OPTIONS}
                        value={rule.maxStatus ?? ""}
                        allowDeselect={false}
                        disabled={locked}
                        onChange={(v) => set(row.key, "maxStatus", v === "ok" || v === "warn" ? v : undefined)}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Switch
                        aria-label={`${row.label} on`}
                        checked={!rule.disabled}
                        disabled={locked}
                        onChange={(e) => set(row.key, "disabled", e.currentTarget.checked ? undefined : true)}
                      />
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : null}
      <SettingNotes setting={setting} />
      {providers && others.length ? (
        <Text size="xs" c="dimmed">
          Also kept: {others.length === 1 ? "a rule" : `${others.length} rules`} for checks not reporting now (
          {others.join(", ")}).
        </Text>
      ) : null}
      {error ? (
        <Text size="xs" c="red">
          {error}
        </Text>
      ) : null}
      {dirty && !locked ? (
        <Group gap="xs">
          <Button size="xs" onClick={() => void save()} loading={busy}>
            Save
          </Button>
          <Button size="xs" variant="subtle" onClick={() => setDraft(stored)} disabled={busy}>
            Cancel
          </Button>
        </Group>
      ) : null}
    </Stack>
  );
}
