import { Badge } from "@mantine/core";
import type { StatusBadgeProps } from "./contracts";
import { STATUS_COLOR, STATUS_LABEL } from "./status";

export function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <Badge
      color={STATUS_COLOR[status]}
      // Outline keeps "not installed" visibly quieter than "unknown".
      variant={status === "absent" ? "outline" : "light"}
      radius="xs"
      data-status={status}
    >
      {label ?? STATUS_LABEL[status]}
    </Badge>
  );
}
