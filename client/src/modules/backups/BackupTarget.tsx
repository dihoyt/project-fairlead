import { Alert, Group, Text } from "@mantine/core";
import { useApi } from "../../ui";
import { DeployButton } from "../../ui/deploy";

// Longhorn keeps snapshots on the same disks as the volume until a target
// exists, so nothing survives losing the node or the cluster.
export function LonghornBackupTarget({ onSet }: { onSet?: () => void }) {
  const longhorn = useApi("GET /api/catalog/apps/:id", { params: { id: "longhorn" } });
  const target = useApi("GET /api/catalog/apps/:id", { params: { id: "longhorn-backup-target" } });
  if (longhorn.data?.detected.state !== "installed" || target.data?.detected.state !== "not-installed") return null;
  return (
    <Alert color="orange" variant="light" title="Set a Longhorn backup target">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <Text size="sm" maw={640}>
          Longhorn has nowhere to send backups, so its recurring backups fail and every volume it holds is only as safe
          as the disks it sits on. Point it at an NFS share or an S3 bucket that every node can reach.
        </Text>
        <DeployButton
          appId="longhorn-backup-target"
          label="Set backup target"
          onDeployed={() => {
            target.reload();
            onSet?.();
          }}
        />
      </Group>
    </Alert>
  );
}
