import { z } from "zod";
import {
  MAX_FORWARDED_PORTS,
  RESERVED_PORTS,
  traefikEntrypoint,
  type DeployedRelease,
  type ForwardedPort,
  type PortsView,
  type TraefikPortsAction,
  type WantedPort,
} from "../../contracts/deploy.js";
import { RESOURCES, type K8sApi, type KubeObject } from "../../contracts/k8s.js";
import type { SettingsRegistry } from "../../contracts/platform.js";
import { VALUES_DIR, type Step } from "./apps.js";
import { HELM_TIMEOUT } from "./plan.js";
import { toYaml } from "./yaml.js";
import type { ActionContext, ActionRecipe, ActionRendered } from "./actions/index.js";

const K3S_NAMESPACE = "kube-system";
const K3S_SERVICE = "traefik";
const TRAEFIK_APP = "traefik";
const ENTRYPOINT = /^(tcp|udp)-(\d{1,5})$/;
const MIN_PORT = 1024;

export interface PortsSetting {
  get(): string;
}

export function declarePorts(settings: SettingsRegistry): PortsSetting {
  return settings.declare({
    key: "deploy.forwardedPorts",
    label: "Forwarded ports",
    help:
      "Ports your router forwards to the cluster, for external services over TCP and UDP: " +
      '"25565-25575,27015". From 1024 up, at most 100 in all.',
    schema: z.string().trim().max(500),
    default: "",
    env: "DEPLOY_FORWARDED_PORTS",
  });
}

// "25565-25575, 27015" -> merged, ascending ranges, or why not.
export function parseRanges(text: string): { ranges: Array<{ from: number; to: number }>; error?: string } {
  const value = text.trim();
  if (!value) return { ranges: [] };
  const parsed: Array<{ from: number; to: number }> = [];
  for (const part of value.split(",")) {
    const m = /^\s*(\d{1,5})\s*(?:-\s*(\d{1,5})\s*)?$/.exec(part);
    if (!m) return { ranges: [], error: `"${part.trim()}" is not a port or a range like 25565-25575.` };
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from > to) return { ranges: [], error: `${from}-${to} runs backwards.` };
    if (from < MIN_PORT || to > 65_535) {
      return {
        ranges: [],
        error: `Forwarded ports must be from ${MIN_PORT} to 65535: lower ports would need Traefik to run with extra privileges.`,
      };
    }
    const reserved = RESERVED_PORTS.find((p) => p >= from && p <= to);
    if (reserved !== undefined) return { ranges: [], error: `${reserved} is one of Traefik's own ports.` };
    parsed.push({ from, to });
  }
  parsed.sort((a, b) => a.from - b.from);
  const ranges: Array<{ from: number; to: number }> = [];
  for (const r of parsed) {
    const last = ranges.at(-1);
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else ranges.push({ ...r });
  }
  const count = ranges.reduce((n, r) => n + r.to - r.from + 1, 0);
  if (count > MAX_FORWARDED_PORTS) {
    return { ranges: [], error: `That is ${count} ports; at most ${MAX_FORWARDED_PORTS} can be forwarded.` };
  }
  return { ranges };
}

interface ServiceObject extends KubeObject {
  spec?: { ports?: Array<{ name?: string; port?: number; protocol?: string }> };
  status?: { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } };
}

// The entrypoints this product's naming covers, as the Service exposes them.
export function openPorts(service: ServiceObject | undefined): ForwardedPort[] {
  const out: ForwardedPort[] = [];
  for (const p of service?.spec?.ports ?? []) {
    const m = ENTRYPOINT.exec(p.name ?? "");
    if (!m) continue;
    const protocol = m[1] as "tcp" | "udp";
    if ((p.protocol ?? "TCP").toLowerCase() !== protocol) continue;
    out.push({ port: Number(m[2]), protocol });
  }
  return out.toSorted((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
}

const isTraefikService = (s: ServiceObject) =>
  (s.spec?.ports ?? []).some((p) => p.name === "websecure" || p.name === "web");

export interface PortsDeps {
  setting: PortsSetting;
  k8s?: K8sApi;
  releases: readonly DeployedRelease[];
  wanted: readonly WantedPort[];
}

async function getService(k8s: K8sApi, name: string, namespace: string): Promise<ServiceObject | undefined> {
  try {
    const found = await k8s.get<ServiceObject>(RESOURCES.services, name, namespace);
    return found && found !== "absent" ? found : undefined;
  } catch {
    return undefined;
  }
}

async function findTraefik(
  k8s: K8sApi | undefined,
  releases: readonly DeployedRelease[]
): Promise<{ traefik?: PortsView["traefik"]; service?: ServiceObject; note?: string }> {
  if (!k8s) return { note: "The cluster can't be read from here." };
  const ours = releases.find((r) => r.appId === TRAEFIK_APP && r.state === "succeeded");
  if (ours) {
    let service: ServiceObject | undefined;
    try {
      const list = await k8s.list<ServiceObject>(RESOURCES.services, { namespace: ours.namespace });
      if (list !== "absent") service = list.find(isTraefikService);
    } catch {
      // Read below as not found.
    }
    if (service) {
      return {
        traefik: { kind: "release", namespace: ours.namespace, service: service.metadata.name, release: ours.release },
        service,
      };
    }
  }
  const k3s = await getService(k8s, K3S_SERVICE, K3S_NAMESPACE);
  if (k3s && isTraefikService(k3s)) {
    return { traefik: { kind: "k3s", namespace: K3S_NAMESPACE, service: K3S_SERVICE }, service: k3s };
  }
  return {
    note:
      "No Traefik this product can configure was found: k3s's own Traefik in kube-system, or the Traefik " +
      "deployed from here. External services over TCP and UDP need one of them.",
  };
}

const key = (p: ForwardedPort) => traefikEntrypoint(p);

export async function portsView(deps: PortsDeps): Promise<PortsView> {
  const range = deps.setting.get().trim();
  const { ranges, error } = parseRanges(range);
  const found = await findTraefik(deps.k8s, deps.releases);
  const open = openPorts(found.service);
  const wanted = deps.wanted.toSorted((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
  const outOfRange = wanted.filter((w) => !ranges.some((r) => w.port >= r.from && w.port <= r.to));
  const openKeys = new Set(open.map(key));
  const wantedKeys = new Set(wanted.map(key));
  const inSync = openKeys.size === wantedKeys.size && [...wantedKeys].every((k) => openKeys.has(k));
  const lb = found.service?.status?.loadBalancer?.ingress?.[0];
  const address = lb?.ip ?? lb?.hostname;
  return {
    range,
    ranges,
    ...(error ? { rangeError: error } : {}),
    ...(found.traefik ? { traefik: found.traefik } : {}),
    ...(found.note ? { traefikNote: found.note } : {}),
    open,
    wanted,
    outOfRange,
    inSync,
    ...(address ? { address } : {}),
  };
}

// Traefik chart values for one entrypoint, exposed on its Service at the
// same port.
export function entrypointValues(p: ForwardedPort): Record<string, string | number | Record<string, boolean>> {
  return { port: p.port, exposedPort: p.port, protocol: p.protocol.toUpperCase(), expose: { default: true } };
}

// Merges the change into k3s's HelmChartConfig, whatever else it holds:
// valuesContent is YAML, so yq turns it into JSON for jq and back. Server
// side apply takes ownership of valuesContent alone; k3s's helm controller
// then upgrades Traefik with it.
export const K3S_SCRIPT = `set -eu
P=/values/ports.json
command -v yq >/dev/null || { echo "yq is missing from the installer image"; exit 1; }
echo "+ Reading the HelmChartConfig kube-system/traefik"
kubectl get helmchartconfig traefik -n kube-system -o jsonpath='{.spec.valuesContent}' --ignore-not-found > /tmp/current.yaml
yq -o=json '.' /tmp/current.yaml > /tmp/current.json
[ -s /tmp/current.json ] && [ "$(cat /tmp/current.json)" != "null" ] || echo '{}' > /tmp/current.json
jq --slurpfile p "$P" '
  .ports = ((.ports // {}) + $p[0].add)
  | .ports |= with_entries(select(.key as $k | ($p[0].remove | index($k)) | not))
  | if (.ports | length) == 0 then del(.ports) else . end
' /tmp/current.json > /tmp/next.json
yq -p=json -o=yaml -P '.' /tmp/next.json > /tmp/next.yaml
echo "+ Applying the merged values"
jq -n --rawfile v /tmp/next.yaml \\
  '{apiVersion: "helm.cattle.io/v1", kind: "HelmChartConfig",
    metadata: {name: "traefik", namespace: "kube-system"}, spec: {valuesContent: $v}}' \\
  | kubectl apply --server-side --force-conflicts --field-manager=forwarded-ports -f -
echo "+ Waiting for Traefik to roll out with the new ports"
WANT=$(jq -r '[.add | keys[]] | sort | join(",")' "$P")
HAVE=""
for _ in $(seq 1 60); do
  HAVE=$(kubectl get service traefik -n kube-system -o json \\
    | jq -r '[.spec.ports[].name | select(test("^(tcp|udp)-[0-9]+$"))] | sort | join(",")')
  [ "$HAVE" = "$WANT" ] && break
  sleep 5
done
[ "$HAVE" = "$WANT" ] || { echo "Traefik's Service still exposes [$HAVE], expected [$WANT]"; exit 1; }
kubectl rollout status deployment/traefik -n kube-system --timeout=5m
echo "Traefik serves the forwarded ports."
`;

function blocked(base: Omit<ActionRendered, "plan" | "steps" | "files">, blockedBy: string): ActionRendered {
  return {
    ...base,
    plan: {
      kind: "traefik-ports",
      title: "Open forwarded ports on Traefik",
      allowed: false,
      blockedBy,
      steps: [],
      changes: [],
      creates: [],
      warnings: [],
    },
    steps: [],
    files: {},
  };
}

const describe = (ports: ForwardedPort[]) => ports.map((p) => `${p.protocol.toUpperCase()} ${p.port}`).join(", ");

export const portsAction: ActionRecipe<TraefikPortsAction> = {
  kind: "traefik-ports",

  async render(_request: TraefikPortsAction, ctx: ActionContext): Promise<ActionRendered> {
    const view = await ctx.call("GET /api/deploy/ports");
    const traefik = view.traefik;
    const base = {
      appId: TRAEFIK_APP,
      release: traefik?.kind === "release" ? traefik.release : "traefik",
      namespace: traefik?.namespace ?? K3S_NAMESPACE,
      version: (traefik?.kind === "release" && ctx.versions.get(traefik.release)) || "",
    };
    if (!traefik) return blocked(base, view.traefikNote ?? "No Traefik was found.");
    if (!ctx.enabled) {
      return blocked(base, `Deploys are off.${ctx.enableHint ? ` Turn them on with: ${ctx.enableHint}` : ""}`);
    }
    if (view.rangeError) return blocked(base, `Forwarded ports setting: ${view.rangeError}`);
    if (view.outOfRange.length > 0) {
      const w = view.outOfRange[0]!;
      return blocked(
        base,
        `${w.appId} asks for ${w.protocol.toUpperCase()} ${w.port}, outside the forwarded ports` +
          `${view.range ? ` (${view.range})` : ""}. Add it to the range in Admin > Settings, or change its public port.`
      );
    }
    if (view.inSync) return blocked(base, "Traefik already serves exactly the ports external services use.");

    const openKeys = new Set(view.open.map(key));
    const wantedKeys = new Set(view.wanted.map(key));
    const unique = new Map(view.wanted.map((w) => [key(w), { port: w.port, protocol: w.protocol }]));
    const add = [...unique.values()].filter((p) => !openKeys.has(key(p)));
    const remove = view.open.filter((p) => !wantedKeys.has(key(p)));
    const title =
      add.length > 0 && remove.length === 0
        ? `Open ${describe(add)} on Traefik`
        : add.length === 0
          ? `Close ${describe(remove)} on Traefik`
          : "Update forwarded ports on Traefik";

    const all = [...unique.values()];
    const labels: string[] = [
      ...(add.length ? [`Open ${describe(add)}`] : []),
      ...(remove.length ? [`Close ${describe(remove)}, which nothing uses any more`] : []),
    ];
    let steps: Step[] = [];
    let script: string | undefined;
    const files: Record<string, string> = {};
    let commands: string[];
    if (traefik.kind === "k3s") {
      files["ports.json"] = JSON.stringify({
        add: Object.fromEntries(all.map((p) => [key(p), entrypointValues(p)])),
        remove: remove.map(key),
      });
      script = K3S_SCRIPT;
      commands = [
        "kubectl get helmchartconfig traefik -n kube-system (merge the ports into its valuesContent)",
        "kubectl apply --server-side --field-manager=forwarded-ports -f - (HelmChartConfig kube-system/traefik)",
        "kubectl rollout status deployment/traefik -n kube-system",
      ];
    } else {
      const entry = ctx.catalog?.get(TRAEFIK_APP);
      const helm = entry?.install.kind === "helm" ? entry.install : undefined;
      if (!helm || !base.version) {
        return blocked(base, "The Traefik deployed from here has no recorded chart version to upgrade with.");
      }
      // Helm deletes a key whose new value is null, which is how a port closes.
      files["ports.yaml"] = toYaml({
        ports: {
          ...Object.fromEntries(add.map((p) => [key(p), entrypointValues(p)])),
          ...Object.fromEntries(remove.map((p) => [key(p), null])),
        },
      });
      const oci = helm.repo.startsWith("oci://");
      steps = [
        {
          argv: [
            "helm",
            "upgrade",
            base.release,
            oci ? `${helm.repo.replace(/\/+$/, "")}/${helm.chart}` : helm.chart,
            ...(oci ? [] : ["--repo", helm.repo]),
            "--version",
            base.version,
            "--namespace",
            base.namespace,
            "--reuse-values",
            "--values",
            `${VALUES_DIR}/ports.yaml`,
            "--wait",
            "--timeout",
            HELM_TIMEOUT,
          ],
        },
        { argv: ["echo", "Traefik serves the forwarded ports."] },
      ];
      commands = steps.map((s) => s.argv.join(" "));
    }

    const warnings = [
      "Traefik restarts once to pick up the ports; apps behind it are unreachable for a few seconds.",
      ...(traefik.kind === "k3s"
        ? [
            "k3s keeps these values in the HelmChartConfig kube-system/traefik; edit other values there as before, " +
              "the ports are merged in.",
          ]
        : []),
    ];
    return {
      ...base,
      plan: {
        kind: "traefik-ports",
        title,
        allowed: true,
        steps: labels.map((label, i) => ({ label, commands: i === 0 ? commands : [] })),
        downtime: "Traefik restarts once; every app behind it blips for a few seconds.",
        rollback: "If Traefik doesn't come back, run this again after fixing the forwarded ports or the app's port.",
        changes:
          traefik.kind === "k3s"
            ? [
                { kind: "HelmChartConfig", name: "traefik", namespace: K3S_NAMESPACE },
                { kind: "Service", name: traefik.service, namespace: traefik.namespace },
              ]
            : [{ kind: "HelmRelease", name: base.release, namespace: base.namespace }],
        creates: [],
        warnings,
      },
      steps,
      ...(script ? { script } : {}),
      files,
    };
  },
};
