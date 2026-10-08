import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChannelRequest } from "@contracts/notify";
import { stubApi } from "../../../ui/deploy/__tests__/stubApi";
import { renderWithApp } from "../../../test-utils";
import { ChannelForm } from "../ChannelForm";

describe("ChannelForm", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers a self-hosted ntfy beside the public server, with a deploy when the cluster has none", async () => {
    stubApi();
    const user = userEvent.setup();
    const submitted: ChannelRequest[] = [];
    renderWithApp(
      <ChannelForm
        onSubmit={async (req) => {
          submitted.push(req);
        }}
        onCancel={() => {}}
      />
    );
    expect(screen.getByLabelText("Server")).toHaveValue("https://ntfy.sh");
    await user.click(screen.getByText("Self-hosted ntfy"));
    expect(await screen.findByRole("button", { name: "Deploy ntfy" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Server"), "https://ntfy.example.test");
    await user.type(screen.getByLabelText(/Name/), "Phone");
    await user.type(screen.getByLabelText(/Topic/), "alerts");
    await user.click(screen.getByRole("button", { name: "Add channel" }));
    expect(submitted[0]).toMatchObject({
      kind: "ntfy",
      config: { server: "https://ntfy.example.test", topic: "alerts" },
    });
  });
});
