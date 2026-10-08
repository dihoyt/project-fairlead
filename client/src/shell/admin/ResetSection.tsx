import { useState } from "react";
import { Alert, Anchor, Button, Checkbox, Code, List, Paper, Stack, Text, TextInput, Title } from "@mantine/core";
import { Link } from "react-router";
import { RESET_CONFIRM_WORD, RESET_SCOPE_INFO, type ResetResult, type ResetScope } from "@contracts/reset";
import { apiRequest } from "../../ui/api";
import { forgetFirstRunCheck } from "../useFirstRun";

const LABELS = new Map(RESET_SCOPE_INFO.map((info) => [info.scope, info.label]));

export function ResetSection({ onDone }: { onDone: () => void }) {
  const [chosen, setChosen] = useState<ResetScope[]>(
    RESET_SCOPE_INFO.filter((info) => info.preselected).map((info) => info.scope)
  );
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResetResult | null>(null);

  const ready = chosen.length > 0 && confirm === RESET_CONFIRM_WORD && !busy;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await apiRequest("POST /api/system/reset", { body: { scopes: chosen, confirm } });
      if (done.wizardReopens) forgetFirstRunCheck();
      setResult(done);
      setConfirm("");
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper withBorder p="lg">
      <Stack gap="md">
        <Title order={4}>Reset to defaults</Title>
        <Text size="xs" c="dimmed">
          Clears the app&apos;s own configuration so you can start again without reinstalling. Apps already deployed
          into the cluster, the deploy history, and the cluster itself are not touched.
        </Text>
        <Checkbox.Group value={chosen} onChange={(value) => setChosen(value as ResetScope[])}>
          <Stack gap="xs">
            {RESET_SCOPE_INFO.map((info) => (
              <Checkbox key={info.scope} value={info.scope} label={info.label} description={info.help} />
            ))}
          </Stack>
        </Checkbox.Group>
        <TextInput
          label={`Type ${RESET_CONFIRM_WORD} to confirm`}
          value={confirm}
          onChange={(e) => setConfirm(e.currentTarget.value)}
          maw={260}
        />
        {error ? <Alert color="red">{error}</Alert> : null}
        <div>
          <Button color="red" onClick={run} disabled={!ready} loading={busy}>
            Reset selected
          </Button>
        </div>
        {result ? (
          <Alert color="teal" title="Reset done">
            <List size="sm">
              {result.cleared.map((row) => (
                <List.Item key={row.scope}>
                  {LABELS.get(row.scope) ?? row.scope}: {row.cleared} cleared
                </List.Item>
              ))}
            </List>
            {result.temporaryPassword ? (
              <Text size="sm" mt="xs">
                Temporary password for <Code>admin</Code>, shown once: <Code>{result.temporaryPassword}</Code>
              </Text>
            ) : null}
            {result.wizardReopens ? (
              <Text size="sm" mt="xs">
                The first-run wizard opens on the next page load, or{" "}
                <Anchor component={Link} to="/welcome">
                  open it now
                </Anchor>
                .
              </Text>
            ) : null}
          </Alert>
        ) : null}
      </Stack>
    </Paper>
  );
}
