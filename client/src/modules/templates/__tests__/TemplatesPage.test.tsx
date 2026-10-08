import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { mockDeployDisabled } from "@contracts/mocks/catalog";
import {
  mockTemplatePlanRefused,
  mockTemplateRemoveJob,
  mockTemplateRemovePlan,
  mockTemplates,
} from "@contracts/mocks/templates";
import { renderWithApp } from "../../../test-utils";
import { stubApi, stubEventSource } from "../../../ui/deploy/__tests__/stubApi";
import { emptyForm, formFromInstance, toRequest } from "../request";
import { TemplatesPage } from "../TemplatesPage";

const card = (id: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-template="${id}"]`);
    expect(el).not.toBeNull();
    return el!;
  });

const custom = mockTemplates.find((t) => t.id === "custom")!;
const kuma = mockTemplates.find((t) => t.id === "uptime-kuma")!;

describe("template requests", () => {
  it("leaves defaults to the server and sends no host when not exposed", () => {
    expect(toRequest(kuma, emptyForm(kuma))).toEqual({ templateId: "uptime-kuma", name: "uptime-kuma" });
    expect(toRequest(kuma, { ...emptyForm(kuma), exposed: false, volumeSize: "5Gi" })).toEqual({
      templateId: "uptime-kuma",
      name: "uptime-kuma",
      host: "",
      volumeSize: "5Gi",
    });
  });

  it("builds a custom app's spec and drops empty variable rows", () => {
    const form = {
      ...emptyForm(custom),
      name: "api",
      image: " ghcr.io/x/api:1 ",
      port: "8080",
      env: [
        { name: "A", value: "1" },
        { name: "", value: "" },
      ],
      volume: true,
      volumeSize: "2Gi",
    };
    expect(toRequest(custom, form)).toEqual({
      templateId: "custom",
      name: "api",
      volumeSize: "2Gi",
      custom: {
        image: "ghcr.io/x/api:1",
        port: 8080,
        env: [{ name: "A", value: "1" }],
        volume: { size: "2Gi", mountPath: "/data" },
      },
    });
  });

  it("prefills a redeploy from the instance", () => {
    const form = formFromInstance(custom, {
      name: "my-api",
      templateId: "custom",
      namespace: "my-api",
      version: "1",
      host: "",
      custom: { image: "a:1", port: 80, env: [], volume: { size: "3Gi", mountPath: "/var/lib/x" } },
      createdBy: "admin",
      createdAt: "",
      updatedAt: "",
    });
    expect(form).toMatchObject({
      name: "my-api",
      exposed: false,
      image: "a:1",
      port: "80",
      volume: true,
      volumeSize: "3Gi",
      mountPath: "/var/lib/x",
    });
  });
});

describe("TemplatesPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists the library with Custom app and the deployed instances", async () => {
    stubApi();
    renderWithApp(<TemplatesPage />);
    for (const id of ["whoami", "uptime-kuma", "it-tools", "custom"]) await card(id);
    const status = await waitFor(() => document.querySelector<HTMLElement>('[data-instance="status"]')!);
    expect(within(status).getByText("1.23.16 available")).toBeInTheDocument();
    const api = document.querySelector<HTMLElement>('[data-instance="my-api"]')!;
    expect(within(api).getByText("inside the cluster only")).toBeInTheDocument();
    expect(within(api).getByText("failed")).toBeInTheDocument();
  });

  it("previews the manifests and the runner's plan, then deploys", async () => {
    const { calls } = stubApi();
    stubEventSource();
    renderWithApp(<TemplatesPage />);
    fireEvent.click(within(await card("whoami")).getByRole("button", { name: "Deploy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect((await screen.findByTestId("manifests")).textContent).toMatch(/kind: Namespace/);
    expect(calls.find((c) => c.key === "POST /api/templates/plan")?.body).toEqual({
      templateId: "whoami",
      name: "whoami",
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/templates/jobs")).toBe(true));
    expect(calls.find((c) => c.key === "POST /api/templates/jobs")?.body).toMatchObject({ mode: "install" });
  });

  it("shows what the guardrail refused and keeps Deploy off", async () => {
    stubApi({ "POST /api/templates/plan": mockTemplatePlanRefused });
    renderWithApp(<TemplatesPage />);
    fireEvent.click(within(await card("whoami")).getByRole("button", { name: "Deploy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(await screen.findByText("Refused by the guardrail")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Deploy" })).toBeDisabled();
  });

  it("puts field errors on the form", async () => {
    stubApi({
      "POST /api/templates/plan": {
        ...mockTemplatePlanRefused,
        allowed: false,
        violations: [],
        fieldErrors: { "custom.image": "needs a tag or digest, like nginx:1.27" },
      },
    });
    renderWithApp(<TemplatesPage />);
    fireEvent.click(within(await card("custom")).getByRole("button", { name: "Deploy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(await screen.findByText("needs a tag or digest, like nginx:1.27")).toBeInTheDocument();
  });

  it("explains how to turn deploys on and disables Deploy while off", async () => {
    stubApi({ "GET /api/deploy/status": mockDeployDisabled });
    renderWithApp(<TemplatesPage />);
    expect(await screen.findByText(/Deploying apps from here is turned off/)).toBeInTheDocument();
    await waitFor(async () =>
      expect(within(await card("whoami")).getByRole("button", { name: "Deploy" })).toBeDisabled()
    );
  });

  it("removes an app, keeping its volume unless asked, and names what goes", async () => {
    const { calls } = stubApi({
      "POST /api/deploy/actions/plan": (_url: URL, body: unknown) =>
        (body as { deleteVolumes?: boolean }).deleteVolumes
          ? {
              ...mockTemplateRemovePlan,
              deletes: [...mockTemplateRemovePlan.deletes!, { kind: "Namespace", name: "status" }],
              warnings: ["The data on status-data is deleted for good."],
            }
          : mockTemplateRemovePlan,
      "POST /api/deploy/actions/run": mockTemplateRemoveJob,
      "GET /api/deploy/jobs/:id": mockTemplateRemoveJob,
    });
    stubEventSource();
    renderWithApp(<TemplatesPage />);
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-instance="status"]');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText('the HTTP check "https://status.example.test"')).toBeInTheDocument();
    expect(within(dialog).getByText(/its volume stay/)).toBeInTheDocument();
    expect(calls.find((c) => c.key === "POST /api/deploy/actions/plan")?.body).toEqual({
      kind: "remove-app",
      appId: "status",
      deleteVolumes: false,
    });

    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Delete its volume too \(status-data, 1Gi\)/ }));
    expect(await within(dialog).findByText("Namespace status")).toBeInTheDocument();
    expect(within(dialog).getByText("The data on status-data is deleted for good.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove status and its data" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/deploy/actions/run")).toBe(true));
    expect(calls.find((c) => c.key === "POST /api/deploy/actions/run")?.body).toEqual({
      kind: "remove-app",
      appId: "status",
      deleteVolumes: true,
    });
  });
});
