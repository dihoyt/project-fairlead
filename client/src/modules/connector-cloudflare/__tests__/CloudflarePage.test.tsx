import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithApp } from "../../../test-utils";
import { apiMocks } from "../../../ui/mocks/api";
import { mockCloudflareEmpty } from "@contracts/mocks/connectors/views";
import type { CloudflareView } from "@contracts/connectors";
import { product } from "../../../product";
import { CloudflarePage } from "../CloudflarePage";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function serve(
  view: CloudflareView,
  connectors: unknown[] = [],
  access: unknown = {},
  overview: unknown = apiMocks["GET /api/admin/overview"]
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("connector-cloudflare/view")) return json(view);
    if (url.includes("deploy/access")) return json(access);
    if (url.includes("connector-cloudflare/discover")) return json(apiMocks["POST /api/connector-cloudflare/discover"]);
    if (url.includes("connector-cloudflare/hosts/")) return json(apiMocks["PUT /api/connector-cloudflare/hosts/:host"]);
    if (url.includes("tunnel/deploy")) return json(apiMocks["POST /api/connector-cloudflare/tunnel/deploy"]);
    if (url.includes("connector-cloudflare/tunnel")) return json(apiMocks["POST /api/connector-cloudflare/tunnel"]);
    if (url.endsWith("api/connectors") && method === "POST") return json(apiMocks["POST /api/connectors"]);
    if (url.endsWith("api/connectors")) return json(connectors);
    if (url.includes("api/connectors/") && url.endsWith("/reconcile")) return json(apiMocks["POST /api/connectors"]);
    if (url.includes("api/connectors/") && method === "PUT") return json(apiMocks["PUT /api/connectors/:id"]);
    if (url.includes("api/connectors/")) return json(apiMocks["GET /api/connectors/:id"]);
    if (url.includes("api/admin/overview")) return json(overview);
    if (url.includes("api/admin/settings/")) return json({ key: "connector-cloudflare.accessApps", value: "per-app" });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const body = (fetchMock: ReturnType<typeof serve>, part: string) => {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => String(url).includes(part) && init?.method !== undefined && init.method !== "GET"
  );
  return call ? (JSON.parse(String(call[1]!.body ?? "null")) as unknown) : undefined;
};

describe("CloudflarePage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists each app with what is set up in Cloudflare and why one is blocked", async () => {
    serve(apiMocks["GET /api/connector-cloudflare/view"]);
    renderWithApp(<CloudflarePage />);
    const longhorn = await screen.findByText("longhorn.example.test");
    const row = within(longhorn.closest("tr")!);
    expect(row.getByText("DNS: not ours")).toBeInTheDocument();
    expect(row.getByText(/A DNS record this install didn't create/)).toBeInTheDocument();
    expect(screen.getByText("healthy")).toBeInTheDocument();
  });

  it("shows what outside the connector will break its hosts", async () => {
    const warning = '*.example.test points at tunnel "old" (inactive), not this connector\'s tunnel.';
    serve({ ...apiMocks["GET /api/connector-cloudflare/view"], warnings: [warning] });
    renderWithApp(<CloudflarePage />);
    expect(await screen.findByText(warning)).toBeInTheDocument();
  });

  it("marks an app with no sign-in of its own", async () => {
    const view = apiMocks["GET /api/connector-cloudflare/view"];
    serve({ ...view, hosts: view.hosts.map((h, i) => (i === 0 ? { ...h, noLogin: true } : h)) });
    renderWithApp(<CloudflarePage />);
    const row = (await screen.findByText(view.hosts[0]!.host)).closest("tr")!;
    expect(within(row).getByText("No sign-in of its own")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-no-login]")).toHaveLength(1);
  });

  it("switches an app to direct", async () => {
    const fetchMock = serve(apiMocks["GET /api/connector-cloudflare/view"]);
    renderWithApp(<CloudflarePage />);
    const grafana = await screen.findByText("grafana.example.test");
    fireEvent.click(within(grafana.closest("tr")!).getByText("Direct"));
    await waitFor(() => expect(body(fetchMock, "hosts/grafana.example.test")).toEqual({ exposure: "direct" }));
  });

  it("sets the Access mode and allow list in one place, then syncs", async () => {
    const fetchMock = serve(apiMocks["GET /api/connector-cloudflare/view"]);
    renderWithApp(<CloudflarePage />);
    fireEvent.click(await screen.findByText("Per app"));
    fireEvent.change(screen.getByLabelText(/Who may sign in/), { target: { value: "me@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and sync" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url).endsWith("connector-cloudflare/sync") && init?.method === "POST"
        )
      ).toBe(true)
    );
    expect(body(fetchMock, "api/connectors/")).toEqual({ values: { accessEmails: "me@example.test" } });
    expect(body(fetchMock, "settings/connector-cloudflare.accessApps")).toEqual({ value: "per-app" });
  });

  it("offers the console's Google sign-in list and says how to add Google to Access", async () => {
    const settings = [
      { key: "auth.oidc.issuer", value: "https://accounts.google.com" },
      { key: "auth.oidc.allowedEmails", value: ["ann@example.test", "@example.org"] },
    ];
    serve({ ...apiMocks["GET /api/connector-cloudflare/view"], accessPolicy: "per-app" }, [], {}, { settings });
    renderWithApp(<CloudflarePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Use the console's sign-in list" }));
    expect(screen.getByLabelText(/Who may sign in/)).toHaveValue("ann@example.test, @example.org");
    expect(document.querySelector("[data-access-provider]")?.textContent).toMatch(/add Google under Zero Trust/);
  });

  it("says where direct apps point and that a detected address is followed", async () => {
    serve({
      ...apiMocks["GET /api/connector-cloudflare/view"],
      publicAddress: "203.0.113.9",
      publicAddressSource: "detected",
    });
    renderWithApp(<CloudflarePage />);
    expect(await screen.findByText("203.0.113.9")).toBeInTheDocument();
    expect(document.querySelector("[data-public-address]")?.textContent).toMatch(/detected from this cluster/);
  });

  it("shows the Access switch only when the setting is per app", async () => {
    serve({ ...apiMocks["GET /api/connector-cloudflare/view"], accessPolicy: "per-app" });
    renderWithApp(<CloudflarePage />);
    expect(await screen.findByLabelText("Cloudflare Access for grafana.example.test")).toBeInTheDocument();
  });

  it("offers the tunnel an earlier install left, and a new name otherwise", async () => {
    const { tunnel: _tunnel, ...noTunnel } = apiMocks["GET /api/connector-cloudflare/view"];
    const left = "6f0c9a1e-2b3d-4c5e-8f70-1a2b3c4d5e6f";
    const fetchMock = serve({
      ...noTunnel,
      existingTunnels: [
        { id: left, name: product.slug, status: "down" },
        { id: "7f0c9a1e-2b3d-4c5e-8f70-1a2b3c4d5e6f", name: "home", status: "healthy" },
      ],
    });
    renderWithApp(<CloudflarePage />);
    fireEvent.click(await screen.findByRole("button", { name: `Use the existing "${product.slug}" tunnel` }));
    await waitFor(() => expect(body(fetchMock, "connector-cloudflare/tunnel")).toEqual({ tunnelId: left }));
    expect(screen.getByText("Already taken in this account")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a tunnel" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Or create a new tunnel named"), { target: { value: "lab" } });
    expect(screen.getByRole("button", { name: "Create a tunnel" })).toBeEnabled();
  });

  it("offers to create a tunnel, then to deploy cloudflared", async () => {
    const { tunnel: _tunnel, ...noTunnel } = apiMocks["GET /api/connector-cloudflare/view"];
    const fetchMock = serve(noTunnel);
    renderWithApp(<CloudflarePage />);
    fireEvent.click(await screen.findByText("Create a tunnel"));
    await waitFor(() => expect(body(fetchMock, "connector-cloudflare/tunnel")).toEqual({}));
    vi.unstubAllGlobals();

    const inactive = {
      ...apiMocks["GET /api/connector-cloudflare/view"],
      tunnel: { ...apiMocks["GET /api/connector-cloudflare/view"].tunnel!, status: "inactive" },
    };
    const second = serve(inactive);
    renderWithApp(<CloudflarePage />);
    fireEvent.click(await screen.findByText("Deploy cloudflared"));
    await waitFor(() =>
      expect(
        second.mock.calls.some(([url, init]) => String(url).includes("tunnel/deploy") && init?.method === "POST")
      ).toBe(true)
    );
    expect(await screen.findByText(/cloudflared is being deployed/)).toBeInTheDocument();
  });

  it("says when an installed cloudflared isn't serving this tunnel", async () => {
    const inactive = {
      ...apiMocks["GET /api/connector-cloudflare/view"],
      tunnel: { ...apiMocks["GET /api/connector-cloudflare/view"].tunnel!, status: "inactive" },
    };
    serve(inactive, [], { ...apiMocks["GET /api/deploy/access"], appId: "cloudflared", appInstalled: true });
    renderWithApp(<CloudflarePage />);
    expect(await screen.findByText(/installed but not connected to this tunnel/)).toBeInTheDocument();
    expect(screen.queryByText("Deploy cloudflared")).toBeNull();
  });

  it("connects with a token: check it, pick the zone matching the domain, save", async () => {
    const fetchMock = serve(mockCloudflareEmpty);
    renderWithApp(<CloudflarePage />);
    fireEvent.change(await screen.findByLabelText("API token"), { target: { value: "cf-token" } });
    fireEvent.click(screen.getByText("Check token"));
    await screen.findByText("Connect");
    expect(body(fetchMock, "connector-cloudflare/discover")).toEqual({ token: "cf-token" });
    fireEvent.click(screen.getByText("Connect"));
    await waitFor(() =>
      expect(body(fetchMock, "api/connectors")).toEqual({
        kind: "cloudflare",
        name: "Cloudflare",
        values: { apiToken: "cf-token", accountId: "0123456789abcdef0123456789abcdef", zone: "example.test" },
      })
    );
  });

  it("updates the saved connector instead of adding a second one, and drops stale results", async () => {
    const existing = { ...apiMocks["POST /api/connectors"], id: "cn_saved", status: "crit" };
    const fetchMock = serve(mockCloudflareEmpty, [existing]);
    renderWithApp(<CloudflarePage />);
    fireEvent.change(await screen.findByLabelText("API token"), { target: { value: "cf-token-2" } });
    fireEvent.click(screen.getByText("Check token"));
    fireEvent.click(await screen.findByText("Connect"));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url).endsWith("api/connectors/cn_saved") && init?.method === "PUT"
        )
      ).toBe(true)
    );
    expect(body(fetchMock, "api/connectors/cn_saved")).toEqual({
      values: { apiToken: "cf-token-2", accountId: "0123456789abcdef0123456789abcdef", zone: "example.test" },
    });
    expect(
      fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("api/connectors") && init?.method === "POST")
    ).toBe(false);
  });
});
