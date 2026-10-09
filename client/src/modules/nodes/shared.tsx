import { useState, type ReactNode } from "react";
import { Card, SegmentedControl, Stack, Text } from "@mantine/core";
import type { NodeSummary } from "@contracts/metrics";
import type { ChartRange, Status } from "../../ui";

export type NodeRange = Extract<ChartRange, "1h" | "24h" | "7d">;
const RANGES: NodeRange[] = ["1h", "24h", "7d"];
const STORAGE_KEY = "nodes.range";

function stored(): NodeRange {
  try {
    const value = window.sessionStorage.getItem(STORAGE_KEY);
    return RANGES.includes(value as NodeRange) ? (value as NodeRange) : "1h";
  } catch {
    return "1h";
  }
}

// Shared across the node pages so moving between them keeps the window.
export function useRange(): [NodeRange, (range: NodeRange) => void] {
  const [range, setRange] = useState<NodeRange>(stored);
  const set = (next: NodeRange) => {
    setRange(next);
    try {
      window.sessionStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage refused (private window): the choice lasts for this page only.
    }
  };
  return [range, set];
}

export function RangeControl({ value, onChange }: { value: NodeRange; onChange(range: NodeRange): void }) {
  return (
    <SegmentedControl
      size="xs"
      value={value}
      onChange={(next) => onChange(next as NodeRange)}
      data={RANGES}
      aria-label="Time range"
    />
  );
}

export function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card withBorder padding="md">
      <Stack gap="xs">
        <Text size="sm" fw={600}>
          {title}
        </Text>
        {children}
      </Stack>
    </Card>
  );
}

export const SOURCE_LABEL: Record<NodeSummary["source"], string> = {
  kubelet: "kubelet stats",
  "metrics-server": "metrics-server",
  none: "no usage data",
};

export function nodeStatus(node: NodeSummary): Status {
  if (!node.ready) return "crit";
  return node.source === "none" ? "unknown" : "ok";
}
