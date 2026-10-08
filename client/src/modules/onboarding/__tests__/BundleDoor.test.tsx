import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  mockBundlePlan,
  mockBundleRun,
  mockBundleView,
  mockCatalogApps,
  mockDeployDisabled,
} from "@contracts/mocks/catalog";
import type { BundleRunView } from "@contracts/deploy";
import { apiMocks } from "../../../ui/mocks/api";
import { SessionContext, type Session } from "../../../ui/session";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { BundleDoor, initialBundleValues, initialInclude } from "../BundleDoor";
import { landedSteps, linksForLanded, runFailures } from "../bundle";
import { WelcomePage, startsAtDoors } from "../WelcomePage";

const admin: Session = { me: { ...apiMocks["GET /api/me"], admin: true }, methods: null, refresh: () => {} };
const fresh = {
  ...apiMocks["GET /api/onboarding/state"],
  steps: apiMocks["GET /api/onboarding/state"].steps.map((s) => ({ ...s, done: s.id === "password", skipped: false })),
};

const noRuns = { "GET /api/deploy/bundles": [] as BundleRunView[] };

describe("bundle helpers", () => {
  it("prefills the shared answers from discovery and ticks the selected optional items", () => {
    expect(initialBundleValues(mockBundleView)).toEqual({ baseDomain: "example.test", storageClass: "longhorn" });
    // Longhorn is installed in the mock, so no optional item is left to tick.
    expect(initialInclude(mockBundleView)).toEqual([]);
  });

  it("fills only empty link fields from landed apps", () => {
    const landed = landedSteps({
      steps: [
        { appId: "gitea", state: "succeeded", url: "https://git.example.test/" },
        { appId: "grafana", state: "succeeded", url: "https://grafana.example.test" },
        { appId: "ntfy", state: "running" },
      ],
    });
    expect(landed).toHaveLength(2);
    const form = {
      rancherUrl: "",
      rancherClusterId: "local",
      headlampUrl: "",
      headlampCluster: "main",
      longhornUrl: "",
      giteaUrl: "",
      grafanaUrl: "https://grafana.mine.test",
    };
    expect(linksForLanded(form, landed, mockCatalogApps)).toEqual({ giteaUrl: "https://git.example.test" });
  });
});

describe("runFailures", () => {
  it("names the required app a rollout stopped at", () => {
    expect(
      runFailures({
        steps: [
          { appId: "longhorn", state: "failed", message: "open-iscsi missing" },
          { appId: "authentik", state: "failed", message: "timed out" },
          { appId: "gitea", state: "cancelled" },
          { appId: "ntfy", state: "pending" },
        ],
      })
    ).toEqual({
      kind: "stopped",
      stoppedAt: "authentik",
      failed: [
        { appId: "longhorn", message: "open-iscsi missing" },
        { appId: "authentik", message: "timed out" },
      ],
    });
  });

  it("reports a run where only optional apps failed as finished", () => {
    expect(
      runFailures({
        steps: [
          { appId: "longhorn", state: "failed", message: "open-iscsi missing" },
          { appId: "gitea", state: "succeeded" },
          { appId: "grafana", state: "skipped" },
        ],
      })
    ).toEqual({ kind: "finished", failed: [{ appId: "longhorn", message: "open-iscsi missing" }] });
  });
});

describe("WelcomePage doors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts a fresh install at the two doors", async () => {
    expect(startsAtDoors(fresh.steps)).toBe(true);
    expect(startsAtDoors(apiMocks["GET /api/onboarding/state"].steps)).toBe(false);
    stubApi({ "GET /api/onboarding/state": fresh, ...noRuns });
    renderWithApp(
      <SessionContext.Provider value={admin}>
        <WelcomePage />
      </SessionContext.Provider>
    );
    const doors = await screen.findByText("Custom setup", { selector: "h4" });
    expect(doors).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Custom setup" }));
    expect(await screen.findByText("Connection and permissions")).toBeInTheDocument();
  });

  it("goes straight to the steps once setup has started", async () => {
    const started = {
      ...apiMocks["GET /api/onboarding/state"],
      steps: apiMocks["GET /api/onboarding/state"].steps.map((s) => (s.id === "hosts" ? { ...s, skipped: true } : s)),
    };
    stubApi({ ...noRuns, "GET /api/onboarding/state": started });
    renderWithApp(
      <SessionContext.Provider value={admin}>
        <WelcomePage />
      </SessionContext.Provider>
    );
    expect(await screen.findByText("Connection and permissions")).toBeInTheDocument();
    expect(document.querySelector("[data-doors]")).toBeNull();
    expect(screen.getByRole("button", { name: "Deploy bundle" })).toBeInTheDocument();
  });
});

describe("BundleDoor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks the essentials, previews every step, and starts nothing before Start", async () => {
    const { calls } = stubApi(noRuns);
    renderWithApp(<BundleDoor onDone={() => {}} />);
    expect(await screen.findByLabelText(/Base domain/)).toHaveValue("example.test");
    expect(await screen.findByLabelText(/Public URL/)).toBeInTheDocument();
    const traefik = document.querySelector('[data-item="traefik"]') as HTMLElement;
    expect(within(traefik).getByRole("checkbox")).toBeDisabled();
    expect(within(traefik).getByText("Already installed")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Admin email/), { target: { value: "me@example.test" } });
    fireEvent.change(screen.getByLabelText(/Admin password/), { target: { value: "s3cret-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByRole("button", { name: "Start rollout" })).toBeEnabled();
    expect(calls.find((c) => c.key === "POST /api/deploy/bundles/plan")?.body).toEqual({
      bundleId: "self-hosted",
      inputs: {
        baseDomain: "example.test",
        storageClass: "longhorn",
        adminEmail: "me@example.test",
        adminPassword: "s3cret-pass",
      },
      include: [],
    });
    expect(calls.some((c) => c.key === "POST /api/deploy/bundles")).toBe(false);
    expect(document.querySelectorAll("[data-step]")).toHaveLength(mockBundlePlan.steps.length);

    fireEvent.click(screen.getByRole("button", { name: "Start rollout" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/deploy/bundles")).toBe(true));
    expect(await screen.findByRole("button", { name: "Continue setup" })).toBeDisabled();
  });

  it("offers no start while deploys are off", async () => {
    stubApi({ ...noRuns, "GET /api/deploy/status": mockDeployDisabled });
    renderWithApp(<BundleDoor onDone={() => {}} />);
    expect(await screen.findAllByText(mockDeployDisabled.enableHint!)).not.toHaveLength(0);
    fireEvent.change(await screen.findByLabelText(/Admin email/), { target: { value: "me@example.test" } });
    fireEvent.change(screen.getByLabelText(/Admin password/), { target: { value: "s3cret-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("button", { name: "Start rollout" })).toBeDisabled();
  });

  it("wires a link and a check for each app as it lands", async () => {
    const run: BundleRunView = {
      ...mockBundleRun,
      state: "succeeded",
      steps: [
        { appId: "gitea", state: "succeeded", jobId: "dj_gitea", url: "https://git.example.test" },
        { appId: "grafana", state: "skipped", message: "Already installed" },
      ],
    };
    const overview = apiMocks["GET /api/admin/overview"];
    const setting = (key: string, value: unknown) => ({ ...overview.settings[0]!, key, value });
    const { calls } = stubApi({
      "GET /api/deploy/bundles": [{ ...run, state: "running" }],
      "GET /api/deploy/bundles/:id": run,
      "GET /api/admin/overview": {
        ...overview,
        settings: [...overview.settings, setting("health.links", {}), setting("workloads.rancherUrl", "")],
      },
    });
    renderWithApp(<BundleDoor onDone={() => {}} />);
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/checks")).toBe(true), { timeout: 3000 });
    expect(calls.filter((c) => c.key === "POST /api/checks").map((c) => c.body)).toEqual([
      { label: "Gitea", kind: "http", target: "https://git.example.test" },
    ]);
    await waitFor(() => expect(calls.some((c) => c.key === "PUT /api/admin/settings/:key")).toBe(true));
    const links = calls.find((c) => c.url.pathname.endsWith("/health.links"));
    expect(JSON.stringify(links?.body)).toContain("https://git.example.test");
    expect(await screen.findByText("Rolled out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue setup" })).toBeEnabled();
  });

  it("says the rollout finished with failures when only an optional app failed", async () => {
    const run: BundleRunView = {
      ...mockBundleRun,
      state: "failed",
      steps: [
        { appId: "longhorn", state: "failed", jobId: "dj_l", message: "open-iscsi missing" },
        { appId: "headlamp", state: "succeeded", jobId: "dj_h" },
      ],
    };
    stubApi({ "GET /api/deploy/bundles": [{ ...run, state: "running" }], "GET /api/deploy/bundles/:id": run });
    renderWithApp(<BundleDoor onDone={() => {}} />);
    expect(await screen.findByText("Finished with failures")).toBeInTheDocument();
    expect(screen.getByText(/: open-iscsi missing/)).toBeInTheDocument();
  });

  it("says where the rollout stopped when a required app failed", async () => {
    const run: BundleRunView = {
      ...mockBundleRun,
      state: "failed",
      steps: [
        { appId: "authentik", state: "failed", jobId: "dj_a", message: "timed out" },
        { appId: "gitea", state: "pending" },
      ],
    };
    stubApi({ "GET /api/deploy/bundles": [{ ...run, state: "running" }], "GET /api/deploy/bundles/:id": run });
    renderWithApp(<BundleDoor onDone={() => {}} />);
    expect(await screen.findByText("Stopped at Authentik")).toBeInTheDocument();
    expect(screen.getByText(/: timed out/)).toBeInTheDocument();
  });
});
