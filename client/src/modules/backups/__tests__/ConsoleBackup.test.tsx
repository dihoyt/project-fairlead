import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { mockConsoleBackup, mockConsoleBackupLonghorn } from "@contracts/mocks/catalog";
import { mockMe } from "@contracts/mocks/api";
import { stubApi, stubEventSource } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { ConsoleBackupCard } from "../ConsoleBackup";

describe("This console", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the newest copy and how to reinstall from it", async () => {
    stubApi();
    renderWithApp(<ConsoleBackupCard me={mockMe} onChanged={() => {}} />);
    expect(await screen.findByText(/Newest copy: console-20261008T033000Z\.db/)).toBeInTheDocument();
    expect(screen.getByText(mockConsoleBackup.restoreCommand)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to the critical group" })).toBeNull();
  });

  it("offers the critical group for a Longhorn volume outside it", async () => {
    const { calls } = stubApi({
      "GET /api/backups/console": { ...mockConsoleBackupLonghorn, groups: ["default"] },
    });
    stubEventSource();
    renderWithApp(<ConsoleBackupCard me={mockMe} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to the critical group" }));
    await waitFor(() => expect(calls.some((c) => c.key === "PUT /api/backups/volumes/:uid/groups")).toBe(true));
    expect(calls.find((c) => c.key === "PUT /api/backups/volumes/:uid/groups")!.body).toEqual({
      groups: ["default", "critical"],
    });
  });

  it("downloads the kit once the passphrase matches and the password is given", async () => {
    const { calls } = stubApi({ "GET /api/auth/totp/status": { enabled: false, recoveryCodesLeft: 0 } });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:kit", revokeObjectURL: () => {} }));
    renderWithApp(<ConsoleBackupCard me={mockMe} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Download recovery kit" }));
    const download = await screen.findByRole("button", { name: "Download" });
    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "a long kit passphrase" } });
    fireEvent.change(screen.getByLabelText("Passphrase again"), { target: { value: "a long kit passphrase" } });
    expect(download).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "hunter2hunter2" } });
    expect(download).toBeEnabled();
    fireEvent.click(download);
    await waitFor(() => expect(calls.some((c) => c.key === "POST /api/admin/recovery-kit")).toBe(true));
    expect(calls.find((c) => c.key === "POST /api/admin/recovery-kit")!.body).toEqual({
      passphrase: "a long kit passphrase",
      password: "hunter2hunter2",
    });
  });
});
