import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { mockDeployDisabled } from "@contracts/mocks/catalog";
import {
  mockExternalInstances,
  mockExternalPlan,
  mockPortsView,
  mockTemplatePlanRefused,
  mockTemplates,
} from "@contracts/mocks/templates";
import { renderWithApp } from "../../../test-utils";
import { stubApi, stubEventSource } from "../../../ui/deploy/__tests__/stubApi";
import { emptyForm, formFromInstance, toRequest } from "../request";
import { ExternalTab, TemplatesTab } from "../TemplatesTab";

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

describe("TemplatesTab", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists the library with Custom app, and External service only on its own tab", async () => {
    stubApi();
    renderWithApp(<TemplatesTab onDeployed={() => {}} />);
    for (const id of ["whoami", "uptime-kuma", "it-tools", "custom"]) await card(id);
    expect(document.querySelector('[data-template="external"]')).toBeNull();
  });

  it("previews the manifests and the runner's plan, then deploys", async () => {
    const { calls } = stubApi();
    stubEventSource();
    renderWithApp(<TemplatesTab onDeployed={() => {}} />);
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
    renderWithApp(<TemplatesTab onDeployed={() => {}} />);
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
    renderWithApp(<TemplatesTab onDeployed={() => {}} />);
    fireEvent.click(within(await card("custom")).getByRole("button", { name: "Deploy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(await screen.findByText("needs a tag or digest, like nginx:1.27")).toBeInTheDocument();
  });

  it("disables Deploy while deploys are off", async () => {
    stubApi({ "GET /api/deploy/status": mockDeployDisabled });
    renderWithApp(<TemplatesTab onDeployed={() => {}} />);
    await waitFor(async () =>
      expect(within(await card("whoami")).getByRole("button", { name: "Deploy" })).toBeDisabled()
    );
  });
});

describe("ExternalTab", () => {
  afterEach(() => vi.unstubAllGlobals());

  const external = mockTemplates.find((t) => t.id === "external")!;

  it("sends an external service with its public port, and no host for UDP", () => {
    const form = {
      ...emptyForm(external),
      name: "valheim",
      address: " 10.0.0.50 ",
      port: "2456",
      protocol: "udp" as const,
      publicPort: "25565",
      host: "ignored.example.test",
    };
    expect(toRequest(external, form)).toEqual({
      templateId: "external",
      name: "valheim",
      host: "",
      external: { address: "10.0.0.50", port: 2456, protocol: "udp", publicPort: 25565 },
    });
    expect(formFromInstance(external, mockExternalInstances[1]!)).toMatchObject({
      address: "10.0.0.20",
      port: "5001",
      protocol: "https",
      insecureSkipVerify: true,
      host: "nas.example.test",
    });
  });

  it("notes mismatched ports and that TCP and UDP skip the Cloudflare tunnel, then shows the open-port step", async () => {
    const { calls } = stubApi({ "POST /api/templates/plan": mockExternalPlan });
    renderWithApp(<ExternalTab onDeployed={() => {}} />);
    expect(await screen.findByTestId("forwarded-ports")).toHaveTextContent("25565-25575");
    fireEvent.click(await screen.findByRole("button", { name: "Add an external service" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("cloudflare-note")).toHaveTextContent(/like any app/);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "valheim" } });
    fireEvent.change(within(dialog).getByLabelText("Address"), { target: { value: "10.0.0.50" } });
    fireEvent.change(within(dialog).getByLabelText("Port"), { target: { value: "2456" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "UDP" }));
    expect(within(dialog).queryByLabelText("Hostname")).toBeNull();
    expect(within(dialog).getByTestId("cloudflare-note")).toHaveTextContent(/Direct only/);
    fireEvent.change(within(dialog).getByLabelText("Public port"), { target: { value: "25565" } });
    expect(within(dialog).getByTestId("port-mismatch")).toHaveTextContent(/People connect on 25565/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(await within(dialog).findByText("Traefik doesn't serve this port yet")).toBeInTheDocument();
    expect(calls.find((c) => c.key === "POST /api/templates/plan")?.body).toEqual({
      templateId: "external",
      name: "valheim",
      host: "",
      external: { address: "10.0.0.50", port: 2456, protocol: "udp", publicPort: 25565 },
    });
  });

  it("opens the wanted ports on Traefik from the panel", async () => {
    const { calls } = stubApi({
      "GET /api/deploy/ports": mockPortsView,
      "POST /api/deploy/actions/plan": {
        kind: "traefik-ports",
        title: "Open UDP 25565 on Traefik",
        allowed: true,
        steps: [{ label: "Open UDP 25565", commands: [] }],
        changes: [],
        creates: [],
        warnings: [],
      },
    });
    renderWithApp(<ExternalTab onDeployed={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open UDP 25565 on Traefik" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Open UDP 25565");
    expect(calls.find((c) => c.key === "POST /api/deploy/actions/plan")?.body).toEqual({ kind: "traefik-ports" });
  });
});
