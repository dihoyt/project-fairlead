import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { AdminOverview, SettingView } from "@contracts/auth";
import { mockCategoryDetail } from "@contracts/mocks/api";
import { apiMocks } from "../../../ui/mocks/api";
import { renderWithApp } from "../../../test-utils";
import { directionOf, rowsOf, withDirection, withField } from "../CheckRulesEditor";
import { groupTitle } from "../groups";
import { SettingsPage } from "../SettingsPage";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const setting = (key: string, value: unknown, extra: Partial<SettingView> = {}): SettingView => ({
  key,
  group: key.split(".")[0]!,
  label: key,
  help: "",
  type: "json",
  default: {} as never,
  value: value as never,
  source: "ui",
  ...extra,
});

function serve(settings: SettingView[]) {
  const overview: AdminOverview = { ...apiMocks["GET /api/admin/overview"], settings };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") return json({ ok: true });
    if (url.includes("api/admin/overview")) return json(overview);
    if (url.includes("api/health/categories/cluster")) return json(mockCategoryDetail);
    if (url.includes("api/health/categories/")) return json({ ...mockCategoryDetail, providers: [] });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const puts = (fetchMock: ReturnType<typeof serve>) =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([url, init]) => ({ url: String(url), value: JSON.parse(String(init?.body)).value as unknown }));

describe("rule helpers", () => {
  it("lists one row per reported check, keyed provider/check", () => {
    const rows = rowsOf(mockCategoryDetail.providers);
    expect(rows.map((r) => r.key)).toEqual(["cluster/nodes.ready", "cluster/certs.expiry", "cluster/pods.crashloop"]);
    expect(rows.every((r) => r.numeric)).toBe(true);
  });

  it("drops a rule left empty and moves thresholds between sides", () => {
    const one = withField({}, "a/b", "critAbove", 5);
    expect(one).toEqual({ "a/b": { critAbove: 5 } });
    expect(withField(one, "a/b", "critAbove", undefined)).toEqual({});
    const below = withDirection({ "a/b": { warnAbove: 3, critAbove: 1, maxStatus: "warn" } }, "a/b", "below");
    expect(below).toEqual({ "a/b": { warnBelow: 3, critBelow: 1, maxStatus: "warn" } });
    expect(directionOf(below["a/b"])).toBe("below");
  });

  it("titles module groups", () => {
    expect(groupTitle("health")).toBe("Health board");
    expect(groupTitle("General")).toBe("General");
    expect(groupTitle("somethingnew")).toBe("Somethingnew");
  });
});

describe("Settings page health editors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows a check table instead of a JSON box and saves the edited rules", async () => {
    const fetchMock = serve([
      setting(
        "health.rules",
        { "cluster/nodes.ready": { warnBelow: 3 }, "gone/check": { disabled: true } },
        {
          label: "Check rules",
          env: "HEALTH_RULES",
        }
      ),
    ]);
    renderWithApp(<SettingsPage />);
    expect(await screen.findByRole("heading", { name: "Health board" })).toBeInTheDocument();
    const row = (await screen.findByText("Crashlooping pods")).closest("tr")!;
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.getByText(/rule for checks not reporting now \(gone\/check\)/)).toBeInTheDocument();
    expect(screen.getByText(/a value saved here takes precedence/)).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts(fetchMock)).toHaveLength(1));
    const [put] = puts(fetchMock);
    expect(put!.url).toContain("api/admin/settings/health.rules");
    expect(JSON.parse(put!.value as string)).toEqual({
      "cluster/nodes.ready": { warnBelow: 3 },
      "gone/check": { disabled: true },
      "cluster/pods.crashloop": { disabled: true },
    });
  });

  it("shows the Links form for native UI links and keeps links it does not manage", async () => {
    const custom = { label: "Wiki", url: "https://wiki.example.com" };
    const fetchMock = serve([
      setting(
        "health.links",
        { cluster: [custom, { label: "Grafana", url: "https://grafana.example.com" }] },
        {
          label: "Native UI links",
        }
      ),
    ]);
    renderWithApp(<SettingsPage />);
    const grafana = await screen.findByDisplayValue("https://grafana.example.com");
    fireEvent.change(screen.getByLabelText("Gitea"), { target: { value: "https://git.example.com/" } });
    expect(grafana).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts(fetchMock).length).toBeGreaterThan(0));
    const links = puts(fetchMock).find((p) => p.url.includes("health.links"))!;
    expect(JSON.parse(links.value as string)).toEqual({
      cluster: [custom, { label: "Grafana", url: "https://grafana.example.com" }],
      gitops: [{ label: "Gitea", url: "https://git.example.com" }],
    });
  });

  it("shows an environment-locked rule set read-only", async () => {
    serve([setting("health.rules", {}, { label: "Check rules", env: "HEALTH_RULES", locked: true, source: "env" })]);
    renderWithApp(<SettingsPage />);
    const row = (await screen.findByText("Crashlooping pods")).closest("tr")!;
    expect(within(row).getByRole("switch")).toBeDisabled();
    expect(screen.getByText(/in the environment, which overrides this page/)).toBeInTheDocument();
  });
});
