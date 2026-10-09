import { Select } from "@mantine/core";
import type { HostView } from "@contracts/hosts";
import { useApi } from "../../ui/api";

const bracket = (address: string) => (address.includes(":") ? `[${address}]` : address);

// What picking a host fills in for a storage target, by protocol: the
// server part of the URL (with the host's first backup path for NFS), or
// MinIO's usual endpoint for S3. The share, bucket and keys stay to type.
export function prefillFor(protocol: string, host: HostView): Record<string, string> {
  const server = bracket(host.address);
  switch (protocol) {
    case "s3":
      return { endpoint: `https://${server}:9000` };
    case "smb":
      return { url: `cifs://${server}/` };
    default:
      return { url: `nfs://${server}:${host.backupTargetPaths[0] ?? "/"}` };
  }
}

// "Pick a host": a machine already under Hosts (a NAS, usually) fills the
// server in. Shows nothing when there are no hosts.
export function HostPicker({
  protocol,
  onPick,
}: {
  protocol: string;
  onPick: (changes: Record<string, string>) => void;
}) {
  const hosts = useApi("GET /api/hosts");
  if (!hosts.data?.length) return null;
  return (
    <Select
      label="Pick a host"
      description="Fill the server in from a machine under Hosts."
      placeholder="A host"
      data={hosts.data.map((h) => ({ value: h.id, label: `${h.label} (${h.address})` }))}
      value={null}
      onChange={(id) => {
        const host = hosts.data?.find((h) => h.id === id);
        if (host) onPick(prefillFor(protocol, host));
      }}
      clearable={false}
    />
  );
}
