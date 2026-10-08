import { randomBytes } from "node:crypto";
import type { CatalogEntry, CatalogInput, DiscoveryReport } from "../../contracts/catalog.js";
import type { DeployMode, DeployPlan, DeployRequest, DeployValue, PlannedObject } from "../../contracts/deploy.js";
import { pickVersion } from "../../contracts/kubeversion.js";
import { recipes, VALUES_DIR, type Defaults, type RecipeInput, type Step } from "./apps.js";
import { ingressFor, manifestParts } from "./manifest.js";
import { toYaml, type YamlValue } from "./yaml.js";

export const MASK = "********";
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)+$/;
const SIZE = /^[1-9][0-9]{0,5}(Mi|Gi|Ti)$/;
const MAX_TEXT = 4096;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export const HELM_TIMEOUT = "10m";

export interface PlanInput {
  entry: CatalogEntry;
  request: DeployRequest;
  enabled: boolean;
  // Apps an earlier step of the same bundle installs first.
  installedBefore?: readonly string[];
  defaults: Defaults;
  discovery?: DiscoveryReport;
  discoveryError?: string;
  // false: the target namespace does not exist yet; undefined: not known.
  namespaceExists?: boolean;
  jobNamespace: string;
  jobName: string;
  valuesSecret: string;
}

export interface Rendered {
  plan: DeployPlan;
  // Files for the values Secret, real values. Empty for a blocked plan.
  files: Record<string, string>;
  steps: Step[];
  // Every secret value the run carries, typed or generated, for redaction.
  secrets: string[];
}

export const valuesSecretName = (release: string) => `deploy-${release}-values`;
export const jobName = (release: string, seq: number) => `deploy-${release}-${seq}`.slice(0, 63).replace(/-+$/, "");

function check(input: CatalogInput, raw: unknown): { value?: DeployValue; error?: string } {
  if (input.kind === "boolean") {
    if (raw === undefined || raw === "") return { value: input.default === true };
    if (typeof raw === "boolean") return { value: raw };
    if (raw === "true" || raw === "false") return { value: raw === "true" };
    return { error: "must be true or false" };
  }
  if (raw === undefined || raw === null || raw === "") {
    return input.required ? { error: "required" } : { value: "" };
  }
  if (typeof raw !== "string") return { error: "must be text" };
  const value = input.kind === "hostname" ? raw.trim().toLowerCase() : raw.trim();
  if (value.length > MAX_TEXT) return { error: `must be at most ${MAX_TEXT} characters` };
  if (CONTROL.test(value)) return { error: "must be a single line" };
  switch (input.kind) {
    case "hostname":
      return HOSTNAME.test(value) ? { value } : { error: "must be a hostname like app.example.com" };
    case "size":
      return SIZE.test(value) ? { value } : { error: "must be a size like 10Gi" };
    case "select":
      return input.options?.some((option) => option.value === value)
        ? { value }
        : { error: `must be one of ${(input.options ?? []).map((o) => o.value).join(", ")}` };
    default:
      return { value: input.kind === "secret" ? raw : value };
  }
}

function resolveInputs(
  entry: CatalogEntry,
  given: Record<string, unknown>,
  defaults: Defaults
): { values: Record<string, DeployValue>; errors: Record<string, string> } {
  const values: Record<string, DeployValue> = {};
  const errors: Record<string, string> = {};
  for (const input of entry.inputs) {
    let raw = given[input.key];
    if (raw === undefined || raw === "") {
      if (input.default !== undefined) raw = input.default;
      else if (input.kind === "hostname" && defaults.baseDomain) raw = `${entry.id}.${defaults.baseDomain}`;
    }
    const { value, error } = check(input, raw);
    if (error) errors[input.key] = error;
    values[input.key] = value ?? (typeof raw === "string" || typeof raw === "boolean" ? raw : "");
  }
  for (const key of Object.keys(given)) {
    if (!entry.inputs.some((input) => input.key === key)) errors[key] = `not an input of ${entry.name}`;
  }
  const extra = recipes[entry.id]?.validate?.(values) ?? {};
  for (const [key, error] of Object.entries(extra)) errors[key] ??= error;
  return { values, errors };
}

function masked(entry: CatalogEntry, values: Record<string, DeployValue>): Record<string, DeployValue> {
  const out: Record<string, DeployValue> = {};
  for (const input of entry.inputs) {
    const value = values[input.key] ?? "";
    out[input.key] = input.kind === "secret" && value !== "" ? MASK : value;
  }
  return out;
}

// Single-quoted for display only; the Job gets argv through job.ts.
export function display(argv: string[]): string {
  return argv.map((arg) => (/^[A-Za-z0-9_./=:@,+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(" ");
}

function mainSteps(entry: CatalogEntry, version: string, release: string, namespace: string, mode: DeployMode): Step[] {
  const install = entry.install;
  if (install.kind === "helm") {
    const oci = install.repo.startsWith("oci://");
    return [
      {
        argv: [
          "helm",
          "upgrade",
          "--install",
          release,
          oci ? `${install.repo.replace(/\/+$/, "")}/${install.chart}` : install.chart,
          ...(oci ? [] : ["--repo", install.repo]),
          "--version",
          version,
          "--namespace",
          namespace,
          "--create-namespace",
          "--values",
          `${VALUES_DIR}/values.yaml`,
          ...(mode === "install" ? ["--wait", "--timeout", HELM_TIMEOUT] : []),
        ],
        dryRun: "--dry-run=server",
      },
    ];
  }
  return [];
}

function prepare(steps: Step[], mode: DeployMode): { steps: Step[]; skipped: Step[] } {
  if (mode === "install") return { steps, skipped: [] };
  return {
    steps: steps.filter((step) => step.dryRun).map((step) => ({ ...step, argv: [...step.argv, step.dryRun!] })),
    skipped: steps.filter((step) => !step.dryRun),
  };
}

const secretValue = () => randomBytes(24).toString("base64url");

// The preview and, for an allowed plan, everything the Job needs. Renders
// twice: once masked for the preview, once with the real values for the
// values Secret.
export function render(input: PlanInput, mode: DeployMode, generate: () => string = secretValue): Rendered {
  const { entry, request } = input;
  const release = entry.id;
  const manifest = entry.install.kind === "manifest";
  const asked = request.namespace?.trim();
  // A manifest names its own namespaces.
  const namespace = manifest ? entry.namespace : asked || entry.namespace;
  const recipe = recipes[entry.id];
  const given = request.inputs && typeof request.inputs === "object" ? request.inputs : {};
  const { values, errors } = resolveInputs(entry, given as Record<string, unknown>, input.defaults);
  if (!DNS_LABEL.test(namespace)) errors.namespace ??= "must be a lowercase DNS label";
  if (manifest && asked && asked !== entry.namespace)
    errors.namespace ??= `${entry.name} installs into ${entry.namespace}`;

  const host = typeof values.host === "string" && values.host ? values.host : undefined;
  const access = input.defaults.access ?? "direct";
  // Behind a tunnel or on a tailnet the edge serves HTTPS; locally there is
  // no public name for Let's Encrypt to check.
  const tls = entry.exposesUi && access === "direct" && Boolean(input.defaults.clusterIssuer);
  const scheme = access === "cloudflare-tunnel" || access === "tailscale" || tls ? "https" : "http";
  const url = entry.exposesUi && host ? `${scheme}://${host}` : undefined;
  const tailscaleIngress = access === "tailscale" && entry.exposesUi && entry.install.kind === "helm";

  const generatedReal = new Map<string, string>();
  const recipeInput = (real: boolean): RecipeInput => ({
    app: entry,
    release,
    namespace,
    inputs: real ? values : masked(entry, values),
    host,
    tls,
    scheme,
    chartIngress: !tailscaleIngress,
    defaults: input.defaults,
    discovery: input.discovery,
    generated: (name) => {
      if (!real) return MASK;
      if (!generatedReal.has(name)) generatedReal.set(name, generate());
      return generatedReal.get(name)!;
    },
  });

  const shown = recipeInput(false);
  const warnings: string[] = [];
  if (input.discoveryError) {
    warnings.push(`Could not look at the cluster (${input.discoveryError}); requirements and defaults are unchecked.`);
  }

  const kubernetes = input.discovery?.kubernetesVersion;
  const picked = entry.install.kind === "patch" ? undefined : pickVersion(entry.install, kubernetes);
  const version = entry.install.kind === "patch" ? "" : picked?.ok ? picked.version : entry.install.version;
  if (picked?.ok && picked.fellBack && entry.install.kind !== "patch") {
    warnings.push(
      `Installs ${entry.name} ${version}, the newest version that supports Kubernetes ${kubernetes}; ${entry.install.version} needs ${entry.install.kubeVersion}.`
    );
  }

  const detected = (appId: string) => input.discovery?.apps.find((app) => app.appId === appId);
  const before = new Set(input.installedBefore ?? []);
  const missingRequires = entry.requires.filter((id) => !before.has(id) && detected(id)?.state === "not-installed");
  for (const id of entry.requires) {
    if (!before.has(id) && detected(id)?.state === "unknown")
      warnings.push(`Could not tell whether ${id} is installed; it is needed first.`);
  }
  const self = detected(entry.id);
  const alreadyThere = entry.install.kind !== "patch" && self?.state === "installed" && !self.ownedByUs;

  const parts = manifestParts(entry, shown);
  const service = tailscaleIngress ? recipe?.service?.(shown) : undefined;
  if (tailscaleIngress && !service) parts.error ??= `There is no Tailscale template for ${entry.name} yet.`;
  const supported =
    entry.install.kind === "helm"
      ? recipe?.values !== undefined && parts.error === undefined
      : entry.install.kind === "patch"
        ? recipe?.patch !== undefined
        : parts.error === undefined;

  if (entry.exposesUi && access !== "tailscale" && !input.defaults.ingressClass) {
    warnings.push("No ingress class found: the app installs but is unreachable from outside until one exists.");
  }
  if (entry.exposesUi && access === "direct" && !tls) {
    warnings.push("No cert-manager ClusterIssuer found, so it will be served over plain HTTP.");
  }
  if (entry.exposesUi && host && access === "cloudflare-tunnel") {
    warnings.push(
      `Reachable once the tunnel routes ${host} (or *.${host.split(".").slice(1).join(".")}); see Setup > Access.`
    );
  }
  if (entry.exposesUi && host && access === "local") {
    warnings.push(`Reachable once ${host} points at your ingress in a hosts file or local DNS; see Setup > Access.`);
  }
  if (self?.state === "installed" && self.ownedByUs && entry.install.kind !== "patch") {
    warnings.push("Installed here before: this runs the same install again over it.");
  }
  if (supported) warnings.push(...(recipe?.warnings?.(shown) ?? []));

  const all = supported
    ? [
        ...(entry.install.kind === "patch"
          ? recipe!.patch!(shown)
          : manifest
            ? parts.steps
            : mainSteps(entry, version, release, namespace, mode)),
        ...(tailscaleIngress
          ? [{ argv: ["kubectl", "apply", "-f", `${VALUES_DIR}/tailscale-ingress.yaml`], dryRun: "--dry-run=client" }]
          : []),
        ...(recipe?.after?.(shown) ?? []),
      ]
    : [];
  const { steps: shownSteps, skipped } = prepare(all, mode);
  if (skipped.length > 0) {
    warnings.push(
      `A dry run skips what depends on the install itself: ${skipped.map((s) => display(s.argv)).join("; ")}.`
    );
  }
  if (entry.install.kind === "helm") {
    warnings.push("Cancelling stops the Job; whatever Helm has already applied stays.");
  }

  const firstError = Object.entries(errors)[0];
  const blockedBy = !input.enabled
    ? "Deploys are turned off for this install."
    : !supported
      ? (parts.error ?? `There is no install template for ${entry.name} yet.`)
      : picked && !picked.ok
        ? `${entry.name}: ${picked.reason}`
        : firstError
          ? `${firstError[0]}: ${firstError[1]}`
          : missingRequires.length > 0
            ? `Needs ${missingRequires.join(", ")} installed first.`
            : alreadyThere
              ? `${entry.name} is already installed (${self!.evidence}).`
              : undefined;

  const valuesShown =
    entry.install.kind === "helm" && supported
      ? toYaml(recipe!.values!(shown)) + (service ? `---\n${toYaml(ingressFor(shown, service))}` : "")
      : entry.install.kind === "patch" && supported
        ? Object.values(recipe!.files?.(shown) ?? {})
            .map((file) => toYaml(file))
            .join("---\n")
        : manifest && supported
          ? Object.values(parts.files)
              .map((file) => toYaml(file))
              .join("---\n")
          : "";

  const creates: PlannedObject[] = [
    ...(entry.install.kind === "helm" && input.namespaceExists !== true
      ? [{ kind: "Namespace", name: namespace }]
      : []),
    { kind: "Secret", name: input.valuesSecret, namespace: input.jobNamespace },
    { kind: "Job", name: input.jobName, namespace: input.jobNamespace },
  ];

  const plan: DeployPlan = {
    appId: entry.id,
    release,
    namespace,
    version,
    allowed: blockedBy === undefined,
    ...(blockedBy ? { blockedBy } : {}),
    missingRequires,
    inputs: masked(entry, values),
    inputErrors: errors,
    commands: shownSteps.map((step) => display(step.argv)),
    values: valuesShown,
    creates,
    ...(url ? { url } : {}),
    warnings,
  };

  if (blockedBy !== undefined) return { plan, files: {}, steps: [], secrets: [] };

  const real = recipeInput(true);
  const files: Record<string, string> = {};
  if (entry.install.kind === "helm") files["values.yaml"] = toYaml(recipe!.values!(real) as YamlValue);
  if (service) files["tailscale-ingress.yaml"] = toYaml(ingressFor(real, service));
  for (const [file, content] of Object.entries(recipe?.files?.(real) ?? {})) files[file] = toYaml(content);
  if (manifest) {
    const realParts = manifestParts(entry, real);
    Object.assign(files, realParts.raw);
    for (const [file, content] of Object.entries(realParts.files)) files[file] = toYaml(content);
  }
  if (Object.keys(files).length === 0) files["values.yaml"] = "{}\n";

  const secrets = [
    ...entry.inputs.filter((i) => i.kind === "secret").map((i) => values[i.key]),
    ...generatedReal.values(),
  ].filter((value): value is string => typeof value === "string" && value !== "");

  return { plan, files, steps: shownSteps, secrets };
}
