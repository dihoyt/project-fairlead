// App templates: the starter library, instances in each state, plans that
// pass, fail on fields and fail the guardrail. Pure data, so the client can
// import it.
import type { CatalogEntry } from "../catalog.js";
import type { DeployActionPlan, DeployJobView, DeployPlan } from "../deploy.js";
import {
  CUSTOM_TEMPLATE,
  type AppTemplate,
  type TemplateInstance,
  type TemplatePlan,
  type TemplatesService,
  type TemplatesView,
} from "../templates.js";
import { mockDeployJob, mockFailedJob, mockRunningJob } from "./catalog.js";
import { HOUR, isoAgo } from "./time.js";

const MiB = 1024 ** 2;

export const mockTemplates: AppTemplate[] = [
  {
    id: "whoami",
    name: "whoami",
    summary: "A tiny web page that echoes back the request it got, for testing that routing and sign-in work.",
    homepage: "https://github.com/traefik/whoami",
    image: "docker.io/traefik/whoami",
    version: "v1.11.0",
    port: 80,
    disk: { volumeBytes: 0, imageBytes: 8 * MiB },
  },
  {
    id: "uptime-kuma",
    name: "Uptime Kuma",
    summary: "A status page and uptime monitor for websites and services, with alerts.",
    homepage: "https://github.com/louislam/uptime-kuma",
    image: "docker.io/louislam/uptime-kuma",
    version: "1.23.16",
    port: 3001,
    volume: { mountPath: "/app/data", size: "1Gi" },
    disk: { volumeBytes: 1024 * MiB, imageBytes: 450 * MiB },
  },
  {
    id: "it-tools",
    name: "IT-Tools",
    summary: "Handy tools for developers and admins in one web page: converters, generators, encoders.",
    homepage: "https://github.com/CorentinTh/it-tools",
    image: "docker.io/corentinth/it-tools",
    version: "2024.10.22-7ca5933",
    port: 80,
    disk: { volumeBytes: 0, imageBytes: 60 * MiB },
  },
  {
    id: CUSTOM_TEMPLATE,
    name: "Custom app",
    summary: "Any container image with a web page or API: give the image, its port and a hostname.",
    image: "",
    version: "",
    port: 0,
  },
];

const whoamiJob: DeployJobView = {
  ...mockDeployJob,
  id: "dj_10",
  appId: "whoami",
  release: "whoami",
  namespace: "whoami",
  version: "v1.11.0",
  message: "deployment.apps/whoami created",
  url: "https://whoami.example.test",
  job: { namespace: "console", name: "deploy-whoami-10" },
};

export const mockTemplateInstances: TemplateInstance[] = [
  {
    name: "my-api",
    templateId: CUSTOM_TEMPLATE,
    namespace: "my-api",
    version: "1.4.2",
    host: "",
    custom: {
      image: "ghcr.io/example/my-api:1.4.2",
      port: 8080,
      env: [{ name: "LOG_LEVEL", value: "info" }],
      volume: { size: "2Gi", mountPath: "/data" },
    },
    volumeSize: "2Gi",
    lastJob: {
      ...mockFailedJob,
      id: "dj_12",
      appId: "my-api",
      release: "my-api",
      namespace: "my-api",
      version: "1.4.2",
      message: 'Error: pods "my-api-7d9c" is forbidden: violates PodSecurity "baseline:latest"',
      job: { namespace: "console", name: "deploy-my-api-12" },
    },
    createdBy: "admin",
    createdAt: isoAgo(HOUR / 2),
    updatedAt: isoAgo(HOUR / 2),
  },
  {
    name: "status",
    templateId: "uptime-kuma",
    namespace: "status",
    version: "1.23.15",
    newerVersion: "1.23.16",
    host: "status.example.test",
    url: "https://status.example.test",
    volumeSize: "1Gi",
    storageClass: "longhorn",
    createdBy: "admin",
    createdAt: isoAgo(3 * HOUR),
    updatedAt: isoAgo(3 * HOUR),
  },
  {
    name: "whoami",
    templateId: "whoami",
    namespace: "whoami",
    version: "v1.11.0",
    host: "whoami.example.test",
    url: "https://whoami.example.test",
    lastJob: whoamiJob,
    createdBy: "admin",
    createdAt: isoAgo(HOUR),
    updatedAt: isoAgo(HOUR),
  },
];

export const mockTemplatesView: TemplatesView = { templates: mockTemplates, instances: mockTemplateInstances };

const whoamiManifest = `apiVersion: v1
kind: Namespace
metadata:
  name: whoami
  labels:
    app.kubernetes.io/managed-by: console
    console/deployed-by: deploy
    console/app-template: whoami
    pod-security.kubernetes.io/enforce: baseline
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: whoami
  namespace: whoami
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: whoami
  template:
    metadata:
      labels:
        app.kubernetes.io/name: whoami
    spec:
      containers:
        - name: whoami
          image: docker.io/traefik/whoami:v1.11.0
          ports:
            - containerPort: 80
          securityContext:
            allowPrivilegeEscalation: false
---
apiVersion: v1
kind: Service
metadata:
  name: whoami
  namespace: whoami
spec:
  selector:
    app.kubernetes.io/name: whoami
  ports:
    - port: 80
      targetPort: 80
`;

export const mockTemplateDeployPlan: DeployPlan = {
  appId: "whoami",
  release: "whoami",
  namespace: "whoami",
  version: "v1.11.0",
  allowed: true,
  missingRequires: [],
  inputs: { host: "whoami.example.test" },
  inputErrors: {},
  commands: [
    "kubectl apply -f /values/manifest.yaml --dry-run=client",
    "kubectl apply -f /values/ingress.yaml --dry-run=client",
  ],
  values: [
    "apiVersion: networking.k8s.io/v1",
    "kind: Ingress",
    "metadata:",
    "  name: whoami",
    "  namespace: whoami",
    "spec:",
    "  ingressClassName: traefik",
    "  rules:",
    "    - host: whoami.example.test",
    "",
  ].join("\n"),
  creates: [
    { kind: "Secret", name: "deploy-whoami-values", namespace: "console" },
    { kind: "Job", name: "deploy-whoami-11", namespace: "console" },
  ],
  url: "https://whoami.example.test",
  warnings: [],
};

export const mockTemplatePlan: TemplatePlan = {
  templateId: "whoami",
  name: "whoami",
  namespace: "whoami",
  allowed: true,
  fieldErrors: {},
  violations: [],
  manifests: whoamiManifest,
  deploy: mockTemplateDeployPlan,
};

// A custom app whose image has no tag: nothing is rendered.
export const mockTemplatePlanFieldErrors: TemplatePlan = {
  templateId: CUSTOM_TEMPLATE,
  name: "my-api",
  namespace: "my-api",
  allowed: false,
  blockedBy: "custom.image: needs a tag or digest, like nginx:1.27",
  fieldErrors: { "custom.image": "needs a tag or digest, like nginx:1.27" },
  violations: [],
  manifests: "",
};

// What the guardrail says about a manifest that mounts the node's disk.
export const mockTemplatePlanRefused: TemplatePlan = {
  ...mockTemplatePlan,
  allowed: false,
  blockedBy: "Deployment/whoami: mounts a directory of the node (hostPath).",
  violations: [
    {
      rule: "host-path",
      object: "Deployment/whoami",
      path: "spec.template.spec.volumes[0].hostPath",
      message: "Mounts a directory of the node (hostPath).",
    },
  ],
  deploy: { ...mockTemplateDeployPlan, allowed: true },
};

export const mockTemplateJob: DeployJobView = {
  ...whoamiJob,
  id: "dj_11",
  state: "running",
  finishedAt: undefined,
  message: undefined,
  job: { namespace: "console", name: "deploy-whoami-11" },
};

export const mockTemplateEntry: CatalogEntry = {
  id: "whoami",
  name: "whoami",
  summary: mockTemplates[0]!.summary,
  slots: [],
  homepage: "https://github.com/traefik/whoami",
  install: { kind: "manifest", bundled: whoamiManifest, version: "v1.11.0" },
  namespace: "whoami",
  requires: [],
  inputs: [{ key: "host", label: "Hostname", kind: "hostname", required: false }],
  exposesUi: true,
  prerequisites: [],
};

export function createMockTemplatesService(entries: CatalogEntry[] = [mockTemplateEntry]): TemplatesService {
  return { entries: () => structuredClone(entries) };
}

// Removing "status" (Uptime Kuma) with its volume kept, and the job for it.
export const mockTemplateRemovePlan: DeployActionPlan = {
  kind: "remove-app",
  title: "Remove status",
  allowed: true,
  steps: [
    {
      label: "Delete status's workloads, Services and Ingresses",
      commands: [
        "kubectl delete deployment,statefulset,service,ingress,configmap,secret,serviceaccount,role,rolebinding --all -n status",
      ],
    },
  ],
  downtime: "status stops for good.",
  rollback: "Deploy status again from Templates; its volume is still there.",
  changes: [],
  creates: [
    { kind: "Job", name: "deploy-status-14", namespace: "console" },
    { kind: "Secret", name: "deploy-status-values", namespace: "console" },
  ],
  deletes: [
    { kind: "Deployment", name: "status", namespace: "status" },
    { kind: "Service", name: "status", namespace: "status" },
    { kind: "Ingress", name: "status", namespace: "status" },
    { kind: "Check", name: "https://status.example.test" },
  ],
  warnings: ["The namespace status and its volume stay: deploying status from Templates again picks its data back up."],
  volumes: [{ namespace: "status", claim: "status-data", storageClass: "longhorn", size: "1Gi" }],
};

export const mockTemplateRemoveJob: DeployJobView = {
  ...mockRunningJob,
  id: "dj_14",
  appId: "status",
  release: "status",
  namespace: "status",
  version: "1.23.15",
  mode: "action",
  action: "remove-app",
  job: { namespace: "console", name: "deploy-status-14" },
};
