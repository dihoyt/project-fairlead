import type { CheckResult, Status } from "../../contracts/health.js";
import type { AppGateView } from "../../contracts/deploy.js";
import type { ModuleContext } from "../../contracts/module.js";
import { errorMessage } from "../../runtime/log.js";
import type { Deployer } from "./runner.js";

const INTERVAL_MS = 60_000;

function check(app: AppGateView, noLogin: boolean, at: string): CheckResult {
  const where = app.hosts.join(", ") || "no host";
  const judged: Record<AppGateView["state"], { status: Status; detail: string }> = {
    gated: { status: "ok", detail: `${where}: behind the console's sign-in` },
    tailnet: { status: "ok", detail: `${where}: reachable on the tailnet only` },
    public:
      noLogin && app.mode !== "public"
        ? { status: "warn", detail: `${where}: public, and it has no sign-in of its own` }
        : { status: "ok", detail: `${where}: public${app.reason ? ` (${app.reason})` : " by choice"}` },
    open: {
      status: noLogin ? "crit" : "warn",
      detail: `${where}: anyone with the address can open it. ${app.reason ?? ""}`.trim(),
    },
  };
  const { status, detail } = judged[app.state];
  return {
    id: `gate.${app.appId}`,
    label: `${app.name} sign-in gate`,
    status,
    detail,
    ...(status !== "ok" ? { raw: app } : {}),
    observedAt: at,
  };
}

// The gate's own wiring: which hosts it may send people back to, and a
// health check per published app.
export function registerGate(ctx: ModuleContext, deployer: Deployer): void {
  if (ctx.services.has("gate")) {
    ctx.services.get("gate").allowHosts(async (host) => {
      const domain = deployer.access.get()?.baseDomain;
      if (domain && host.endsWith(`.${domain}`)) return true;
      const { discovery } = await deployer.discover();
      return discovery?.ingressHosts.some((h) => h.host === host) ?? false;
    });
  }

  ctx.health.addProvider({
    id: "deploy.gate",
    category: "access",
    label: "Sign-in gate",
    intervalMs: INTERVAL_MS,
    async collect() {
      const at = new Date().toISOString();
      try {
        const status = await deployer.gateStatus();
        const catalog = ctx.services.has("catalog") ? ctx.services.get("catalog") : undefined;
        return status.apps.map((app) => check(app, catalog?.get(app.appId)?.noLogin === true, at));
      } catch (err) {
        return [
          {
            id: "gate",
            label: "Sign-in gate",
            status: "unknown",
            detail: `Could not judge the deployed apps: ${errorMessage(err)}`,
            observedAt: at,
          },
        ];
      }
    },
  });
}
