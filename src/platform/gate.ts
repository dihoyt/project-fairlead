import type { GateReadiness, GateService } from "../contracts/platform.js";
import { publicOrigin, type Core } from "./core.js";

type HostCheck = (host: string) => boolean | Promise<boolean>;

export interface PlatformGate extends GateService {
  // Whether any module's check allows sending a signed-in person to host.
  allows(host: string): Promise<boolean>;
}

export function createGate(core: Pick<Core, "settings" | "log">): PlatformGate {
  const checks: HostCheck[] = [];
  return {
    readiness(): GateReadiness {
      const signInUrl = publicOrigin(core);
      return signInUrl
        ? { ready: true, signInUrl }
        : {
            ready: false,
            reason: "The console has no public URL to send people to sign in; set it in Admin > Settings.",
            signInUrl: "",
          };
    },
    allowHosts(check) {
      checks.push(check);
    },
    async allows(host) {
      for (const check of checks) {
        try {
          if (await check(host)) return true;
        } catch (err) {
          core.log.warn("A gate host check failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return false;
    },
  };
}
