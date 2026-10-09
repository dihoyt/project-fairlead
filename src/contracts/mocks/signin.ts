import type { SignInOidcClient, SignInOidcView, SignInService } from "../platform.js";

export interface MockSignIn extends SignInService {
  // What oidc() answers; setOidcClient() writes into it.
  state: SignInOidcView;
  // The last secret set, which oidc() only reports as hasSecret.
  secret?: string;
  writes: Array<{ client: SignInOidcClient; actor: string }>;
  // seedAdminPassword() refuses (resolves false) once this is true.
  adminSignedIn: boolean;
  // The last password seedAdminPassword() set.
  adminPassword?: string;
  // setPublicUrl() refuses with this when set, as PUBLIC_ORIGIN makes the platform.
  publicUrlLocked?: string;
  publicUrl?: string;
}

// Services "signin" for module tests. Set state.blocked to make
// setOidcClient() refuse, as the platform does without a public URL or
// SECRETS_KEY.
export function createMockSignIn(state: Partial<SignInOidcView> = {}): MockSignIn {
  const mock: MockSignIn = {
    state: {
      enabled: false,
      issuer: "",
      clientId: "",
      hasSecret: false,
      redirectUri: "https://console.example.test/auth/oidc/callback",
      blocked: null,
      ...state,
    },
    writes: [],
    adminSignedIn: false,
    oidc: async () => structuredClone(mock.state),
    async setOidcClient(client, actor) {
      if (mock.state.blocked !== null) throw new Error(mock.state.blocked);
      mock.writes.push({ client: structuredClone(client), actor });
      mock.secret = client.clientSecret;
      mock.state.issuer = client.issuer;
      mock.state.clientId = client.clientId;
      mock.state.hasSecret = true;
      if (client.enabled !== undefined) mock.state.enabled = client.enabled;
    },
    async seedAdminPassword(password) {
      if (password.length < 10) throw new Error("Passwords must be at least 10 characters.");
      if (mock.adminSignedIn) return false;
      mock.adminPassword = password;
      return true;
    },
    async setPublicUrl(url) {
      if (mock.publicUrlLocked) throw new Error(mock.publicUrlLocked);
      if (!/^https?:\/\/[^/]/.test(url)) throw new Error("Public URL: must be an http or https URL.");
      mock.publicUrl = url.replace(/\/+$/, "");
      mock.state.redirectUri = `${mock.publicUrl}/auth/oidc/callback`;
    },
  };
  return mock;
}
