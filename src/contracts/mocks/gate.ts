import type { GateReadiness, GateService } from "../platform.js";

export interface MockGate extends GateService {
  // What readiness() answers.
  state: GateReadiness;
  checks: Array<(host: string) => boolean | Promise<boolean>>;
  // Whether any check added through allowHosts() allows the host.
  allows(host: string): Promise<boolean>;
}

// Services "gate" for module tests: ready, with a public URL.
export function createMockGate(state: Partial<GateReadiness> = {}): MockGate {
  const mock: MockGate = {
    state: { ready: true, signInUrl: "https://console.example.test", ...state },
    checks: [],
    readiness: () => structuredClone(mock.state),
    allowHosts(check) {
      mock.checks.push(check);
    },
    async allows(host) {
      for (const check of mock.checks) if (await check(host)) return true;
      return false;
    },
  };
  return mock;
}
