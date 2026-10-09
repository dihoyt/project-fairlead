import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithApp } from "../../../test-utils";
import { apiMocks } from "../../../ui/mocks/api";
import { mockStorageConnector, mockStorageTargetKind } from "@contracts/mocks/connectors/views";
import { ConnectorForm } from "../ConnectorForm";
import { prefillFor } from "../HostPicker";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function serve() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api/hosts")) return json(apiMocks["GET /api/hosts"]);
    if (url.includes("api/connectors/test")) return json({ ok: true, checks: mockStorageConnector.checks });
    return json(mockStorageConnector);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("storage target form", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts on NFS and hides the S3 and SMB credentials", async () => {
    serve();
    renderWithApp(<ConnectorForm kind={mockStorageTargetKind} onSaved={() => {}} />);
    expect(await screen.findByText("Pick a host")).toBeInTheDocument();
    expect(screen.getByLabelText(/Target URL/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Access key ID/)).toBeNull();
    expect(screen.queryByLabelText(/Password/)).toBeNull();
  });

  it("an S3 target shows its keys, keeps the stored secret, and sends hidden fields empty", async () => {
    const fetchMock = serve();
    renderWithApp(<ConnectorForm kind={mockStorageTargetKind} existing={mockStorageConnector} onSaved={() => {}} />);
    expect(screen.getByLabelText(/Access key ID/)).toHaveValue("AKIAMOCKMOCKMOCK0001");
    expect(screen.getByLabelText(/Secret access key/)).toHaveAttribute("placeholder", "Stored; leave empty to keep");
    expect(screen.queryByLabelText(/Username/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes("connectors/test"))).toBe(true));
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("connectors/test"))!;
    const body = JSON.parse(String((call[1] as RequestInit).body)) as { values: Record<string, string>; id: string };
    expect(body.id).toBe(mockStorageConnector.id);
    expect(body.values.protocol).toBe("s3");
    expect(body.values.username).toBe("");
    expect(body.values.password).toBe("");
    expect(await screen.findByText("Everything checks out")).toBeInTheDocument();
  });

  it("picking a host fills the server in for each protocol", () => {
    const host = apiMocks["GET /api/hosts"][0]!;
    expect(prefillFor("nfs", host)).toEqual({ url: `nfs://${host.address}:/volume1/backups` });
    expect(prefillFor("smb", host)).toEqual({ url: `cifs://${host.address}/` });
    expect(prefillFor("s3", host)).toEqual({ endpoint: `https://${host.address}:9000` });
    expect(prefillFor("nfs", { ...host, address: "fd00::5", backupTargetPaths: [] })).toEqual({
      url: "nfs://[fd00::5]:/",
    });
  });
});
