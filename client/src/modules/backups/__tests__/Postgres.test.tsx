import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { mockMe } from "@contracts/mocks/api";
import {
  mockPostgresClusterAbsent,
  mockPostgresClusterRestored,
  mockPostgresDumpBackups,
} from "@contracts/mocks/postgres";
import { stubApi, stubEventSource } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { PostgresCard, parseMoment } from "../Postgres";

describe("Shared Postgres", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is not shown without the shared cluster", async () => {
    const { calls } = stubApi({ "GET /api/postgres/cluster": mockPostgresClusterAbsent });
    renderWithApp(<PostgresCard me={mockMe} onChanged={() => {}} />);
    await waitFor(() => expect(calls.some((c) => c.key === "GET /api/postgres/cluster")).toBe(true));
    expect(screen.queryByText("Shared Postgres")).toBeNull();
  });

  it("shows the cluster, its databases and its point-in-time backups", async () => {
    stubApi();
    renderWithApp(<PostgresCard me={mockMe} onChanged={() => {}} />);
    expect(await screen.findByText("Shared Postgres")).toBeInTheDocument();
    expect(await screen.findByText(/^Databases: /)).toBeInTheDocument();
    expect(await screen.findByText(/WAL archived 40 seconds ago/)).toBeInTheDocument();
    expect(screen.getByText(/Restore to any moment since/)).toBeInTheDocument();
  });

  it("restores to a moment after reviewing the plan", async () => {
    const { calls } = stubApi();
    stubEventSource();
    renderWithApp(<PostgresCard me={mockMe} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore…" }));
    fireEvent.change(await screen.findByLabelText("Restore to (UTC)"), { target: { value: "2026-10-06 10:42" } });
    fireEvent.click(screen.getByRole("button", { name: "Review the restore" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/postgres/restore")).toBe(true));
    expect(calls.find((c) => c.key === "POST /api/postgres/restore/plan")!.body).toEqual({
      at: "2026-10-06T10:42:00.000Z",
    });
    expect(calls.find((c) => c.key === "POST /api/postgres/restore")!.body).toEqual({
      at: "2026-10-06T10:42:00.000Z",
    });
  });

  it("restores a dump picked from the list", async () => {
    const { calls } = stubApi({ "GET /api/postgres/backups": mockPostgresDumpBackups });
    stubEventSource();
    renderWithApp(<PostgresCard me={mockMe} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review the restore" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/postgres/restore/plan")).toBe(true));
    expect(calls.find((c) => c.key === "POST /api/postgres/restore/plan")!.body).toEqual({
      dumpId: mockPostgresDumpBackups.restorePoints[0]!.id,
    });
  });

  it("sets up backups to a storage target", async () => {
    const { calls } = stubApi();
    stubEventSource();
    renderWithApp(<PostgresCard me={mockMe} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change backups" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.key === "PUT /api/postgres/backups")).toBe(true));
    expect(calls.find((c) => c.key === "PUT /api/postgres/backups")!.body).toEqual({
      connectorId: "cn_st2",
      schedule: "0 2 * * *",
      retention: 14,
    });
  });

  it("offers to delete a cluster a restore replaced", async () => {
    stubApi({ "GET /api/postgres/cluster": mockPostgresClusterRestored });
    renderWithApp(<PostgresCard me={mockMe} onChanged={() => {}} />);
    expect(await screen.findByText(/console-postgres was replaced by a restore and is stopped/)).toBeInTheDocument();
    expect(screen.getByText("Delete it")).toBeInTheDocument();
  });

  it("reads a moment in UTC", () => {
    expect(parseMoment("2026-10-06 10:42")).toBe("2026-10-06T10:42:00.000Z");
    expect(parseMoment("2026-10-06T10:42:30")).toBe("2026-10-06T10:42:30.000Z");
    expect(parseMoment("yesterday")).toBeUndefined();
  });
});
