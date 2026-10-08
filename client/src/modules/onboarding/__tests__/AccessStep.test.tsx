import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { mockAccessLocal, mockBundleView } from "@contracts/mocks/catalog";
import type { CatalogBundleView } from "@contracts/catalog";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { AccessInstructions, AccessStep } from "../steps/AccessStep";
import { BundleDoor } from "../BundleDoor";
import { holds } from "../bundle";

describe("Access step", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the saved choice, its app and what to set up in Cloudflare", async () => {
    stubApi();
    renderWithApp(<AccessStep onFinish={async () => {}} />);
    expect(await screen.findByText("traefik.kube-system.svc.cluster.local:80")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Cloudflare Tunnel/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Deploy Cloudflare Tunnel" })).toBeInTheDocument();
    expect(screen.getByText("no DNS yet")).toBeInTheDocument();
    expect(screen.getByText("DNS set up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("saves a new choice and shows the hosts block for a local network", async () => {
    const { calls } = stubApi({
      "GET /api/deploy/access": { hosts: [] },
      "PUT /api/deploy/access": mockAccessLocal,
    });
    renderWithApp(<AccessStep onFinish={async () => {}} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Local network only/ }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    const domain = screen.getByRole("textbox", { name: /Local domain/ });
    await waitFor(() => expect(domain).toHaveValue("example.test"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/10\.0\.0\.20 grafana\.example\.test/)).toBeInTheDocument();
    expect(calls.find((c) => c.key === "PUT /api/deploy/access")?.body).toEqual({
      mode: "local",
      baseDomain: "example.test",
    });
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("says nothing until a mode is saved", () => {
    const { container } = renderWithApp(<AccessInstructions view={{ hosts: [] }} />);
    expect(container.querySelector("[data-access-instructions]")).toBeNull();
  });
});

describe("bundle door with an access choice", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("holds() matches a condition on the answers", () => {
    const when = { input: "access", in: ["cloudflare-tunnel"] };
    expect(holds(undefined, {})).toBe(true);
    expect(holds(when, { access: "cloudflare-tunnel" })).toBe(true);
    expect(holds(when, { access: "local" })).toBe(false);
    expect(holds(when, {})).toBe(false);
  });

  it("asks for the tunnel token and lists cloudflared only for Cloudflare Tunnel", async () => {
    const bundle: CatalogBundleView = {
      ...mockBundleView,
      inputs: [
        {
          key: "access",
          label: "How you reach the apps",
          kind: "select",
          required: true,
          default: "cloudflare-tunnel",
          options: [
            { value: "cloudflare-tunnel", label: "Cloudflare Tunnel" },
            { value: "local", label: "Local network only" },
          ],
        },
        ...mockBundleView.inputs,
        {
          key: "tunnelToken",
          label: "Cloudflare tunnel token",
          kind: "secret",
          required: true,
          when: { input: "access", in: ["cloudflare-tunnel"] },
        },
      ],
      items: [
        {
          appId: "cloudflared",
          required: true,
          when: { input: "access", in: ["cloudflare-tunnel"] },
          detected: mockBundleView.items[0]!.detected,
          skip: false,
          selected: true,
        },
        ...mockBundleView.items,
      ],
    };
    stubApi({ "GET /api/catalog/bundles": [bundle], "GET /api/deploy/bundles": [] });
    const { container } = renderWithApp(<BundleDoor onDone={() => {}} />);
    expect(await screen.findByLabelText(/Cloudflare tunnel token/)).toBeInTheDocument();
    expect(container.querySelector('[data-item="cloudflared"]')).not.toBeNull();
  });
});
