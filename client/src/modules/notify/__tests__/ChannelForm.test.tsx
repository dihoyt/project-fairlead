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

  it("builds an SMTP email channel from a preset", async () => {
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
    await user.click(screen.getByText("Email"));
    expect(screen.getByLabelText(/SMTP server/)).toHaveValue("smtp.gmail.com");
    expect(screen.getByText(/2-Step Verification/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Name/), "Mail");
    await user.type(screen.getByLabelText(/^Username/), "alerts@example.com");
    await user.type(screen.getByLabelText(/app password/), "abcd efgh ijkl mnop");
    await user.type(screen.getByLabelText(/^From/), "alerts@example.com");
    await user.type(screen.getByRole("combobox", { name: /^To/ }), "ops@example.com{enter}");
    await user.click(screen.getByRole("button", { name: "Add channel" }));
    expect(submitted[0]).toMatchObject({
      kind: "email",
      secret: "abcd efgh ijkl mnop",
      config: {
        email: {
          preset: "gmail",
          host: "smtp.gmail.com",
          port: 587,
          security: "starttls",
          username: "alerts@example.com",
          from: "alerts@example.com",
          to: ["ops@example.com"],
        },
      },
    });
  });

  it("a sign-in preset takes the sign-in client's id and shows the redirect URI", async () => {
    stubApi();
    const user = userEvent.setup();
    renderWithApp(<ChannelForm onSubmit={async () => {}} onCancel={() => {}} />);
    await user.click(screen.getByText("Email"));
    await user.click(screen.getByRole("combobox", { name: "Send with" }));
    await user.click(await screen.findByText("Sign in with Google (Gmail)"));
    expect(screen.getByLabelText(/OAuth client ID/)).toHaveValue("1234-abc.apps.googleusercontent.com");
    expect(await screen.findByText("https://console.example.com/api/notify/oauth/callback")).toBeInTheDocument();
    expect(screen.getByLabelText(/Client secret/)).toBeRequired();
    expect(screen.queryByLabelText(/SMTP server/)).not.toBeInTheDocument();
  });
});
