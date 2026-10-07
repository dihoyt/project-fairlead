// A stand-in for the server, for working on the client with no server
// running: `VITE_MOCK_API=1 npm --prefix client run dev`. Answers every
// route in the contract from its mock, plus just enough state to walk the
// sign-in flows. Never part of a production build (see main.tsx).
//
// Sign in as anything to be an admin. Special usernames: "user" (not an
// admin), "temp" (must change password), "totp" (asks for a code; 000000, or
// the recovery code "wrong", is refused). Password "wrong" is refused.
import type { RouteKey } from "@contracts/api";
import type { Me, UserView } from "@contracts/auth";
import type { SeriesQuery } from "@contracts/metrics";
import { mockSeries } from "@contracts/mocks/metrics";
import { apiMocks, mockResponse } from "../../ui/mocks/api";

interface MockState {
  signedIn: boolean;
  username: string;
  mustChangePassword: boolean;
  pending: string | null;
}

const STORE = "mock-api-state";

function load(): MockState {
  try {
    const saved = sessionStorage.getItem(STORE);
    if (saved) return JSON.parse(saved) as MockState;
  } catch {
    // Storage unavailable: start signed out.
  }
  return { signedIn: false, username: "admin", mustChangePassword: false, pending: null };
}

let state = load();
const save = () => {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    // Not persisted; the session lasts until reload.
  }
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const routes = (Object.keys(apiMocks) as RouteKey[]).map((key) => {
  const [method, path] = key.split(" ") as [string, string];
  const pattern = new RegExp(`^${path.replace(/[.]/g, "\\.").replace(/:[A-Za-z]+/g, "[^/]+")}$`);
  return { key, method, pattern };
});

function me(): Me {
  const base = apiMocks["GET /api/me"];
  return {
    ...base,
    id: state.username,
    name: state.username === "admin" ? base.name : state.username,
    admin: state.username !== "user",
    mustChangePassword: state.mustChangePassword,
  };
}

function handle(key: RouteKey, url: URL, body: unknown): unknown {
  const open =
    key === "GET /api/auth/methods" || key.startsWith("POST /api/auth/login") || key.includes("/totp/verify");
  if (!open && !state.signedIn) throw new HttpError(401, "Not signed in.");

  switch (key) {
    case "GET /api/me":
      return me();
    case "POST /api/auth/login": {
      const { username, password } = body as { username: string; password: string };
      if (password === "wrong") throw new HttpError(401, "Wrong username or password.");
      if (username === "totp") {
        state = { ...state, username, pending: "pending-token" };
        save();
        return { totpRequired: true, pending: "pending-token" };
      }
      state = { signedIn: true, username, mustChangePassword: username === "temp", pending: null };
      save();
      return { mustChangePassword: state.mustChangePassword };
    }
    case "POST /api/auth/totp/verify": {
      const { pending, code, recoveryCode } = body as { pending: string; code?: string; recoveryCode?: string };
      if (pending !== state.pending) throw new HttpError(401, "The sign-in expired. Enter your password again.");
      if (code === "000000" || recoveryCode === "wrong") throw new HttpError(401, "That code is not valid.");
      state = { ...state, signedIn: true, pending: null };
      save();
      return { mustChangePassword: false };
    }
    case "POST /api/auth/logout":
      state = { ...state, signedIn: false, pending: null };
      save();
      return { ok: true };
    case "POST /api/auth/password":
      state = { ...state, mustChangePassword: false };
      save();
      return { ok: true };
    case "GET /api/metrics/query": {
      const queries = JSON.parse(url.searchParams.get("q") ?? "[]") as SeriesQuery[];
      return queries.flatMap((q) => mockSeries(q));
    }
    case "GET /api/admin/users": {
      const users = mockResponse(key);
      const extra: UserView = {
        ...users[0]!,
        id: 2,
        username: "ops",
        displayName: "",
        email: "ops@example.test",
        role: "user",
        hasPassword: false,
        identities: [
          {
            provider: "https://login.example.test/v2.0",
            subject: "a1b2",
            email: "ops@example.test",
            createdAt: users[0]!.createdAt,
            lastUsedAt: null,
          },
        ],
      };
      return [...users, extra];
    }
    default:
      return mockResponse(key);
  }
}

export function installMockServer(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), document.baseURI);
    const base = new URL(document.baseURI);
    const dir = base.pathname.replace(/[^/]*$/, "");
    // The route path as the server would see it under any path prefix.
    const relative =
      url.origin === base.origin && url.pathname.startsWith(dir) ? `/${url.pathname.slice(dir.length)}` : "";
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const route = routes.find((r) => r.method === method && r.pattern.test(relative));
    if (!route) {
      if (relative.startsWith("/api/")) return json(404, { error: `No mock for ${method} ${relative}` });
      return realFetch(input, init);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    try {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      const result = handle(route.key, url, body);
      if (typeof result === "string") {
        return new Response(result, { status: 200, headers: { "Content-Type": "text/csv" } });
      }
      return json(200, result);
    } catch (err) {
      return err instanceof HttpError ? json(err.status, { error: err.message }) : json(500, { error: String(err) });
    }
  };
  console.warn("Mock API: every /api request is answered in the browser from the contract's mocks.");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
