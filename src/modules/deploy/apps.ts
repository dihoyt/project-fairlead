import type { CatalogEntry, DiscoveryReport } from "../../contracts/catalog.js";
import type { DeployValue } from "../../contracts/deploy.js";
import { deployedLabel } from "../../contracts/deployed.js";
import type { YamlValue } from "./yaml.js";

export interface Defaults {
  baseDomain?: string;
  ingressClass?: string;
  clusterIssuer?: string;
  storageClass?: string;
}

// What a recipe renders from. In a preview every secret, typed or
// generated, is the mask; in a real run it is the value.
export interface RecipeInput {
  app: CatalogEntry;
  release: string;
  namespace: string;
  inputs: Record<string, DeployValue>;
  host?: string;
  // An Ingress gets a certificate only when there is an issuer to ask.
  tls: boolean;
  defaults: Defaults;
  discovery?: DiscoveryReport;
  // A random value generated per run (database passwords, signing keys).
  generated(name: string): string;
}

// One command of the Job's script. argv comes from the fixed templates in
// this file and in job.ts; inputs reach the Job only as files under /values.
export interface Step {
  argv: string[];
  // Appended in a dry run; steps without it are skipped then.
  dryRun?: string;
  // Re-run a few times: a webhook that came up with the release may not be
  // answering yet.
  retry?: boolean;
}

export interface Recipe {
  // Helm values, for "helm" installs.
  values?(r: RecipeInput): YamlValue;
  // Extra files written into the values Secret, by file name.
  files?(r: RecipeInput): Record<string, YamlValue>;
  // Run after the install itself.
  after?(r: RecipeInput): Step[];
  // The whole change, for "patch" installs.
  patch?(r: RecipeInput): Step[];
  warnings?(r: RecipeInput): string[];
  // Field errors beyond what the input's kind checks, by input key.
  validate?(inputs: Record<string, DeployValue>): Record<string, string>;
}

export const VALUES_DIR = "/values";
// Backup targets Longhorn accepts.
export const BACKUP_TARGET = /^(nfs|s3|cifs|azblob):\/\/\S+$/;
const str = (value: DeployValue | undefined) => (typeof value === "string" ? value : "");

const issuerAnnotations = (r: RecipeInput): Record<string, string> =>
  r.tls && r.defaults.clusterIssuer ? { "cert-manager.io/cluster-issuer": r.defaults.clusterIssuer } : {};

const tlsSecret = (r: RecipeInput) => `${r.release}-tls`;

// Charts with a labels key for every object get the deployed-by label, so
// discovery reports them as ours; the rest are matched through the deploy
// module's releases().
const labels = () => deployedLabel();

// Longhorn's default of 3 replicas leaves every volume degraded on fewer
// nodes. Unknown node count keeps the default.
const longhornReplicas = (r: RecipeInput) => {
  const nodes = r.discovery?.nodeDisks?.length;
  return nodes ? Math.min(3, nodes) : 3;
};
const storageClass = (r: RecipeInput) => r.defaults.storageClass || undefined;

function hasDefaultStorageClass(r: RecipeInput): boolean {
  const basic = r.discovery?.basics.find((b) => b.id === "default-storage-class");
  return !basic || basic.status !== "crit";
}

function hasDefaultIngressClass(r: RecipeInput): boolean {
  const basic = r.discovery?.basics.find((b) => b.id === "ingress-controller");
  return !basic || basic.status === "ok";
}

// Velero's AWS plugin, paired with the Velero release the catalog pins
// (plugin 1.14 for Velero 1.18; see Velero's compatibility matrix).
export const VELERO_AWS_PLUGIN = "velero/velero-plugin-for-aws:v1.14.4";

export const recipes: Record<string, Recipe> = {
  "cert-manager": {
    values: () => ({ crds: { enabled: true }, global: { commonLabels: labels() } }),
    files: (r) => {
      const email = str(r.inputs.acmeEmail);
      if (!email) return {};
      return {
        "issuer.yaml": {
          apiVersion: "cert-manager.io/v1",
          kind: "ClusterIssuer",
          metadata: { name: "letsencrypt-prod" },
          spec: {
            acme: {
              server: "https://acme-v02.api.letsencrypt.org/directory",
              email,
              privateKeySecretRef: { name: "letsencrypt-prod-account-key" },
              solvers: [
                {
                  http01: {
                    ingress: r.defaults.ingressClass ? { ingressClassName: r.defaults.ingressClass } : {},
                  },
                },
              ],
            },
          },
        },
      };
    },
    after: (r) =>
      str(r.inputs.acmeEmail) ? [{ argv: ["kubectl", "apply", "-f", `${VALUES_DIR}/issuer.yaml`], retry: true }] : [],
    warnings: (r) =>
      str(r.inputs.acmeEmail)
        ? []
        : ["No email given, so no Let's Encrypt issuer is created; apps get plain HTTP until one exists."],
  },

  traefik: {
    values: (r) => ({
      ingressClass: { enabled: true, isDefaultClass: !hasDefaultIngressClass(r) },
      commonLabels: labels(),
    }),
  },

  "metrics-server": {
    // Most kubelets serve a self-signed certificate (k3s, kubeadm defaults).
    values: () => ({ args: ["--kubelet-insecure-tls"], commonLabels: labels() }),
    warnings: () => ["metrics-server will not verify the kubelets' certificates (--kubelet-insecure-tls)."],
  },

  "local-path-provisioner": {
    after: (r) =>
      r.inputs.makeDefault === true
        ? [
            {
              argv: [
                "kubectl",
                "patch",
                "storageclass",
                "local-path",
                "--type",
                "merge",
                "-p",
                '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}',
              ],
            },
          ]
        : [],
    warnings: (r) =>
      r.inputs.makeDefault === true && hasDefaultStorageClass(r)
        ? ["The cluster already has a default storage class; marking local-path default too leaves two."]
        : [],
  },

  longhorn: {
    values: (r) => ({
      commonLabels: labels(),
      defaultSettings: { defaultReplicaCount: longhornReplicas(r) },
      persistence: { defaultClass: !hasDefaultStorageClass(r), defaultClassReplicaCount: longhornReplicas(r) },
      ingress: {
        enabled: true,
        ingressClassName: r.defaults.ingressClass,
        host: r.host,
        tls: r.tls,
        tlsSecret: r.tls ? tlsSecret(r) : undefined,
        annotations: issuerAnnotations(r),
      },
    }),
    warnings: (r) => {
      const replicas = longhornReplicas(r);
      return [
        "Longhorn's UI has no sign-in of its own: anyone who can reach the hostname can use it.",
        ...(replicas === 1
          ? ["1 replica on a single node; raise it in Longhorn when you add nodes."]
          : replicas < 3
            ? [`${replicas} replicas on ${replicas} nodes; raise it in Longhorn when you add nodes.`]
            : []),
      ];
    },
  },

  rancher: {
    values: (r) => ({
      hostname: r.host,
      bootstrapPassword: str(r.inputs.bootstrapPassword),
      replicas: 1,
      ingress: {
        ingressClassName: r.defaults.ingressClass,
        extraAnnotations: issuerAnnotations(r),
        // "secret": the issuer annotation has cert-manager fill
        // tls-rancher-ingress. Without an issuer Rancher signs its own.
        tls: { source: r.tls ? "secret" : "rancher" },
      },
    }),
  },

  headlamp: {
    values: (r) => ({
      ingress: {
        enabled: true,
        ingressClassName: r.defaults.ingressClass,
        annotations: issuerAnnotations(r),
        hosts: [{ host: r.host, paths: [{ path: "/", type: "Prefix" }] }],
        tls: r.tls ? [{ hosts: [r.host], secretName: tlsSecret(r) }] : [],
      },
    }),
  },

  gitea: {
    values: (r) => ({
      ingress: {
        enabled: true,
        className: r.defaults.ingressClass,
        annotations: issuerAnnotations(r),
        hosts: [{ host: r.host, paths: [{ path: "/", pathType: "Prefix" }] }],
        tls: r.tls ? [{ hosts: [r.host], secretName: tlsSecret(r) }] : [],
      },
      gitea: {
        admin: { username: str(r.inputs.adminUser), password: str(r.inputs.adminPassword) },
        // SQLite and in-process queues: the chart's HA Postgres and Valkey
        // clusters are far more than a first Git server needs.
        config: {
          server: { DOMAIN: r.host, ROOT_URL: `${r.tls ? "https" : "http"}://${r.host}/` },
          database: { DB_TYPE: "sqlite3" },
          session: { PROVIDER: "memory" },
          cache: { ADAPTER: "memory" },
          queue: { TYPE: "level" },
        },
      },
      persistence: { enabled: true, size: r.app.storage, storageClass: storageClass(r) },
      "postgresql-ha": { enabled: false },
      postgresql: { enabled: false },
      "valkey-cluster": { enabled: false },
      valkey: { enabled: false },
    }),
  },

  grafana: {
    values: (r) => ({
      extraLabels: labels(),
      adminPassword: str(r.inputs.adminPassword),
      ingress: {
        enabled: true,
        ingressClassName: r.defaults.ingressClass,
        annotations: issuerAnnotations(r),
        hosts: [r.host],
        tls: r.tls ? [{ hosts: [r.host], secretName: tlsSecret(r) }] : [],
      },
      persistence: { enabled: true, size: r.app.storage, storageClassName: storageClass(r) },
    }),
  },

  authentik: {
    values: (r) => {
      const dbPassword = r.generated("postgresPassword");
      return {
        global: { env: [{ name: "AUTHENTIK_BOOTSTRAP_EMAIL", value: str(r.inputs.adminEmail) }] },
        authentik: { secret_key: r.generated("secretKey"), postgresql: { password: dbPassword } },
        postgresql: {
          enabled: true,
          auth: { password: dbPassword },
          primary: { persistence: { size: r.app.storage, storageClass: storageClass(r) } },
        },
        server: {
          ingress: {
            enabled: true,
            ingressClassName: r.defaults.ingressClass,
            annotations: issuerAnnotations(r),
            hosts: [r.host],
            tls: r.tls ? [{ hosts: [r.host], secretName: tlsSecret(r) }] : [],
          },
        },
      };
    },
    warnings: (r) => [
      `Finish setup at ${r.tls ? "https" : "http"}://${r.host ?? "<host>"}/if/flow/initial-setup/ to set the admin password.`,
    ],
  },

  velero: {
    values: (r) => {
      const s3Url = str(r.inputs.s3Url);
      return {
        initContainers: [
          {
            name: "velero-plugin-for-aws",
            image: VELERO_AWS_PLUGIN,
            imagePullPolicy: "IfNotPresent",
            volumeMounts: [{ mountPath: "/target", name: "plugins" }],
          },
        ],
        configuration: {
          backupStorageLocation: [
            {
              name: "default",
              provider: "aws",
              bucket: str(r.inputs.bucket),
              default: true,
              config: {
                region: str(r.inputs.region),
                s3Url: s3Url || undefined,
                s3ForcePathStyle: s3Url ? "true" : undefined,
              },
            },
          ],
          volumeSnapshotLocation: [],
          defaultVolumesToFsBackup: true,
        },
        credentials: {
          useSecret: true,
          secretContents: {
            cloud: [
              "[default]",
              `aws_access_key_id=${str(r.inputs.accessKeyId)}`,
              `aws_secret_access_key=${str(r.inputs.secretAccessKey)}`,
              "",
            ].join("\n"),
          },
        },
        snapshotsEnabled: false,
        deployNodeAgent: true,
        schedules: {
          daily: { schedule: "0 3 * * *", template: { ttl: "720h", includedNamespaces: ["*"] } },
        },
      };
    },
    validate: (inputs): Record<string, string> =>
      !str(inputs.s3Url) || /^https?:\/\/[^\s/]+/.test(str(inputs.s3Url))
        ? {}
        : { s3Url: "must be an http:// or https:// URL" },
    warnings: () => ["Backs up every namespace daily at 03:00, keeping 30 days, with volume data copied file by file."],
  },

  "longhorn-backup-target": {
    files: (r) => ({ "patch.yaml": { spec: { backupTargetURL: str(r.inputs.target) } } }),
    patch: () => [
      {
        argv: [
          "kubectl",
          "patch",
          "backuptargets.longhorn.io",
          "default",
          "--namespace",
          "longhorn-system",
          "--type",
          "merge",
          "--patch-file",
          `${VALUES_DIR}/patch.yaml`,
        ],
        dryRun: "--dry-run=server",
      },
    ],
    validate: (inputs): Record<string, string> =>
      BACKUP_TARGET.test(str(inputs.target))
        ? {}
        : { target: "must look like nfs://server:/export/path or s3://bucket@region/" },
    warnings: (r) =>
      str(r.inputs.target).startsWith("s3://")
        ? ["An S3 target also needs its credentials Secret; set it on the backup target in Longhorn's UI."]
        : [],
  },

  cloudflared: {
    values: (r) => ({ cloudflare: { tunnel_token: str(r.inputs.tunnelToken) } }),
  },

  "tailscale-operator": {
    values: (r) => ({ oauth: { clientId: str(r.inputs.clientId), clientSecret: str(r.inputs.clientSecret) } }),
  },
};
