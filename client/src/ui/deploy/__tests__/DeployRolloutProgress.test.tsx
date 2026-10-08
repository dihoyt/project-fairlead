import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BundleRunView } from "@contracts/deploy";
import { mockBundlePlan, mockBundleRun, mockDeployJob, mockFailedJob } from "@contracts/mocks/catalog";
import { renderWithApp } from "../../../test-utils";
import { BundlePlanView } from "../BundlePlanView";
import { DeployRolloutProgress, defaultStep } from "../DeployRolloutProgress";
import { stubApi, stubEventSource } from "./stubApi";

const row = (appId: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-step="${appId}"]`);
    expect(el).not.toBeNull();
    return el!;
  });

const badge = async (appId: string, text: string) =>
  within(await row(appId))
    .getByText(text)
    .closest(".mantine-Badge-root")!;

const failedRun: BundleRunView = {
  ...mockBundleRun,
  state: "failed",
  finishedAt: mockBundleRun.createdAt,
  steps: mockBundleRun.steps.map((step) =>
    step.state === "running"
      ? { ...step, state: "failed", message: "context deadline exceeded" }
      : step.state === "pending"
        ? { ...step, state: "cancelled" }
        : step
  ),
};

describe("DeployRolloutProgress", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows every app's state, the overall state and the running app's log", async () => {
    stubApi();
    stubEventSource(["installing gitea"]);
    renderWithApp(<DeployRolloutProgress runId={mockBundleRun.id} names={{ gitea: "Gitea" }} />);
    expect((await row("gitea")).dataset.stepState).toBe("running");
    expect(document.querySelector("[data-run-state]")?.getAttribute("data-run-state")).toBe("running");
    expect(screen.getByText("Gitea", { selector: "h6" })).toBeInTheDocument();
    const counted = mockBundleRun.steps.filter((s) => s.state !== "skipped");
    const done = counted.filter((s) => s.state === "succeeded").length;
    expect(screen.getByText(`${done} of ${counted.length} apps installed`)).toBeInTheDocument();
    const waiting = mockBundleRun.steps.find((s) => s.state === "pending");
    if (waiting) expect(within(await row(waiting.appId)).getByText("waiting")).toBeInTheDocument();
    const skipped = mockBundleRun.steps.find((s) => s.state === "skipped");
    if (skipped) expect(within(await row(skipped.appId)).getByText("skipped")).toBeInTheDocument();
  });

  it("draws waiting and skipped steps differently, with the skip reason in small print", async () => {
    stubApi();
    stubEventSource([]);
    renderWithApp(<DeployRolloutProgress runId={mockBundleRun.id} />);
    const waiting = mockBundleRun.steps.find((s) => s.state === "pending")!;
    const skipped = mockBundleRun.steps.find((s) => s.state === "skipped")!;
    const w = await badge(waiting.appId, "waiting");
    const s = await badge(skipped.appId, "skipped");
    expect(w.getAttribute("data-variant")).not.toBe(s.getAttribute("data-variant"));
    if (skipped.message) {
      const reason = within(await row(skipped.appId)).getByText(skipped.message);
      expect(reason.className).toMatch(/mantine-Text/);
      expect(reason.getAttribute("data-size")).toBe("xs");
    }
  });

  it("names apps from the catalog when no names are given", async () => {
    stubApi();
    stubEventSource([]);
    renderWithApp(<DeployRolloutProgress runId={mockBundleRun.id} />);
    expect(await within(await row("gitea")).findByText("Gitea")).toBeInTheDocument();
  });

  it("reports a failed run once and shows the failed app's log", async () => {
    stubApi({ "GET /api/deploy/bundles/:id": failedRun, "GET /api/deploy/jobs/:id": mockFailedJob });
    stubEventSource();
    const onFinished = vi.fn();
    renderWithApp(<DeployRolloutProgress runId={failedRun.id} onFinished={onFinished} />);
    expect(await screen.findByText("context deadline exceeded")).toBeInTheDocument();
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(onFinished.mock.calls[0]![0]).toMatchObject({ state: "failed" });
    expect(screen.queryByRole("button", { name: "Cancel rollout" })).toBeNull();
    expect(defaultStep(failedRun)?.appId).toBe("gitea");
  });

  it("switches the log to an app the user picks", async () => {
    const { calls } = stubApi({ "GET /api/deploy/jobs/:id": mockDeployJob });
    stubEventSource([]);
    renderWithApp(<DeployRolloutProgress runId={mockBundleRun.id} names={{ authentik: "Authentik" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show the log for Authentik" }));
    expect(await screen.findByText("Authentik", { selector: "h6" })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith("/api/deploy/jobs/dj_authentik"))).toBe(true));
  });

  it("cancels the rollout", async () => {
    const { calls } = stubApi();
    stubEventSource([]);
    renderWithApp(<DeployRolloutProgress runId={mockBundleRun.id} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel rollout" }));
    await waitFor(() =>
      expect(document.querySelector("[data-run-state]")?.getAttribute("data-run-state")).toBe("cancelled")
    );
    expect(calls.some((c) => c.key === "POST /api/deploy/bundles/:id/cancel")).toBe(true);
  });
});

describe("BundlePlanView", () => {
  it("lists apps in order with the skipped ones and their reasons", () => {
    renderWithApp(<BundlePlanView plan={mockBundlePlan} />);
    const skipped = mockBundlePlan.steps.filter((s) => s.skip);
    const running = mockBundlePlan.steps.length - skipped.length;
    expect(screen.getByText(new RegExp(`Installs ${running} apps in this order`))).toBeInTheDocument();
    for (const step of skipped) {
      const el = document.querySelector<HTMLElement>(`[data-step="${step.appId}"]`)!;
      expect(within(el).getByText("skipped")).toBeInTheDocument();
    }
  });

  it("says which app blocks the rollout", () => {
    const blocked = {
      ...mockBundlePlan,
      allowed: false,
      steps: mockBundlePlan.steps.map((s) =>
        s.appId === "gitea" && s.plan
          ? { ...s, plan: { ...s.plan, allowed: false, blockedBy: "adminPassword: required" } }
          : s
      ),
    };
    renderWithApp(<BundlePlanView plan={blocked} names={{ gitea: "Gitea" }} />);
    expect(screen.getByText("Gitea: adminPassword: required")).toBeInTheDocument();
    expect(screen.getByText("blocked")).toBeInTheDocument();
  });
});
