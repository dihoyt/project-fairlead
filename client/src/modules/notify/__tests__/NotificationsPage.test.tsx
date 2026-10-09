import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { NotificationsPage } from "../NotificationsPage";

describe("NotificationsPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists email channels with sender and recipients, and shows a failed test's server reply", async () => {
    stubApi({
      "GET /api/notify/channels": [
        {
          id: "ch_email",
          kind: "email",
          label: "Ops mailbox",
          enabled: true,
          minSeverity: "crit",
          hasSecret: true,
          config: { email: { preset: "gmail", mode: "smtp", from: "alerts@example.com", to: ["ops@example.com"] } },
        },
        {
          id: "ch_email_oauth",
          kind: "email",
          label: "Outlook",
          enabled: true,
          minSeverity: "warn",
          hasSecret: true,
          config: { email: { preset: "microsoft-oauth", mode: "oauth", clientId: "c", to: ["me@example.com"] } },
        },
      ],
      "POST /api/notify/channels/:id/test": {
        ok: false,
        status: 535,
        error: "SMTP 535: Invalid login",
        response: "535 5.7.8 Username and Password not accepted",
      },
    });
    const user = userEvent.setup();
    renderWithApp(<NotificationsPage />);
    expect(await screen.findByText("alerts@example.com → ops@example.com")).toBeInTheDocument();
    expect(screen.getByText("sign in")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Sign in to send")).toHaveLength(1);
    await user.click(screen.getAllByLabelText("Send a test")[0]!);
    expect(await screen.findByText("SMTP 535: Invalid login")).toBeInTheDocument();
    expect(screen.getByText("535 5.7.8 Username and Password not accepted")).toBeInTheDocument();
  });
});
