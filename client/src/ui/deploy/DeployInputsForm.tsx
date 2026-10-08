import { PasswordInput, Select, Stack, Switch, TextInput } from "@mantine/core";
import type { CatalogInput } from "@contracts/catalog";
import type { DeployValue } from "@contracts/deploy";

export interface DeployInputsFormProps {
  inputs: CatalogInput[];
  values: Record<string, DeployValue>;
  // Field errors by input key, from the plan.
  errors?: Record<string, string>;
  onChange: (key: string, value: DeployValue) => void;
  disabled?: boolean;
}

export function DeployInputsForm({ inputs, values, errors = {}, onChange, disabled }: DeployInputsFormProps) {
  return (
    <Stack gap="sm">
      {inputs.map((input) => {
        const common = {
          label: input.label,
          description: input.help,
          required: input.required,
          error: errors[input.key],
          disabled,
        };
        const value = values[input.key];
        switch (input.kind) {
          case "boolean":
            return (
              <Switch
                key={input.key}
                label={input.label}
                description={input.help}
                error={errors[input.key]}
                disabled={disabled}
                checked={value === true}
                onChange={(e) => onChange(input.key, e.currentTarget.checked)}
              />
            );
          case "select":
            return (
              <Select
                key={input.key}
                {...common}
                data={input.options ?? []}
                value={typeof value === "string" && value !== "" ? value : null}
                onChange={(next) => onChange(input.key, next ?? "")}
                allowDeselect={!input.required}
              />
            );
          case "secret":
            return (
              <PasswordInput
                key={input.key}
                {...common}
                autoComplete="new-password"
                value={typeof value === "string" ? value : ""}
                onChange={(e) => onChange(input.key, e.currentTarget.value)}
              />
            );
          default:
            return (
              <TextInput
                key={input.key}
                {...common}
                placeholder={input.kind === "size" ? "10Gi" : input.kind === "hostname" ? "app.example.com" : undefined}
                spellCheck={false}
                value={typeof value === "string" ? value : ""}
                onChange={(e) => onChange(input.key, e.currentTarget.value)}
              />
            );
        }
      })}
    </Stack>
  );
}
