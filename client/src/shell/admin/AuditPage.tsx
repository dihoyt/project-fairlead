import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Paper, Table, Text } from "@mantine/core";
import type { AuditRow } from "@contracts/auth";
import { apiRequest } from "../../ui/api";
import { absoluteTime } from "../../ui/time";
import { PageHeader } from "../PageHeader";

const COLOR: Record<AuditRow["result"], string> = { ok: "teal", denied: "orange", error: "red" };
const PAGE = 100;

export function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pages by id: `before` is the oldest id already shown.
  const load = useCallback(async (before?: number) => {
    try {
      const page = await apiRequest("GET /api/admin/audit", {
        query: { limit: String(PAGE), before: before === undefined ? undefined : String(before) },
      });
      setRows((current) => (before === undefined ? page : [...current, ...page]));
      setMore(page.length === PAGE);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => void load(), [load]);

  return (
    <>
      <PageHeader title="Audit log" description="Sign-ins and every change made through the app." />
      {error ? <Alert color="red">{error}</Alert> : null}
      <Paper withBorder>
        <Table fz="xs" verticalSpacing={4} striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>When</Table.Th>
              <Table.Th>Who</Table.Th>
              <Table.Th>From</Table.Th>
              <Table.Th>What</Table.Th>
              <Table.Th>Result</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.id}>
                <Table.Td style={{ whiteSpace: "nowrap" }}>{absoluteTime(row.ts)}</Table.Td>
                <Table.Td>{row.username || "-"}</Table.Td>
                <Table.Td>{row.ip}</Table.Td>
                <Table.Td>
                  {row.action}
                  {row.target ? (
                    <Text span c="dimmed" size="xs">
                      {" "}
                      {row.target}
                    </Text>
                  ) : null}
                  {row.detail ? (
                    <Text size="xs" c="dimmed">
                      {row.detail}
                    </Text>
                  ) : null}
                </Table.Td>
                <Table.Td>
                  <Badge size="xs" color={COLOR[row.result]} variant="light">
                    {row.result}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {rows.length === 0 && !error ? (
          <Text size="sm" c="dimmed" p="md">
            Nothing recorded yet.
          </Text>
        ) : null}
      </Paper>
      {more ? (
        <Group justify="center" mt="sm">
          <Button size="xs" variant="subtle" onClick={() => void load(rows.at(-1)!.id)}>
            Older
          </Button>
        </Group>
      ) : null}
    </>
  );
}
