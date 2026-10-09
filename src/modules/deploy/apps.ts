import type { CatalogEntry, DiscoveryReport } from "../../contracts/catalog.js";
import type { AccessMode, DeployValue } from "../../contracts/deploy.js";
import { deployedLabel } from "../../contracts/deployed.js";
import { MIDDLEWARES_ANNOTATION } from "./gate.js";
import type { YamlValue } from "./yaml.js";

export interface Defaults {
  baseDomain?: string;
  ingressClass?: string;
  clusterIssuer?: string;
  storageClass?: string;
  // How the apps are reached; unset reads as "direct".
  access?: AccessMode;
}

// What a recipe renders from. In a preview every secret, typed or
// generated, is the mask; in a real run it is the value.
export interface RecipeInput {
  app: CatalogEntry;
  release: string;
  namespace: string;
  inputs: Record<string, DeployValue>;
  host?: string;
  // An Ingress gets a certificate only when there is an issuer to ask and
  // the access mode leaves TLS to the cluster.
  tls: boolean;
  // What the app's own URL starts with: https behind a tunnel or tailnet
  // even though the Ingress itself carries no certificate.
  scheme: "http" | "https";
  // false with Tailscale: the deploy module writes the app's Ingress itself
  // from `service`, so the chart's own stays off.
  chartIngress: boolean;
  // Traefik middlewares every Ingress of the app carries: the sign-in gate
  // (./gate.ts) when it is gated.
  middlewares?: string[];
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
  // The Service the app's UI is on, for an Ingress written outside the chart.
  service?(r: RecipeInput): { name: string; port: number };
  // Field errors beyond what the input's kind checks, by input key.
  validate?(inputs: Record<string, DeployValue>): Record<string, string>;
}

export const VALUES_DIR = "/values";
const DNS_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
// Backup targets Longhorn accepts.
export const BACKUP_TARGET = /^(nfs|s3|cifs|azblob):\/\/\S+$/;
const str = (value: DeployValue | undefined) => (typeof value === "string" ? value : "");

export const ingressAnnotations = (r: RecipeInput): Record<string, string> => ({
  ...(r.tls && r.defaults.clusterIssuer ? { "cert-manager.io/cluster-issuer": r.defaults.clusterIssuer } : {}),
  ...(r.middlewares?.length ? { [MIDDLEWARES_ANNOTATION]: r.middlewares.join(",") } : {}),
});

const tlsSecret = (r: RecipeInput) => `${r.release}-tls`;

// Charts with a labels key for every object get the deployed-by label, so
// discovery reports them as ours; the rest are matched through the deploy
// module's releases().
const labels = () => deployedLabel();

// The chart runs cloudflare/cloudflared:latest unless given a tag.
export const CLOUDFLARED_TAG = "2026.10.0";

// Two replicas, or one on a single node, where a second copy on the same
// host buys nothing. Unknown node count keeps two.
const upToNodes = (r: RecipeInput, wanted: number) => {
  const nodes = r.discovery?.nodeDisks?.length;
  return nodes ? Math.min(wanted, nodes) : wanted;
};
// More replicas than nodes leaves every volume degraded. Users raise it in
// Longhorn as they add nodes.
const LONGHORN_REPLICAS = 2;
const longhornReplicas = (r: RecipeInput) => upToNodes(r, LONGHORN_REPLICAS);
const storageClass = (r: RecipeInput) => r.defaults.storageClass || undefined;

function hasDefaultStorageClass(r: RecipeInput): boolean {
  const basic = r.discovery?.basics.find((b) => b.id === "default-storage-class");
  return !basic || basic.status !== "crit";
}

// k3s ships local-path as the default class; replicated Longhorn takes the
// default over from it. Any other default was someone's choice and stays.
const NODE_LOCAL_CLASS = "local-path";
const DEFAULT_CLASS_ANNOTATION = "storageclass.kubernetes.io/is-default-class";

// The classes marked default now; undefined when discovery couldn't tell.
function defaultStorageClasses(r: RecipeInput): string[] | undefined {
  const basic = r.discovery?.basics.find((b) => b.id === "default-storage-class");
  if (!basic || basic.status === "unknown") return undefined;
  return basic.status === "crit" ? [] : basic.found;
}

function longhornTakesDefault(r: RecipeInput): boolean {
  const defaults = defaultStorageClasses(r);
  return defaults !== undefined && defaults.every((name) => name === NODE_LOCAL_CLASS || name === "longhorn");
}

const unsetDefault = (name: string): Step => ({
  argv: [
    "kubectl",
    "patch",
    "storageclass",
    name,
    "--type",
    "merge",
    "-p",
    `{"metadata":{"annotations":{"${DEFAULT_CLASS_ANNOTATION}":"false"}}}`,
  ],
  dryRun: "--dry-run=server",
});

// Behind a tunnel the edge terminates TLS and the tunnel reaches Traefik over
// plain http. Traefik trusts no X-Forwarded-* header by default, so it
// forwards X-Forwarded-Proto: http, and apps that build absolute URLs from
// the request (Authentik's API base) hand an https page http URLs the
// browser blocks as mixed content. A headers Middleware on the app's own
// router restores https without changing what the cluster's Traefik trusts.
function forwardedHttps(r: RecipeInput): { name: string; middleware: YamlValue } | undefined {
  if (!r.chartIngress || r.tls || r.scheme !== "https" || r.defaults.ingressClass !== "traefik") return undefined;
  const name = `${r.release}-forwarded-https`;
  return {
    name,
    middleware: {
      apiVersion: "traefik.io/v1alpha1",
      kind: "Middleware",
      metadata: { name, namespace: r.namespace, labels: labels() },
      spec: { headers: { customRequestHeaders: { "X-Forwarded-Proto": "https" } } },
    },
  };
}

function hasDefaultIngressClass(r: RecipeInput): boolean {
  const basic = r.discovery?.basics.find((b) => b.id === "ingress-controller");
  return !basic || basic.status === "ok";
}

// Velero's AWS plugin, paired with the Velero release the catalog pins
// (plugin 1.14 for Velero 1.18; see Velero's compatibility matrix).
export const VELERO_AWS_PLUGIN = "velero/velero-plugin-for-aws:v1.14.4";

// Requests close to what each app uses idle, so the scheduler sees a small
// box filling up; memory limits with headroom, so one app can't take the
// node. No CPU limits: throttling hurts more than it protects.
const resources = (cpu: string, memory: string, limit: string) => ({
  requests: { cpu, memory },
  limits: { memory: limit },
});

export const recipes: Record<string, Recipe> = {
  "cert-manager": {
    values: () => ({
      crds: { enabled: true },
      global: { commonLabels: labels() },
      resources: resources("10m", "48Mi", "256Mi"),
      webhook: { resources: resources("5m", "24Mi", "128Mi") },
      cainjector: { resources: resources("5m", "48Mi", "256Mi") },
    }),
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
      persistence: { defaultClass: longhornTakesDefault(r), defaultClassReplicaCount: longhornReplicas(r) },
      // Headless: the console sets Longhorn up, so its UI (no sign-in of its
      // own) is never published. An upgrade removes an Ingress an earlier
      // install made; the longhorn-frontend Service stays for port-forward.
      ingress: { enabled: false },
    }),
    after: (r) =>
      longhornTakesDefault(r) && defaultStorageClasses(r)!.includes(NODE_LOCAL_CLASS)
        ? [unsetDefault(NODE_LOCAL_CLASS)]
        : [],
    warnings: (r) => {
      const replicas = longhornReplicas(r);
      const defaults = defaultStorageClasses(r) ?? [];
      const others = defaults.filter((name) => name !== "longhorn");
      return [
        "Longhorn's own web UI is not published; set backups up on the Backups page.",
        ...(replicas === 1 ? ["1 replica on a single node; raise it in Longhorn when you add nodes."] : []),
        ...(longhornTakesDefault(r) && others.length > 0
          ? [
              `Longhorn becomes the default storage class in place of ${others.join(", ")}; volumes that already exist stay where they are.`,
            ]
          : []),
        ...(!longhornTakesDefault(r) && others.length > 0
          ? [`${others.join(", ")} stays the default storage class; apps that should use Longhorn must name it.`]
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
        enabled: r.chartIngress,
        ingressClassName: r.defaults.ingressClass,
        extraAnnotations: ingressAnnotations(r),
        // "secret": the issuer annotation has cert-manager fill
        // tls-rancher-ingress. Without an issuer Rancher signs its own.
        tls: { source: r.tls ? "secret" : "rancher" },
      },
    }),
    service: (r) => ({ name: r.release, port: 80 }),
  },

  headlamp: {
    values: (r) => ({
      ingress: {
        enabled: r.chartIngress,
        ingressClassName: r.defaults.ingressClass,
        annotations: ingressAnnotations(r),
        hosts: [{ host: r.host, paths: [{ path: "/", type: "Prefix" }] }],
        tls: r.tls ? [{ hosts: [r.host], secretName: tlsSecret(r) }] : [],
      },
    }),
    service: (r) => ({ name: r.release, port: 80 }),
  },

  gitea: {
    values: (r) => ({
      ingress: {
        enabled: r.chartIngress,
        className: r.defaults.ingressClass,
        annotations: ingressAnnotations(r),
        hosts: [{ host: r.host, paths: [{ path: "/", pathType: "Prefix" }] }],
        tls: r.tls ? [{ hosts: [r.host], secretName: tlsSecret(r) }] : [],
      },
      gitea: {
        admin: { username: str(r.inputs.adminUser), password: str(r.inputs.adminPassword) },
        // SQLite and in-process queues: the chart's HA Postgres and Valkey
        // clusters are far more than a first Git server needs.
        config: {
          server: { DOMAIN: r.host, ROOT_URL: `${r.scheme}://${r.host}/` },
          database: { DB_TYPE: "sqlite3" },
          session: { PROVIDER: "memory" },
          cache: { ADAPTER: "memory" },
          queue: { TYPE: "level" },
        },
      },
      persistence: { enabled: true, size: r.app.storage, storageClass: storageClass(r) },
      resources: resources("25m", "160Mi", "512Mi"),
      "postgresql-ha": { enabled: false },
      postgresql: { enabled: false },
      "valkey-cluster": { enabled: false },
      valkey: { enabled: false },
    }),
    service: (r) => ({ name: `${r.release}-http`, port: 3000 }),
  },

  grafana: {
    values: (r) => ({
      extraLabels: labels(),
      adminPassword: str(r.inputs.adminPassword),
      ingress: {
        enabled: r.chartIngress,
        ingressClassName: r.defaults.ingressClass,
        annotations: ingressAnnotations(r),
        hosts: [r.host],
        tls: r.tls ? [{ hosts: [r.host], secretName: tlsSecret(r) }] : [],
      },
      persistence: { enabled: true, size: r.app.storage, storageClassName: storageClass(r) },
    }),
    service: (r) => ({ name: r.release, port: 80 }),
  },

  authentik: {
    values: (r) => {
      const dbPassword = r.generated("postgresPassword");
      const password = str(r.inputs.adminPassword);
      const https = forwardedHttps(r);
      return {
        authentik: {
          secret_key: r.generated("secretKey"),
          postgresql: { password: dbPassword },
          // Read once, on first start: the bootstrap blueprint creates akadmin
          // with it and marks setup done, so /if/flow/initial-setup/ never shows.
          bootstrap_email: str(r.inputs.adminEmail),
          ...(password ? { bootstrap_password: password } : {}),
        },
        postgresql: {
          enabled: true,
          auth: { password: dbPassword },
          primary: {
            persistence: { size: r.app.storage, storageClass: storageClass(r) },
            resources: resources("25m", "96Mi", "512Mi"),
          },
        },
        // Idle, the server and worker each hold about half a GiB.
        worker: { resources: resources("50m", "448Mi", "1Gi") },
        server: {
          resources: resources("50m", "512Mi", "1Gi"),
          ingress: {
            enabled: r.chartIngress,
            ingressClassName: r.defaults.ingressClass,
            annotations: {
              ...ingressAnnotations(r),
              ...(https ? { [MIDDLEWARES_ANNOTATION]: `${r.namespace}-${https.name}@kubernetescrd` } : {}),
            },
            hosts: [r.host],
            tls: r.tls ? [{ hosts: [r.host], secretName: tlsSecret(r) }] : [],
          },
        },
        additionalObjects: https ? [https.middleware] : [],
      };
    },
    service: (r) => ({ name: `${r.release}-server`, port: 80 }),
    warnings: (r) =>
      str(r.inputs.adminPassword)
        ? [`Sign in at ${r.scheme}://${r.host ?? "<host>"} as akadmin with the admin password.`]
        : [`Finish setup at ${r.scheme}://${r.host ?? "<host>"}/if/flow/initial-setup/ to set the admin password.`],
  },

  "pocket-id": {
    values: (r) => ({
      // APP_URL is https://<host>: the chart assumes https, which passkeys need anyway.
      host: r.host,
      encryptionKey: r.generated("encryptionKey"),
      analyticsDisabled: true,
      // The Service and StatefulSet named after the release, whatever it is.
      fullnameOverride: r.release,
      pocketID: { resources: resources("10m", "32Mi", "256Mi") },
      persistence: { data: { enabled: true, size: r.app.storage, storageClass: storageClass(r) ?? "" } },
      ingress: {
        enabled: r.chartIngress,
        className: r.defaults.ingressClass ?? "",
        annotations: ingressAnnotations(r),
        host: r.host,
        paths: [{ path: "/", pathType: "Prefix" }],
        tls: r.tls ? [{ hosts: [r.host], secretName: tlsSecret(r) }] : [],
      },
    }),
    service: (r) => ({ name: r.release, port: 80 }),
    warnings: (r) => {
      const url = `https://${r.host ?? "<host>"}`;
      return [
        ...(r.scheme === "http"
          ? [`Pocket ID serves itself as ${url}; passkeys fail until that address has https.`]
          : []),
        `Register the first admin's passkey at ${url}/setup, then make an API key under Settings > Admin > API Keys to wire up sign-in.`,
      ];
    },
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

  // A TLS-only Ingress beside an app's own, for a host published straight to
  // the public address (Cloudflare connector, Direct exposure): cert-manager
  // issues its certificate and the controller serves it for the host. Kept
  // apart from the app's Ingress so a chart upgrade never undoes it.
  "direct-tls": {
    files: (r) => ({
      "ingress.yaml": {
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: {
          name: str(r.inputs.name),
          namespace: r.namespace,
          labels: labels(),
          annotations: {
            "cert-manager.io/cluster-issuer": str(r.inputs.issuer),
            ...(r.middlewares?.length ? { [MIDDLEWARES_ANNOTATION]: r.middlewares.join(",") } : {}),
          },
        },
        spec: {
          ...(str(r.inputs.ingressClass) ? { ingressClassName: str(r.inputs.ingressClass) } : {}),
          tls: [{ hosts: [str(r.inputs.domain)], secretName: `${str(r.inputs.name)}-tls` }],
          rules: [
            {
              host: str(r.inputs.domain),
              http: {
                paths: [
                  {
                    path: "/",
                    pathType: "Prefix",
                    backend: {
                      service: {
                        name: str(r.inputs.service),
                        port: /^\d+$/.test(str(r.inputs.port))
                          ? { number: Number(str(r.inputs.port)) }
                          : { name: str(r.inputs.port) },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    }),
    patch: (r) =>
      r.inputs.remove === true
        ? [{ argv: ["kubectl", "delete", "--ignore-not-found", "-f", `${VALUES_DIR}/ingress.yaml`] }]
        : [{ argv: ["kubectl", "apply", "-f", `${VALUES_DIR}/ingress.yaml`], dryRun: "--dry-run=server" }],
    validate: (inputs): Record<string, string> => {
      const errors: Record<string, string> = {};
      for (const key of ["name", "service", "issuer"]) {
        if (!DNS_NAME.test(str(inputs[key]))) errors[key] = "must be a lowercase DNS name";
      }
      if (str(inputs.ingressClass) && !DNS_NAME.test(str(inputs.ingressClass))) {
        errors.ingressClass = "must be a lowercase DNS name";
      }
      if (!/^(\d{1,5}|[a-z0-9-]{1,15})$/.test(str(inputs.port))) errors.port = "must be a port number or name";
      return errors;
    },
  },

  cloudflared: {
    // The chart runs two by default; each shows as a separate connector.
    values: (r) => ({
      cloudflare: { tunnel_token: str(r.inputs.tunnelToken) },
      image: { tag: CLOUDFLARED_TAG },
      replicaCount: upToNodes(r, 2),
      resources: resources("10m", "32Mi", "128Mi"),
    }),
  },

  "tailscale-operator": {
    values: (r) => ({ oauth: { clientId: str(r.inputs.clientId), clientSecret: str(r.inputs.clientSecret) } }),
  },
};
