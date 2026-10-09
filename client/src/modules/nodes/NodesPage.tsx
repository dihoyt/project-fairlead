import { Alert, Loader, Stack } from "@mantine/core";
import { PageHeader } from "../../shell/PageHeader";
import { useApi, useSession } from "../../ui";
import { RaiseReplicas } from "../../ui/deploy";
import { AddNode } from "./AddNode";
import { NodeTable } from "./NodeTable";
import { DefaultStorageClass } from "./StorageClass";
import { RangeControl, useRange } from "./shared";

export function NodesPage() {
  const { me } = useSession();
  const [range, setRange] = useRange();
  const { data, error, loading } = useApi("GET /api/metrics-k8s/nodes", undefined, { pollMs: 30_000 });

  return (
    <Stack gap="md">
      <PageHeader
        title="Nodes"
        description="One row per node, from the node object and its kubelet. Click a row for its charts."
        actions={<RangeControl value={range} onChange={setRange} />}
      />
      <DefaultStorageClass />
      <RaiseReplicas />
      <AddNode canCreate={me.admin} />
      {error ? (
        <Alert color="red" title="Could not load nodes">
          {error}
        </Alert>
      ) : null}
      {loading && !data ? <Loader size="sm" /> : null}
      {data ? <NodeTable nodes={data} range={range} /> : null}
    </Stack>
  );
}
