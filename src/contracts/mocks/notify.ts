import type { EmailMessage, EntraMailService, EntraMailStatus } from "../notify.js";

export interface MockEntraMail extends EntraMailService {
  // What status() answers.
  state: EntraMailStatus;
  sent: Array<{ from: string; message: EmailMessage }>;
  // Set to make sendMail() reject with it, as Graph's refusal would.
  failWith?: Error;
}

// Services "entraMail" for module tests.
export function createMockEntraMail(state: Partial<EntraMailStatus> = {}): MockEntraMail {
  const mock: MockEntraMail = {
    state: { ready: true, tenantId: "00000000-0000-0000-0000-00000000000a", ...state },
    sent: [],
    status: async () => structuredClone(mock.state),
    async sendMail(from, message) {
      if (mock.failWith) throw mock.failWith;
      if (!mock.state.ready) throw new Error(mock.state.reason ?? "The Entra connector is not ready.");
      mock.sent.push({ from, message: structuredClone(message) });
    },
  };
  return mock;
}
