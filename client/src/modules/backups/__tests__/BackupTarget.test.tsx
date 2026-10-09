import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PostureRow } from "@contracts/backups";
import {
  mockBackupSchedulesUnset,
  mockBackupTargetUnavailable,
  mockBackupTargetUnset,
  mockBackupTargetView,
} from "@contracts/mocks/backups";
import { mockRestorePlan } from "@contracts/mocks/catalog";
import { apiMocks } from "../../../ui/mocks/api";
import { stubApi, stubEventSource } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { BackupTargetCard } from "../BackupTarget";
import { SchedulesCard } from "../Schedules";
import { VolumeActions } from "../VolumeActions";

const row: PostureRow = {
  ...apiMocks["GET /api/backups/posture"].rows[0]!,
  pvc: { namespace: "apps", name: "postgres-data", uid: "uid-pg" },
  groups: ["default"],
};

describe("Backups set-up", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers to set a target when Longhorn has none, and sets the picked one", async () => {
    const { calls } = stubApi();
    stubEventSource();
    renderWithApp(<BackupTargetCard target={mockBackupTargetUnset} canEdit onChanged={() => {}} />);
    expect(screen.getByText("not set")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set backup target" }));
    expect(await screen.findByText("nfs://nas.example.test:/volume1/backups/cluster/")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set target" }));
    await waitFor(() => expect(calls.some((c) => c.key === "PUT /api/backups/target")).toBe(true));
    expect(calls.find((c) => c.key === "PUT /api/backups/target")!.body).toEqual({ connectorId: "cn_st1" });
  });

  it("shows Longhorn's reason when the target is unreachable, and nothing to change for readers", () => {
    stubApi();
    renderWithApp(<BackupTargetCard target={mockBackupTargetUnavailable} canEdit={false} onChanged={() => {}} />);
    expect(screen.getByText("unreachable")).toBeInTheDocument();
    expect(screen.getByText(/access denied by server/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change target" })).toBeNull();
  });

  it("stays out of the way without Longhorn", () => {
    renderWithApp(<BackupTargetCard target={{ url: "", longhorn: "absent" }} canEdit onChanged={() => {}} />);
    expect(screen.queryByText("Backup target")).toBeNull();
    expect(mockBackupTargetView.available).toBe(true);
  });

  it("suggests the default schedules and saves them as a whole set", async () => {
    const { calls } = stubApi({ "GET /api/backups/schedules": mockBackupSchedulesUnset });
    stubEventSource();
    renderWithApp(<SchedulesCard canEdit onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up schedules" }));
    expect(await screen.findAllByLabelText("Group")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Save schedules" }));
    await waitFor(() => expect(calls.some((c) => c.key === "PUT /api/backups/schedules")).toBe(true));
    expect(calls.find((c) => c.key === "PUT /api/backups/schedules")!.body).toEqual({
      schedules: mockBackupSchedulesUnset.suggested,
    });
  });

  it("previews a restore to a new claim before it runs", async () => {
    const { calls } = stubApi();
    stubEventSource();
    renderWithApp(<VolumeActions row={row} schedules={[]} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Backup actions for apps/postgres-data" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore…" }));
    const group = await screen.findByRole("radiogroup", { name: "Restore point" });
    const points = within(group).getAllByRole("radio");
    expect(points).toHaveLength(2);
    fireEvent.click(points[0]!);
    expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText(mockRestorePlan.warnings[0]!)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/backups/restore")).toBe(true));
    expect(calls.find((c) => c.key === "POST /api/backups/restore")!.body).toEqual({
      uid: "uid-pg",
      backupId: "backup-6f1c2a",
      mode: "new-pvc",
    });
  });

  it("offers nothing for a volume that isn't on Longhorn", () => {
    renderWithApp(<VolumeActions row={{ ...row, groups: undefined }} schedules={[]} onChanged={() => {}} />);
    expect(screen.queryByRole("button", { name: /Backup actions/ })).toBeNull();
  });
});
