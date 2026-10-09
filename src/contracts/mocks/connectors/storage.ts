import type { StorageCredentialsSecret, StorageTargetService, StorageTargetView } from "../../connectors.js";
import { mockStorageTargets } from "./views.js";

export interface MockStorageTargets extends StorageTargetService {
  // What list() and get() answer; edit it to change them.
  targets: StorageTargetView[];
  // Every credentialsSecret() call, in order.
  secretCalls: Array<{ id: string; namespace: string }>;
}

// Mock credential values, the same for every target, so a test can assert
// they reach a job's values and never a response.
export const MOCK_STORAGE_SECRET_VALUE = "mock-secret-value";

// Services "storage-targets" for module tests (backups, longhorn, deploy):
// the NFS, S3 and SMB mock targets. credentialsSecret answers in Longhorn's
// keys, undefined for nfs, and rejects for an unknown id.
export function createMockStorageTargets(targets: StorageTargetView[] = mockStorageTargets): MockStorageTargets {
  const mock: MockStorageTargets = {
    targets: structuredClone(targets),
    secretCalls: [],
    list: async () => structuredClone(mock.targets).toSorted((a, b) => a.name.localeCompare(b.name)),
    get: async (id) => {
      const found = mock.targets.find((t) => t.id === id);
      return found && structuredClone(found);
    },
    async credentialsSecret(id, namespace) {
      mock.secretCalls.push({ id, namespace });
      const target = mock.targets.find((t) => t.id === id);
      if (!target) throw new Error(`No storage target "${id}".`);
      if (target.protocol === "nfs") return undefined;
      if (!target.hasCredentials) throw new Error(`Storage target "${target.name}" has no stored credential.`);
      const stringData: Record<string, string> =
        target.protocol === "s3"
          ? {
              AWS_ACCESS_KEY_ID: "AKIAMOCKMOCKMOCK0001",
              AWS_SECRET_ACCESS_KEY: MOCK_STORAGE_SECRET_VALUE,
              ...(target.endpoint ? { AWS_ENDPOINTS: target.endpoint } : {}),
            }
          : { CIFS_USERNAME: "backup", CIFS_PASSWORD: MOCK_STORAGE_SECRET_VALUE };
      const secret: StorageCredentialsSecret = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: `test-backup-${id}`, namespace, labels: { "app.kubernetes.io/managed-by": "test" } },
        type: "Opaque",
        stringData,
      };
      return secret;
    },
  };
  return mock;
}
