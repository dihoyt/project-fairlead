import type { KubeObject } from "../../contracts/k8s.js";
import { product } from "../../product.js";
import { VALUES_DIR, type Step } from "./apps.js";
import { display } from "./plan.js";

// Labels on the Job and its pod, beside ownedLabels() which create() adds.
export const JOB_LABEL = `${product.ownerMarker.labelDomain}/deploy-job`;
export const RELEASE_LABEL = `${product.ownerMarker.labelDomain}/deploy-release`;
export const CONTAINER = "deploy";

export const TTL_SECONDS = 86_400;
export const DEADLINE_SECONDS = 900;
const RETRIES = 6;
const RETRY_SLEEP = 10;

const quote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;

// The Job's whole program. Every argument is single-quoted, so nothing in
// it is interpreted by the shell; inputs only ever arrive as files.
export function script(steps: Step[]): string {
  const lines = ["set -eu"];
  for (const step of steps) {
    const command = step.argv.map(quote).join(" ");
    lines.push(`echo ${quote(`+ ${display(step.argv)}`)}`);
    if (step.retry) {
      lines.push(
        `n=0; until ${command}; do n=$((n+1)); [ "$n" -lt ${RETRIES} ] || exit 1; ` +
          `echo 'Not ready yet, retrying in ${RETRY_SLEEP}s'; sleep ${RETRY_SLEEP}; done`
      );
    } else {
      lines.push(command);
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface JobSpecInput {
  id: string;
  name: string;
  namespace: string;
  release: string;
  image: string;
  serviceAccount: string;
  valuesSecret: string;
  steps: Step[];
  // A whole program from code in place of steps, for an action that needs
  // more than a straight list (a rollback trap); inputs still only as files.
  script?: string;
  // Default DEADLINE_SECONDS.
  deadlineSeconds?: number;
  // Kept off this node: a drain would evict the Job's own pod, and a reboot
  // would end it.
  avoidNode?: string;
}

export function jobManifest(input: JobSpecInput): KubeObject {
  const labels = { [JOB_LABEL]: input.id, [RELEASE_LABEL]: input.release };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: input.name, namespace: input.namespace, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: TTL_SECONDS,
      activeDeadlineSeconds: input.deadlineSeconds ?? DEADLINE_SECONDS,
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: input.serviceAccount,
          restartPolicy: "Never",
          ...(input.avoidNode
            ? {
                affinity: {
                  nodeAffinity: {
                    requiredDuringSchedulingIgnoredDuringExecution: {
                      nodeSelectorTerms: [
                        {
                          matchExpressions: [
                            { key: "kubernetes.io/hostname", operator: "NotIn", values: [input.avoidNode] },
                          ],
                        },
                      ],
                    },
                  },
                },
              }
            : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: CONTAINER,
              image: input.image,
              command: ["/bin/sh", "-c", input.script ?? script(input.steps)],
              env: [
                { name: "HOME", value: "/tmp" },
                { name: "HELM_CACHE_HOME", value: "/tmp/.cache/helm" },
                { name: "HELM_CONFIG_HOME", value: "/tmp/.config/helm" },
                { name: "HELM_DATA_HOME", value: "/tmp/.local/share/helm" },
              ],
              workingDir: "/tmp",
              securityContext: {
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: { cpu: "50m", memory: "128Mi" },
                limits: { memory: "512Mi" },
              },
              volumeMounts: [
                { name: "values", mountPath: VALUES_DIR, readOnly: true },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            // 0444: the container runs as a user the Secret's files would
            // otherwise not be readable by.
            { name: "values", secret: { secretName: input.valuesSecret, defaultMode: 0o444 } },
            { name: "tmp", emptyDir: { sizeLimit: "256Mi" } },
          ],
        },
      },
    },
  };
}

// Owned by the Job, so it goes when the Job's TTL removes the Job.
export function valuesSecret(
  input: { name: string; namespace: string; id: string; release: string },
  files: Record<string, string>,
  owner: KubeObject
): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: { [JOB_LABEL]: input.id, [RELEASE_LABEL]: input.release },
      ...(owner.metadata.uid
        ? {
            ownerReferences: [
              { apiVersion: "batch/v1", kind: "Job", name: owner.metadata.name, uid: owner.metadata.uid },
            ],
          }
        : {}),
    },
    type: "Opaque",
    stringData: files,
  };
}
