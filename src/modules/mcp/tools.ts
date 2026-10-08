import { z } from "zod";
import type { ApiRoutes, RouteKey } from "../../contracts/api.js";
import type { CheckRequest, CheckView } from "../../contracts/checks.js";
import { CATEGORIES } from "../../contracts/health.js";
import type { McpToolName, McpTools } from "../../contracts/mcp.js";
import type { CallInput } from "../../contracts/module.js";
import { HttpError } from "../../runtime/http.js";

// Makes a contract route call as the MCP caller.
export type Caller = <K extends RouteKey>(key: K, input?: CallInput<K>) => Promise<ApiRoutes[K]["response"]>;

export interface ToolDef<N extends McpToolName> {
  // An object schema; the SDK lists it as the tool's JSON Schema and
  // validates arguments against it before run() sees them.
  input: z.ZodObject;
  run(call: Caller, input: McpTools[N]["input"]): Promise<McpTools[N]["result"]>;
}

const categoryArg = z.enum(CATEGORIES as unknown as [string, ...string[]]).describe("Health category.");
const namespaceArg = z.string().min(1).describe("Kubernetes namespace.");
const idArg = z.string().min(1);
const deployValues = z.record(z.string(), z.union([z.string(), z.boolean()]));

const checkFields = {
  label: z.string().min(1).describe("Name shown on the Checks page."),
  kind: z.enum(["http", "tcp"]),
  target: z.string().min(1).describe('http: a URL such as "https://app.example.com/health"; tcp: "host:port".'),
  intervalMs: z.number().int().positive().optional().describe("How often it runs, in milliseconds."),
  timeoutMs: z.number().int().positive().optional(),
  expectStatus: z.array(z.number().int().min(100).max(599)).optional().describe("http only. Default: any 2xx or 3xx."),
  bodyMatch: z.string().optional().describe("http only. Plain substring the body must contain."),
  authHeader: z.string().optional().describe('http only. Header that carries `secret`, e.g. "Authorization".'),
  secret: z.string().optional().describe("Write-only value for authHeader. Never returned."),
  insecureSkipVerify: z.boolean().optional().describe("https only. Accept an unverifiable certificate."),
  tlsWarnDays: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
};

const linkFields = {
  category: categoryArg,
  label: z.string().min(1).max(80),
  url: z.url({ protocol: /^https?$/ }).describe("http(s) URL of the tool's UI."),
};

const deployRequest = {
  appId: z.string().min(1).describe("Catalog app id, from list_catalog_apps."),
  namespace: z.string().optional().describe("Default: the catalog entry's namespace."),
  inputs: deployValues.describe("Values by the app's input key; secret inputs are never returned or logged."),
};

const bundleRequest = {
  bundleId: z.string().min(1),
  inputs: deployValues.describe("Shared inputs: baseDomain, adminEmail, adminPassword, storageClass."),
  apps: z.record(z.string(), deployValues).optional().describe("Per-app overrides: app id -> input key -> value."),
  include: z.array(z.string()).optional().describe("Optional items to roll out; default: the bundle's selected ones."),
};

const templateRequest = {
  templateId: z.string().min(1).describe('Template id from list_templates, or "custom" for your own image.'),
  name: z
    .string()
    .optional()
    .describe("Instance name: its namespace and hostname label. Default: the template id; required for custom."),
  host: z
    .string()
    .optional()
    .describe('Hostname for its Ingress. Default: "<name>.<base domain>"; "" for inside the cluster only.'),
  volumeSize: z.string().optional().describe('Volume size such as "5Gi", for a template that keeps data.'),
  storageClass: z.string().optional().describe("Default: the cluster's default storage class."),
  custom: z
    .object({
      image: z.string().min(1).describe('With a tag or digest, e.g. "ghcr.io/org/app:1.2.3".'),
      port: z.number().int().describe("Container port of its web page or API."),
      env: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
      volume: z.object({ size: z.string(), mountPath: z.string() }).optional(),
    })
    .optional()
    .describe("Required for the custom template, refused for the others."),
};

const removeRequest = {
  name: z.string().min(1).describe("The instance's name, from list_templates."),
  deleteVolumes: z
    .boolean()
    .optional()
    .describe("Also delete its namespace and volumes, and with them its data. Default false."),
};

const items = <T>(list: T[]) => ({ items: list });

// An empty expectStatus means any 2xx or 3xx; accepting one more code has to
// spell those out, or the check would fail once the target answers 200 again.
const USUAL_OK = [200, 204, 301, 302, 303, 307, 308];

// The HTTP status the last run failed or warned on, when that status is
// what made it fail and is not the target itself failing (5xx).
export function unexpectedStatus(check: CheckView): number | undefined {
  const last = check.last;
  if (check.kind !== "http" || !last || (last.status !== "warn" && last.status !== "crit")) return undefined;
  const code = (last.raw as { httpStatus?: unknown } | undefined)?.httpStatus;
  if (typeof code !== "number" || code < 100 || code >= 500) return undefined;
  const expected = check.expectStatus?.length ? check.expectStatus.includes(code) : code >= 200 && code < 400;
  return expected ? undefined : code;
}

// A check's current settings as a request, secret omitted so the stored one stays.
function requestOf(check: CheckView): CheckRequest {
  return {
    label: check.label,
    kind: check.kind,
    target: check.target,
    intervalMs: check.intervalMs,
    timeoutMs: check.timeoutMs,
    ...(check.expectStatus ? { expectStatus: check.expectStatus } : {}),
    ...(check.bodyMatch ? { bodyMatch: check.bodyMatch } : {}),
    ...(check.authHeader ? { authHeader: check.authHeader } : {}),
    insecureSkipVerify: check.insecureSkipVerify ?? false,
    tlsWarnDays: check.tlsWarnDays,
    enabled: check.enabled,
  };
}

async function checkById(call: Caller, checkId: string): Promise<CheckView> {
  const check = (await call("GET /api/checks")).find((c) => c.id === checkId);
  if (!check) throw new HttpError(404, `No check "${checkId}". list_checks shows the ids.`);
  return check;
}

export const TOOLS: { [N in McpToolName]: ToolDef<N> } = {
  get_health_board: { input: z.object({}), run: (call) => call("GET /api/health/board") },
  get_health_category: {
    input: z.object({ category: categoryArg }),
    run: (call, { category }) => call("GET /api/health/categories/:category", { params: { category } }),
  },
  list_nodes: { input: z.object({}), run: async (call) => items(await call("GET /api/metrics-k8s/nodes")) },
  list_namespaces: { input: z.object({}), run: async (call) => items(await call("GET /api/workloads/namespaces")) },
  list_workloads: {
    input: z.object({ namespace: namespaceArg }),
    run: async (call, { namespace }) =>
      items(await call("GET /api/workloads/namespaces/:namespace/workloads", { params: { namespace } })),
  },
  list_pods: {
    input: z.object({
      namespace: namespaceArg,
      workload: z.string().optional().describe("Only this workload's pods, by name."),
    }),
    run: async (call, { namespace, workload }) =>
      items(
        await call("GET /api/workloads/namespaces/:namespace/pods", {
          params: { namespace },
          query: workload ? { workload } : {},
        })
      ),
  },
  list_checks: { input: z.object({}), run: async (call) => items(await call("GET /api/checks")) },
  list_links: {
    input: z.object({ category: categoryArg.optional() }),
    run: async (call, { category }) =>
      items(await call("GET /api/health/links", { query: category ? { category } : {} })),
  },
  get_backup_posture: { input: z.object({}), run: (call) => call("GET /api/backups/posture") },
  list_catalog_apps: {
    input: z.object({ slot: z.string().optional().describe('Wizard slot, e.g. "links", "sign-in", "backups".') }),
    run: async (call, { slot }) => items(await call("GET /api/catalog/apps", { query: slot ? { slot } : {} })),
  },
  get_discovery: { input: z.object({}), run: (call) => call("GET /api/catalog/discovery") },
  list_deploy_jobs: {
    input: z.object({ appId: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }),
    run: async (call, { appId, limit }) =>
      items(
        await call("GET /api/deploy/jobs", {
          query: { ...(appId ? { appId } : {}), limit: String(limit ?? 20) },
        })
      ),
  },
  get_deploy_job_logs: {
    input: z.object({ id: idArg, tail: z.number().int().min(1).max(2000).optional() }),
    run: (call, { id, tail }) =>
      call("GET /api/deploy/jobs/:id/logs", { params: { id }, query: tail ? { tail: String(tail) } : {} }),
  },
  list_bundle_runs: { input: z.object({}), run: async (call) => items(await call("GET /api/deploy/bundles")) },
  list_hosts: { input: z.object({}), run: async (call) => items(await call("GET /api/hosts")) },
  list_templates: { input: z.object({}), run: (call) => call("GET /api/templates") },
  get_entra_signin: { input: z.object({}), run: (call) => call("GET /api/connector-entra/view") },
  list_entra_groups: {
    input: z.object({ search: z.string().optional().describe("Display name prefix.") }),
    run: async (call, { search }) =>
      items(await call("GET /api/connector-entra/groups", { query: search ? { search } : {} })),
  },

  create_check: { input: z.object(checkFields), run: (call, body) => call("POST /api/checks", { body }) },
  update_check: {
    input: z.object({ id: idArg, ...z.object(checkFields).partial().shape }),
    run: async (call, { id, ...changes }) => {
      const body = { ...requestOf(await checkById(call, id)), ...changes };
      return call("PUT /api/checks/:id", { params: { id }, body });
    },
  },
  delete_check: {
    input: z.object({ id: idArg }),
    run: (call, { id }) => call("DELETE /api/checks/:id", { params: { id } }),
  },
  run_check: {
    input: z.object({ id: idArg }),
    run: (call, { id }) => call("POST /api/checks/:id/run", { params: { id } }),
  },
  accept_check_status: {
    input: z.object({ id: idArg }),
    run: async (call, { id }) => {
      const check = await checkById(call, id);
      const code = unexpectedStatus(check);
      if (code === undefined) {
        throw new HttpError(409, "The check's last run did not fail or warn on an HTTP status below 500.");
      }
      const base = check.expectStatus?.length ? check.expectStatus : USUAL_OK;
      const expectStatus = [...new Set([...base, code])].toSorted((a, b) => a - b);
      await call("PUT /api/checks/:id", { params: { id }, body: { ...requestOf(check), expectStatus } });
      await call("POST /api/checks/:id/run", { params: { id } });
      return checkById(call, id);
    },
  },
  create_link: { input: z.object(linkFields), run: (call, body) => call("POST /api/health/links", { body }) },
  update_link: {
    input: z.object({ id: idArg, ...z.object(linkFields).partial().shape }),
    run: (call, { id, ...body }) => call("PUT /api/health/links/:id", { params: { id }, body }),
  },
  delete_link: {
    input: z.object({ id: idArg }),
    run: (call, { id }) => call("DELETE /api/health/links/:id", { params: { id } }),
  },
  plan_app_deploy: { input: z.object(deployRequest), run: (call, body) => call("POST /api/deploy/plan", { body }) },
  deploy_app: {
    input: z.object({
      ...deployRequest,
      mode: z.enum(["install", "dry-run"]).describe("dry-run renders the manifests and changes nothing."),
    }),
    run: (call, body) => call("POST /api/deploy/jobs", { body }),
  },
  plan_bundle: { input: z.object(bundleRequest), run: (call, body) => call("POST /api/deploy/bundles/plan", { body }) },
  start_bundle: { input: z.object(bundleRequest), run: (call, body) => call("POST /api/deploy/bundles", { body }) },
  plan_template_deploy: {
    input: z.object(templateRequest),
    run: (call, body) => call("POST /api/templates/plan", { body }),
  },
  deploy_template: {
    input: z.object({
      ...templateRequest,
      mode: z.enum(["install", "dry-run"]).describe("dry-run renders the manifests and changes nothing."),
    }),
    run: (call, body) => call("POST /api/templates/jobs", { body }),
  },
  plan_template_removal: {
    input: z.object(removeRequest),
    run: (call, { name, deleteVolumes }) =>
      call("POST /api/deploy/actions/plan", {
        body: { kind: "remove-app", appId: name, deleteVolumes: deleteVolumes ?? false },
      }),
  },
  remove_template_app: {
    input: z.object(removeRequest),
    run: (call, { name, deleteVolumes }) =>
      call("POST /api/deploy/actions/run", {
        body: { kind: "remove-app", appId: name, deleteVolumes: deleteVolumes ?? false },
      }),
  },
  setup_entra_signin: {
    input: z.object({
      adminGroups: z
        .array(z.string().min(1))
        .optional()
        .describe("Entra group object ids (not names) whose members are admins; list_entra_groups finds them."),
      label: z.string().max(80).optional().describe('Sign-in button text. Default "Sign in with Microsoft".'),
    }),
    run: (call, body) => call("POST /api/connector-entra/signin", { body }),
  },
};
