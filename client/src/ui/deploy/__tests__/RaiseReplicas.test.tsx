import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { mockReplicaAdviceOk } from "@contracts/mocks/backups";
import { mockReplicasJob } from "@contracts/mocks/catalog";
import { mockMe } from "@contracts/mocks/api";
import { apiMocks } from "../../mocks/api";
import { SessionContext } from "../../session";
import { renderWithApp } from "../../../test-utils";
import { RaiseReplicas } from "../RaiseReplicas";
import { stubApi, stubEventSource } from "./stubApi";

function asUser(ui: ReactElement, admin = true) {
  return renderWithApp(
    <SessionContext.Provider value={{ me: { ...mockMe, admin }, methods: null, refresh: () => undefined }}>
      {ui}
    </SessionContext.Provider>
  );
}

describe("RaiseReplicas", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers the raise, plans it with the existing volumes ticked, and follows the job", async () => {
    const { calls } = stubApi({ "GET /api/deploy/jobs/:id": mockReplicasJob });
    stubEventSource([]);
    asUser(<RaiseReplicas />);
    expect(await screen.findByText(/2 volumes have 1 replica; 2 nodes can hold 2\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Raise Longhorn replicas to 2" }));

    const tick = await screen.findByRole("checkbox", { name: /Also raise the 2 existing volumes below 2/ });
    expect(tick).toBeChecked();
    expect(await screen.findByText("Raise 2 existing volumes to 2 replicas")).toBeInTheDocument();
    expect(calls.find((c) => c.key === "POST /api/deploy/actions/plan")?.body).toEqual({
      kind: "longhorn-replicas",
      replicas: 2,
      existingVolumes: true,
    });

    fireEvent.click(tick);
    await waitFor(() =>
      expect(calls.filter((c) => c.key === "POST /api/deploy/actions/plan").at(-1)?.body).toMatchObject({
        existingVolumes: false,
      })
    );

    const run = await screen.findAllByRole("button", { name: "Raise Longhorn replicas to 2" });
    fireEvent.click(run.at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/deploy/actions/run")).toBe(true));
    expect(calls.find((c) => c.key === "POST /api/deploy/actions/run")?.body).toMatchObject({
      kind: "longhorn-replicas",
      existingVolumes: false,
    });
    expect(await screen.findByText("running")).toBeInTheDocument();
  });

  it("explains how to turn deploys on instead of planning", async () => {
    const { calls } = stubApi({
      "GET /api/deploy/status": { ...apiMocks["GET /api/deploy/status"], enabled: false, enableHint: "helm upgrade x" },
    });
    asUser(<RaiseReplicas />);
    fireEvent.click(await screen.findByRole("button", { name: "Raise Longhorn replicas to 2" }));
    expect(await screen.findByText("helm upgrade x")).toBeInTheDocument();
    expect(calls.some((c) => c.key === "POST /api/deploy/actions/plan")).toBe(false);
  });

  it("leaves the raise to admins, and shows nothing when nothing is below target", async () => {
    stubApi();
    const { unmount } = asUser(<RaiseReplicas />, false);
    expect(await screen.findByText("An admin can raise them.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Raise Longhorn/ })).toBeNull();
    unmount();

    const { calls } = stubApi({ "GET /api/longhorn/replicas": mockReplicaAdviceOk });
    asUser(<RaiseReplicas />);
    await waitFor(() => expect(calls.some((c) => c.key === "GET /api/longhorn/replicas")).toBe(true));
    expect(screen.queryByTestId("raise-replicas")).toBeNull();
  });
});
