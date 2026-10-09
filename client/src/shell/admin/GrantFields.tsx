import { Chip, Group, SegmentedControl, Stack, TagsInput, Text } from "@mantine/core";
import { TOKEN_AREAS, TOKEN_AREA_LABELS, type TokenArea } from "@contracts/grants";
import { useApi } from "../../ui/api";

// A token's limits as the pickers hold them: null is every one.
export interface GrantLimits {
  namespaces: string[] | null;
  areas: TokenArea[] | null;
}

export const NO_LIMITS: GrantLimits = { namespaces: null, areas: null };

// Only the limits that are set, for a request body.
export function limitsBody(limits: GrantLimits): { namespaces?: string[]; areas?: TokenArea[] } {
  return {
    ...(limits.namespaces ? { namespaces: limits.namespaces } : {}),
    ...(limits.areas ? { areas: limits.areas } : {}),
  };
}

// Empty lists can't be sent, so the form says what is missing instead.
export function limitsProblem(limits: GrantLimits): string | null {
  if (limits.areas?.length === 0) return "Pick at least one area.";
  if (limits.namespaces?.length === 0) return "Name at least one namespace.";
  return null;
}

export function limitsSummary(limits: { namespaces?: string[]; areas?: TokenArea[] }): string {
  const areas = limits.areas ? limits.areas.map((area) => TOKEN_AREA_LABELS[area]).join(", ") : "All areas";
  const namespaces = limits.namespaces ? `namespaces ${limits.namespaces.join(", ")}` : "all namespaces";
  return `${areas}; ${namespaces}`;
}

export function GrantFields({ value, onChange }: { value: GrantLimits; onChange: (next: GrantLimits) => void }) {
  const namespaces = useApi("GET /api/workloads/namespaces", undefined, { enabled: value.namespaces !== null });
  return (
    <Stack gap="xs">
      <Group gap="sm" align="center">
        <Text size="sm" fw={500} w={96}>
          Areas
        </Text>
        <SegmentedControl
          size="xs"
          value={value.areas ? "some" : "all"}
          onChange={(mode) => onChange({ ...value, areas: mode === "all" ? null : [] })}
          data={[
            { value: "all", label: "All" },
            { value: "some", label: "Only some" },
          ]}
        />
      </Group>
      {value.areas ? (
        <Chip.Group
          multiple
          value={value.areas}
          onChange={(next) => onChange({ ...value, areas: next as TokenArea[] })}
        >
          <Group gap={6}>
            {TOKEN_AREAS.map((area) => (
              <Chip key={area} value={area} size="xs">
                {TOKEN_AREA_LABELS[area]}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      ) : null}
      <Group gap="sm" align="center">
        <Text size="sm" fw={500} w={96}>
          Namespaces
        </Text>
        <SegmentedControl
          size="xs"
          value={value.namespaces ? "some" : "all"}
          onChange={(mode) => onChange({ ...value, namespaces: mode === "all" ? null : [] })}
          data={[
            { value: "all", label: "All" },
            { value: "some", label: "Only some" },
          ]}
        />
      </Group>
      {value.namespaces ? (
        <>
          <TagsInput
            aria-label="Namespaces"
            placeholder="Pick or type a namespace"
            data={(namespaces.data ?? []).map((ns) => ns.name)}
            value={value.namespaces}
            onChange={(next) => onChange({ ...value, namespaces: next })}
            maw={520}
          />
          <Text size="xs" c="dimmed">
            Lists show only these namespaces. Anything cluster-wide (checks, nodes, bundles, connectors) can be read but
            not changed.
          </Text>
        </>
      ) : null}
    </Stack>
  );
}
