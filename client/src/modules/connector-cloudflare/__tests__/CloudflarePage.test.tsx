import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithApp } from "../../../test-utils";
import { apiMocks } from "../../../ui/mocks/api";
import { mockCloudflareEmpty } from "@contracts/mocks/connectors/views";
import type { CloudflareView } from "@contracts/connectors";
import { CloudflarePage } from "../CloudflarePage";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function serve(view: CloudflareView) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("connector-cloudflare/view")) return json(view);
    if (url.includes("connector-cloudflare/discover")) return json(apiMocks["POST /api/connector-cloudflare/discover"]);
    if (url.includes("connector-cloudflare/hosts/")) return json(apiMocks["PUT /api/connector-cloudflare/hosts/:host"]);
    if (url.includes("tunnel/deploy")) return json(apiMocks["POST /api/connector-cloudflare/tunnel/deploy"]);
    if (url.includes("connector-cloudflare/tunnel")) return json(apiMocks["POST /api/connector-cloudflare/tunnel"]);
    if (url.endsWith("api/connectors") && method === "POST") return json(apiMocks["POST /api/connectors"]);
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const body = (fetchMock: ReturnType<typeof serve>, part: string) => {
  const call = fetchMock.mock.calls.find(([url, init]) => String(url).includes(part) && init?.method !== undefined);
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

  it("switches an app to direct", async () => {
    const fetchMock = serve(apiMocks["GET /api/connector-cloudflare/view"]);
    renderWithApp(<CloudflarePage />);
    const grafana = await screen.findByText("grafana.example.test");
    fireEvent.click(within(grafana.closest("tr")!).getByText("Direct"));
    await waitFor(() => expect(body(fetchMock, "hosts/grafana.example.test")).toEqual({ exposure: "direct" }));
  });

  it("shows the Access switch only when the setting is per app", async () => {
    serve({ ...apiMocks["GET /api/connector-cloudflare/view"], accessPolicy: "per-app" });
    renderWithApp(<CloudflarePage />);
    expect(await screen.findByLabelText("Cloudflare Access for grafana.example.test")).toBeInTheDocument();
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
});
