import { ActionIcon, Code, CopyButton, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import type { DeployStatus } from "@contracts/deploy";

// Shown wherever a deploy would start while the chart has not granted the
// installer: what is off, why, and the one line that turns it on.
export function DeploysOff({ status }: { status: Pick<DeployStatus, "enableHint" | "namespace"> }) {
  return (
    <Stack gap="xs">
      <Text size="sm">
        Deploying apps from here is turned off. It needs an installer account with full rights over the cluster, which
        the chart only creates when you ask for it.
      </Text>
      {status.enableHint ? (
        <>
          <Text size="sm">Run this where you manage the release to turn it on:</Text>
          <Group gap="xs" wrap="nowrap" align="flex-start">
            <Code block style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {status.enableHint}
            </Code>
            <CopyButton value={status.enableHint}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? "Copied" : "Copy"}>
                  <ActionIcon variant="subtle" onClick={copy} aria-label="Copy command">
                    {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          </Group>
        </>
      ) : null}
      <Text size="xs" c="dimmed">
        Once it is on, anyone who can create Jobs in the {status.namespace} namespace can act as a cluster admin, so
        treat that namespace as the trust boundary.
      </Text>
    </Stack>
  );
}
