import { useState } from "react";
import { Alert, Anchor, Button, Group, PasswordInput, Select, Stack, Text, TextInput } from "@mantine/core";
import {
  STORAGE_TARGET_KIND,
  type ConnectorField,
  type ConnectorKindView,
  type ConnectorTestResult,
  type ConnectorView,
} from "@contracts/connectors";
import { CheckList } from "../../ui/CheckList";
import { apiRequest } from "../../ui/api";
import { HostPicker } from "./HostPicker";

interface Props {
  kind: ConnectorKindView;
  // Editing: secret fields left empty keep the stored value.
  existing?: ConnectorView;
  onSaved: (view: ConnectorView) => void;
  onCancel?: () => void;
}

export function ConnectorForm({ kind, existing, onSaved, onCancel }: Props) {
  const [name, setName] = useState(existing?.name ?? kind.label);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      kind.fields.map((f) => [
        f.key,
        f.type === "secret"
          ? ""
          : (existing?.config[f.key] ?? (f.type === "select" ? (f.options?.[0]?.value ?? "") : "")),
      ])
    )
  );
  const [result, setResult] = useState<ConnectorTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);

  const shown = (f: ConnectorField) => !f.showWhen || f.showWhen.values.includes(values[f.showWhen.key] ?? "");
  const fields = kind.fields.filter(shown);
  // Hidden fields go as "", so a field left over from another choice isn't saved.
  const sent = Object.fromEntries(kind.fields.map((f) => [f.key, shown(f) ? (values[f.key] ?? "") : ""]));
  const missing = fields.some(
    (f) => f.required && !values[f.key]?.trim() && !(f.type === "secret" && existing?.secrets[f.key])
  );
  const set = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }));

  async function run(what: "test" | "save") {
    setBusy(what);
    setError(null);
    try {
      if (what === "test") {
        setResult(
          await apiRequest("POST /api/connectors/test", {
            body: { kind: kind.kind, values: sent, ...(existing ? { id: existing.id } : {}) },
          })
        );
      } else {
        onSaved(
          existing
            ? await apiRequest("PUT /api/connectors/:id", { params: { id: existing.id }, body: { name, values: sent } })
            : await apiRequest("POST /api/connectors", { body: { kind: kind.kind, name, values: sent } })
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Stack gap="sm" data-connector-form={kind.kind}>
      <Text size="sm">{kind.description}</Text>
      {kind.docsUrl ? (
        <Anchor href={kind.docsUrl} target="_blank" rel="noreferrer" size="sm">
          Create the credential in {kind.label}
        </Anchor>
      ) : null}
      <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
      {kind.kind === STORAGE_TARGET_KIND ? (
        <HostPicker
          protocol={values.protocol ?? ""}
          onPick={(changes) => setValues((prev) => ({ ...prev, ...changes }))}
        />
      ) : null}
      {fields.map((field) => {
        if (field.type === "select") {
          return (
            <Select
              key={field.key}
              label={field.label}
              description={field.help}
              data={field.options ?? []}
              value={values[field.key] ?? ""}
              onChange={(value) => set(field.key, value ?? "")}
              allowDeselect={false}
              required={field.required}
            />
          );
        }
        const common = {
          label: field.label,
          description: field.help,
          placeholder:
            field.type === "secret" && existing?.secrets[field.key] ? "Stored; leave empty to keep" : field.placeholder,
          required: field.required && !(field.type === "secret" && existing?.secrets[field.key]),
          value: values[field.key] ?? "",
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(field.key, e.currentTarget.value),
        };
        return field.type === "secret" ? (
          <PasswordInput key={field.key} autoComplete="off" {...common} />
        ) : (
          <TextInput key={field.key} {...common} />
        );
      })}
      {result ? (
        <Stack gap={4}>
          <Text size="sm" fw={500} c={result.ok ? "teal" : "red"}>
            {result.ok ? "Everything checks out" : "Not working yet"}
          </Text>
          <CheckList results={result.checks} />
        </Stack>
      ) : null}
      {error ? <Alert color="red">{error}</Alert> : null}
      <Group>
        <Button variant="default" onClick={() => void run("test")} loading={busy === "test"} disabled={missing}>
          Test
        </Button>
        <Button onClick={() => void run("save")} loading={busy === "save"} disabled={missing || !name.trim()}>
          {existing ? "Save" : "Add"}
        </Button>
        {onCancel ? (
          <Button variant="subtle" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}
