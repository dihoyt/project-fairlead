import type { CatalogEntry } from "../../../contracts/catalog.js";
import type { AppGateAction } from "../../../contracts/deploy.js";
import type { KubeObject } from "../../../contracts/k8s.js";
import type { Defaults } from "../apps.js";
import {
  annotateSteps,
  appIngresses,
  applyMiddlewareStep,
  CONSOLE_INGRESS,
  consoleWarning,
  gateManifests,
  middlewareName,
  middlewareRef,
  MIDDLEWARE_FILE,
  unavailable,
  type GateInput,
} from "../gate.js";
import { display } from "../plan.js";
import type { ActionContext, ActionRecipe, ActionRendered } from "./index.js";

// What the app-gate action needs beyond an ordinary action's context.
export interface GateActionContext {
  input: GateInput;
  defaults: Defaults;
  entry(appId: string): CatalogEntry | undefined;
  isPublic(appId: string): boolean;
  // Every Ingress in the cluster, or undefined when they can't be listed.
  ingresses(): Promise<KubeObject[] | undefined>;
  save(appId: string, isPublic: boolean, by: string): void;
}

export const gateAction: ActionRecipe<AppGateAction> = {
  kind: "app-gate",

  async render(request: AppGateAction, ctx: ActionContext): Promise<ActionRendered> {
    const g = ctx.gate;
    const entry = g?.entry(request.appId);
    const name = entry?.name ?? request.appId;
    const title = request.public ? `Make ${name} public` : `Put ${name} behind the console's sign-in`;
    const ours = ctx.releases.find((r) => r.appId === request.appId);
    const base = {
      appId: request.appId,
      release: ours?.release ?? request.appId,
      namespace: ours?.namespace ?? entry?.namespace ?? request.appId,
      version: ctx.versions.get(ours?.release ?? request.appId) ?? "",
    };
    const blocked = (blockedBy: string): ActionRendered => ({
      ...base,
      plan: { kind: "app-gate", title, allowed: false, blockedBy, steps: [], changes: [], creates: [], warnings: [] },
      steps: [],
      files: {},
    });

    if (!g) return blocked("The sign-in gate is not available in this build.");
    if (!entry || !ours) return blocked(`${name} was not deployed from here.`);
    if (!ctx.enabled) {
      return blocked(`Deploys are off.${ctx.enableHint ? ` Turn them on with: ${ctx.enableHint}` : ""}`);
    }
    if (entry.gate === "public") return blocked(`${name} has to be reachable without the console's sign-in.`);
    if (g.defaults.access === "tailscale") return blocked("Apps are reached over Tailscale; the tailnet is the gate.");
    if (!request.public) {
      const why = unavailable(g.defaults, g.input);
      if (why) return blocked(why);
    }
    const discovery = await ctx.discover();
    if (!discovery) return blocked("The cluster can't be read, so its Ingresses are unknown.");
    const ingresses = appIngresses(discovery.ingressHosts, entry.id, await g.ingresses());
    if (ingresses.length === 0) return blocked(`${name} has no Ingress to put the gate on.`);

    const credentials = entry.gate === "credentials";
    const ref = request.public ? undefined : middlewareRef(g.input.console.namespace, middlewareName(credentials));
    const annotate = annotateSteps(ingresses, ref);
    if (annotate.length === 0 && g.isPublic(entry.id) === request.public) {
      return blocked(request.public ? `${name} is already public.` : `${name} is already behind the sign-in.`);
    }
    const steps = [...(ref ? [applyMiddlewareStep()] : []), ...annotate];
    const files: Record<string, string> = ref
      ? { [MIDDLEWARE_FILE]: gateManifests(g.input, g.defaults, credentials) }
      : { "values.yaml": "{}\n" };
    const warnings =
      request.public && entry.noLogin
        ? [`${name} has no sign-in of its own: anyone with its address will be able to use it.`]
        : [];
    const consoleNote = ref ? consoleWarning(g.input) : undefined;
    if (consoleNote) warnings.push(consoleNote);
    const publishes = Boolean(ref && g.input.consoleHost?.publish);
    return {
      ...base,
      plan: {
        kind: "app-gate",
        title,
        allowed: true,
        steps: [
          ...(ref
            ? [
                {
                  label: publishes
                    ? `Point the sign-in gate at the console and publish the console at ${g.input.consoleHost!.host}`
                    : "Point the sign-in gate at the console",
                  commands: [display(applyMiddlewareStep().argv)],
                },
              ]
            : []),
          {
            label: request.public ? "Take the gate off its Ingresses" : "Put the gate on its Ingresses",
            commands: annotate.map((step) => display(step.argv)),
          },
        ],
        changes: ingresses.map((ing) => ({ kind: "Ingress", name: ing.name, namespace: ing.namespace })),
        creates: [
          ...(ref
            ? [{ kind: "Middleware", name: middlewareName(credentials), namespace: g.input.console.namespace }]
            : []),
          ...(publishes ? [{ kind: "Ingress", name: CONSOLE_INGRESS, namespace: g.input.console.namespace }] : []),
        ],
        warnings,
      },
      steps,
      files,
      onStarted: (job) => g.save(entry.id, request.public, job.startedBy),
    };
  },
};
