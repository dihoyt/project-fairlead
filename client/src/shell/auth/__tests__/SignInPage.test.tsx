import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiMocks } from "../../../ui/mocks/api";
import { renderWithApp } from "../../../test-utils";
import { SignInPage } from "../SignInPage";

// The mock server keeps its state at module level, so each test loads a
// fresh copy; its fetch replacement is what the page talks to.
async function setup(username: string, password = "pw") {
  vi.resetModules();
  sessionStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { installMockServer } = await import("../../mock/mockServer");
  installMockServer();
  const onSignedIn = vi.fn();
  const user = userEvent.setup();
  renderWithApp(
    <SignInPage
      methods={{ ...apiMocks["GET /api/auth/methods"], password: true, oidc: null }}
      reason={null}
      onSignedIn={onSignedIn}
    />
  );
  await user.type(screen.getByLabelText(/username/i), username);
  await user.type(screen.getByLabelText("Password", { exact: false, selector: "input" }), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return { user, onSignedIn };
}

describe("SignInPage against the mock API", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("signs in with a password", async () => {
    const { onSignedIn } = await setup("admin");
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
  });

  it("shows the server's message for a wrong password", async () => {
    const { onSignedIn } = await setup("admin", "wrong");
    expect(await screen.findByText("Wrong username or password.")).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("asks for an authenticator code and accepts a recovery code", async () => {
    const { user, onSignedIn } = await setup("totp");
    await screen.findByText(/six-digit code/i);

    await user.click(screen.getByRole("button", { name: /use a recovery code/i }));
    await user.type(screen.getByLabelText(/recovery code/i), "abcd-1234");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
  });

  it("refuses a bad recovery code and stays on the code step", async () => {
    const { user, onSignedIn } = await setup("totp");
    await screen.findByText(/six-digit code/i);

    await user.click(screen.getByRole("button", { name: /use a recovery code/i }));
    await user.type(screen.getByLabelText(/recovery code/i), "wrong");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByText("That code is not valid.")).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("only enables Verify for a full six-digit code", async () => {
    const { user } = await setup("totp");
    const verify = await screen.findByRole("button", { name: "Verify" });
    expect(verify).toBeDisabled();
    await user.type(screen.getByLabelText(/^code/i), "12a345");
    expect(verify).toBeDisabled();
    await user.type(screen.getByLabelText(/^code/i), "6");
    expect(verify).toBeEnabled();
  });
});
