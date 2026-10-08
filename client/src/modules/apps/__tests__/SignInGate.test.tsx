import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { DeployActionPlan } from "@contracts/deploy";
import { renderWithApp } from "../../../test-utils";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { SignInGateSection } from "../SignInGate";

const row = (appId: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-gate-app="${appId}"]`);
    expect(el).not.toBeNull();
    return el!;
  });

const publicPlan: DeployActionPlan = {
  kind: "app-gate",
  title: "Make Gitea public",
  allowed: true,
  steps: [
    {
      label: "Take the gate off its Ingresses",
      commands: ["kubectl annotate ingress gitea --namespace gitea traefik.ingress.kubernetes.io/router.middlewares-"],
    },
  ],
  changes: [{ kind: "Ingress", name: "gitea", namespace: "gitea" }],
  creates: [],
  warnings: [],
};

describe("SignInGateSection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows each deployed app's state, and why an open one is open", async () => {
    stubApi();
    renderWithApp(<SignInGateSection />);
    const longhorn = await row("longhorn");
    expect(longhorn.dataset.gateState).toBe("open");
    expect(within(longhorn).getByText("Open to anyone")).toBeInTheDocument();
    expect(within(longhorn).getByText(/has no gate middleware/)).toBeInTheDocument();
    expect(within(await row("gitea")).getByText("Behind sign-in")).toBeInTheDocument();
    // An identity provider can't be gated.
    expect(within(await row("authentik")).getByRole("switch")).toBeDisabled();
  });

  it("previews the app-gate action before making an app public, then runs it", async () => {
    const { calls } = stubApi({ "POST /api/deploy/actions/plan": publicPlan });
    renderWithApp(<SignInGateSection />);
    fireEvent.click(within(await row("gitea")).getByRole("switch"));
    const run = await screen.findByRole("button", { name: "Make Gitea public" });
    expect(calls.find((c) => c.key === "POST /api/deploy/actions/plan")?.body).toEqual({
      kind: "app-gate",
      appId: "gitea",
      public: true,
    });
    await waitFor(() => expect(run).toBeEnabled());
    fireEvent.click(run);
    await waitFor(() =>
      expect(calls.find((c) => c.key === "POST /api/deploy/actions/run")?.body).toEqual({
        kind: "app-gate",
        appId: "gitea",
        public: true,
      })
    );
  });

  it("says when the gate can't be applied", async () => {
    stubApi({
      "GET /api/deploy/gate": {
        ready: false,
        reason: "The console has no public URL to send people to sign in; set it in Admin > Settings.",
        apps: [],
      },
    });
    renderWithApp(<SignInGateSection />);
    expect(await screen.findByText(/no public URL to send people to sign in/)).toBeInTheDocument();
  });
});
