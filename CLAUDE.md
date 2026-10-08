# Working rules (set by Daniel, 2026-10-07)

Every build thread follows these. They come before anything else in this file.

1. **Contracts first.** Before any worker thread starts, the coordinating session makes sure the contract it builds against exists: data types, API signatures and mock return values. Workers build strictly to that interface and never mutate shared dependencies (see **Ownership** below).
2. **Summary payloads only.** A worker reports back a concise deliverable, never its conversation: the PR link and diff summary, test results (command and pass/fail counts), and any unresolved blockers. Nothing else goes back to the coordinating session.
3. **Escalate, don't hallucinate.** If an interface is missing, a mock doesn't match what the code needs, or two assumptions conflict, the worker halts and returns the blocker (what is missing or conflicting, where, and what it would need) instead of guessing or working around it.
4. **The product name lives only in `product.json`.** Never hardcode it. Environment variables carry no product prefix.
5. **One branch and one PR per chunk.** Touch only the paths the chunk owns.

The plan these chunks come from is `/mnt/project-files/product-plan/mvp-build-plan.md` in the project's shared files (not in this repo); the v0.1.x W chunks come from `/mnt/project-files/product-plan/v0.1.x-wizard-plan.md`.

# What this is

A self-hosted Kubernetes console whose first job is answering "is everything healthy and recoverable?": one health board over cluster, storage, backups, GitOps, hosts and HTTP checks; a backup posture page per PVC; node, container and host metrics with history; a read-only workload browser; notifications. Milestone A is read-only in the cluster. Milestone B adds connectors (Cloudflare, Entra ID), templates and publishing.

It is installed by other people into their own clusters, so **nothing install-specific belongs in the app or the chart**: hostnames, identity providers, ingress, registries go in an install's values, never in defaults.

Stack: Node 22, Express 4, TypeScript (ESM, `nodenext`), better-sqlite3 in WAL mode, zod, `@kubernetes/client-node` 2.x, Mantine 9 + `@mantine/charts`, React 19, react-router 7 (HashRouter), Vite.

# Layout

```
product.json            the product's name and every name derived from it (only place it appears)
src/index.ts            entrypoint: .env, config, DB, runtime, app, signals
src/app.ts              Express app: probes, platform, /api/system, module routers
src/product.ts          the server's only reader of product.json
src/runtime/            DB, migrations runner, event bus, scheduler, registries, services, module context
src/contracts/          every shared type, API route and service interface
src/contracts/mocks/    a mock for every contract (fake ModuleContext, fake K8sApi, API responses, ...)
src/platform/           auth, settings, secrets, audit, drain
src/modules/<id>/       one folder per module: index.ts (register) + migrations.ts
client/src/ui/          shared UI components; contracts.ts is the UI contract
client/src/ui/mocks/    mock API responses and a mock useSeries for building pages early
client/src/modules/<n>/ one folder per client module: index.tsx exports navItems and routes
client/src/shell/       app shell (S3)
test/runtime/           runtime and guard tests (S1)
test/support/, test/fixtures/   harness and fixtures (S5)
scripts/                brand tooling, fixture capture
```

# Ownership

Each chunk may create or edit only its own paths. Everything else is read-only to it. A change anywhere else is a blocker to raise (rule 3), not a change to make.

| Chunk | Owns |
|---|---|
| S1 skeleton | repo root files, `src/app.ts`, `src/index.ts`, `src/product.ts`, `src/runtime/`, `src/contracts/`, `src/modules/index.ts` and the module stubs as created, `client/src/ui/contracts.ts`, `client/src/ui/mocks/`, `test/runtime/`, `scripts/brand*.mjs`, `.github/workflows/test.yml`, `CLAUDE.md`, `LICENSE` |
| S2 platform | `src/platform/`, `test/platform/` |
| S3 client shell + shared UI | `client/` except `client/src/modules/*/` beyond their stubs and except `client/src/ui/contracts.ts` |
| S4 chart, image, deploy | `chart/`, `Dockerfile`, `.dockerignore`, `.github/workflows/` except `test.yml`, `docs/install.md`, `deploy/examples/` |
| S5 test harness + fixtures | `test/support/`, `test/fixtures/`, `scripts/capture-fixtures.sh` |
| A1 k8s | `src/modules/k8s/` |
| A2 health | `src/modules/health/`, `client/src/modules/health/` |
| A3 metrics | `src/modules/metrics/` |
| A4 notify | `src/modules/notify/`, `client/src/modules/notify/` |
| A5 cluster | `src/modules/cluster/` |
| A6 longhorn | `src/modules/longhorn/` |
| A7 velero | `src/modules/velero/` |
| A8 fleet | `src/modules/fleet/` |
| A9 hosts | `src/modules/hosts/`, `client/src/modules/hosts/` |
| A10 checks | `src/modules/checks/`, `client/src/modules/checks/` |
| A11 metrics-k8s | `src/modules/metrics-k8s/`, `client/src/modules/nodes/` |
| A12 backups | `src/modules/backups/`, `client/src/modules/backups/` |
| A13 workloads | `src/modules/workloads/`, `client/src/modules/workloads/` |
| A14 first run + docs | `src/modules/onboarding/`, `client/src/modules/onboarding/`, `docs/` |
| A15 installer | `install.sh`, `scripts/install/`, `.github/workflows/install-test.yml` |
| W1 catalog | `src/modules/catalog/` |
| W2 deploy | `src/modules/deploy/` |
| W3 k8s writes | `src/modules/k8s/` |
| W4 deploy opt-in | `chart/templates/deploy-*.yaml`, the `deploy:` key in `chart/values.yaml`, `install.sh`, `docs/install.md` |
| W5 deploy UI | `client/src/ui/deploy/`, `client/src/modules/apps/` |
| W6 wizard deploy | `client/src/modules/onboarding/` except `steps/HostsStep.tsx` |
| W7 host key pair | `src/modules/hosts/`, `client/src/modules/hosts/`, `client/src/modules/onboarding/steps/HostsStep.tsx` |
| M1 tokens + MCP | `src/modules/mcp/`, `client/src/modules/mcp/`, API tokens and the MCP OAuth server in `src/platform/` (`auth/tokens.ts`, `auth/oauth.ts`, `routes/oauth.ts`, their admin routes and the bearer path in identity), `client/src/shell/oauth/`, custom links in `src/modules/health/`, `client/src/shell/admin/TokensPage.tsx`, `docs/mcp.md` |
| B1 connectors | `src/modules/connectors/`, `client/src/modules/connectors/`, `src/contracts/connectors.ts`, `src/contracts/mocks/connectors/` |
| Every module chunk (A1–A15, W1–W7, B1–B5) | also `test/modules/<id>/` for its module's tests |
| B2–B5 | their own `src/modules/<id>/` and `client/src/modules/<id>/`, plus the chart files the plan names |

**Shared dependencies no worker mutates:** `package.json` and `package-lock.json` (both root and `client/`), `src/contracts/`, `src/runtime/`, `src/app.ts`, `src/modules/index.ts`, `client/src/ui/` (S3 aside), `chart/values.yaml` (S4 aside), `test/support/` (S5 aside). Every dependency Milestone A is known to need is already installed. Needing a new dependency, contract field, route, event, service or shared helper is a blocker for the coordinating session, which changes contracts in their own small PR.

# How a module plugs in

A module is `src/modules/<id>/index.ts` default-exporting a `Module` (`src/contracts/module.ts`): `{ id, milestone, migrations, register(ctx) }`. The runtime applies its migrations, then calls `register` with a `ModuleContext`:

- **Routes**: `ctx.route("GET /api/<id>/...", handler)` binds a route from `src/contracts/api.ts` with typed params, query, body and response. Return the body for a 200 JSON response, or write to `res` yourself and return `undefined`. Throw `HttpError` (`src/runtime/http.ts`) for an error status. A module can only bind paths under `/api/<id>`; every route in `ApiRoutes` belongs to exactly one module. Every request reaching a module router has an identity; `ctx.require(req, res, "write")` answers 403 for you.
- **Providers register into context registries**, never by editing another module: `ctx.health.addProvider(...)`, `ctx.metrics.addCollector(...)`, `ctx.metrics.write(...)`, `ctx.backups.addSource(...)`, `ctx.backups.addCapacity(...)`. The consuming module (`health`, `metrics`, `backups`) uses `subscribe`, which replays providers added before it, so load order between them doesn't matter.
- **Calling another module's routes**: `ctx.call(req, "GET /api/checks", { params, query, body })` makes the request in-process as the caller of `req` (a single-use ticket from `Platform.vouch`), through the same auth, permissions and audit, and resolves to the typed response or rejects with an `HttpError`. The MCP module is built on this. JSON routes only.
- **Cross-module services** go through `ctx.services`: `k8s` provides the `K8sApi` (`src/contracts/k8s.ts`) with `ctx.services.provide("k8s", ...)`; everyone else calls `ctx.services.get("k8s")` when they need it (inside `collect()`, not at register time). Never import another module's files.
- **Events**: `ctx.bus.on/emit`, names and payloads in `src/contracts/events.ts`. Handlers run after `emit` returns and one failing handler never affects another.
- **Scheduled work**: `ctx.scheduler.every(name, intervalMs, fn)`. Jitter, timeout (the `AbortSignal` passed to `fn` fires), no overlap, heartbeat; a throw is recorded, never raised. Status at `GET /api/system/jobs`.
- **Settings**: `ctx.settings.declare({ key: "<id>.<name>", schema, default, env?, envOnly? })`; read with `.get()` every time, never cached.
- **Secrets**: `ctx.secrets` with scope `<id>` or `<id>:<sub>`; anything else is refused. Never return a secret from an API; report `hasSecret`.
- **Audit**: `ctx.audit.record({ actor, action: "<id>.<verb>", target, detail })` for every change a user makes.
- **K8s reads**: `K8sApi.list/get/watch` return `"absent"` when the API group isn't served (CRD not installed). Treat that as status `absent`, never as an error.

# Database rules

- Migrations live in `src/modules/<id>/migrations.ts`, numbered 1, 2, 3 … and recorded in `schema_migrations(module, version)`. Never edit or renumber one that has been merged.
- **Additive only.** During a rollout the old pod runs against the new schema for a few seconds. No `DROP`, no `RENAME`; add columns with defaults. `test/runtime/schema.test.ts` fails on a destructive migration.
- **Every table has `org_id TEXT NOT NULL DEFAULT 'default' REFERENCES orgs(id)`** (tenancy A today, multi-org later). Write `ctx.orgId` into it. The schema test fails on a table without it.
- **Table names start with the module id**, dashes as underscores: `health_check_results`, `metrics_k8s_...`. Also enforced by the schema test. The platform keeps code-console's table names.

# Naming

The product's name, image, chart, namespace, cookie prefix, DB file and ownership markers are in `product.json` and nowhere else. The server reads it through `src/product.ts`, the client through `client/src/product.ts`. Files that must carry a name (Chart.yaml, values.yaml, install.sh) mark the line `# brand:generated <field>` and `npm run brand` writes the value; `<field>` is any string field of `product.json` or `imageRepository`. `npm run brand:check` (in CI) fails on the literal anywhere else except `*.md` and `docs/`. A rename is: edit `product.json`, move the old `ownerMarker` into `legacyOwnerMarkers`, `npm run brand`, commit.

Objects written into a cluster are labelled `app.kubernetes.io/managed-by: <ownerMarker.labelDomain>`; ownership checks accept legacy markers too.

# Contracts and mocks

`src/contracts/` is the interface between chunks: domain types, `ModuleContext`, `K8sApi`, the platform interfaces, and `ApiRoutes`, the full HTTP API with request and response types. `src/contracts/mocks/` has a mock for each: `createMockContext(moduleId)` (a real context over in-memory SQLite, with inspectable audit, samples and secrets, and an Express app for HTTP tests), `createFakeK8s()` with `mockClusterObjects()`, check results in every status, mock providers, deterministic series, backup volumes covering protected / stale / failing / never-run / unprotected, and `apiMocks`, a response for every route (its type makes a missing one a compile error). Mock timestamps are relative to the fixed `MOCK_NOW`.

The client's UI contract is `client/src/ui/contracts.ts`: `TileProps`, `StatusBadgeProps`, `CheckListProps`, `TimeSeriesChartProps`, `SparklineProps`, `UseSeries`, and the client module shape (`navItems`, `routes`). The client imports server contract types through the `@contracts/*` alias; files it imports must stay free of Node and Express imports. `client/src/ui/mocks/` re-exports `apiMocks` with `mockFetch(key)` and a `useMockSeries`.

If what you are building needs something the contract doesn't have, stop and raise it (rule 3).

# Commands

```
npm ci && npm --prefix client ci
npm run dev                 # server on :8080 with the dev identity bypass, via tsx watch
npm --prefix client run dev # Vite on :5173, proxying /api and /auth to :8080
npm run check               # lint, format:check, typecheck (server, tests, client), tests, brand:check
npm test                    # node --test over test/**/*.test.ts
npm run test:client         # Vitest + Testing Library (jsdom) over client/src/**/__tests__/*.test.{ts,tsx}
npm run build && npm run build:client   # dist/ and public/
npm start                   # node dist/index.js, serving public/
```

`client/tsconfig.json` is a solution file with `"files": []`, so `tsc --noEmit -p client` checks nothing and passes; use `npm run typecheck:client`, which checks `tsconfig.app.json`.

`product.json` is read at runtime from one directory above `dist/`, so the image must ship it beside `dist/`.

# Conventions

- Comments explain mechanism only (the why when it isn't obvious: a hidden constraint, a workaround, an invariant). Never narrate what the code does or reference the task, chunk or PR; that belongs in commit messages and PR descriptions.
- Mantine is the only UI library. Theme is `client/src/theme.ts`, applied once in `App.tsx`: dark default, `cyan` primary, `xs` radius, `"Geist Variable"` self-hosted via `@fontsource-variable/geist`.
- Vite `base` is `"./"`, API calls use paths relative to `document.baseURI` (`new URL("api/...", document.baseURI)`), and the router is `HashRouter`: the app may be served under a path prefix.
- Prefer small, additive, reversible changes. Verify before declaring done: run the thing, curl the route, read back the file.
- One credential per consumer; never reuse one across unrelated services.
- Show the raw data on failure: every `CheckResult` has a `detail` whether it passes or fails, and `raw` when it fails.
- Exec and SSH command lines come only from fixed templates in code, never from request input.
- Client tests sit beside the code they cover, in `client/src/<dir>/__tests__/*.test.tsx`, so each is owned by the chunk that owns that directory (`client/src/modules/<n>/` by its module chunk, `client/src/ui/` and `client/src/shell/` by S3). Use `renderWithApp` from `client/src/test-utils.tsx`; for API-backed pages stub `fetch` with `apiMocks` responses or install the shell's mock server. `client/vitest.config.ts` and `client/src/test-setup.ts` belong to S3.
- Tests that need cluster objects use fixtures (env stripped) and `createFakeK8s`, not a live cluster.

# Lessons carried over from game-panel

- better-sqlite3 has no musl prebuild: the runtime image must be Debian-based, not Alpine.
- In client-node 1.x, `Log.log()` never called its done callback; the end of a log was detected on the stream passed in (`finish`). This repo is on 2.x, where that has not been re-verified: check before relying on either behaviour.
- Two pods overlap during every rollout: anything one starts (helper pods, scheduled runs) must be labelled with its owner and safe for the other to see; in-memory state (rate limits, locks, log followers) is per pod by design, durable state lives in the DB or volume.

# The platform

`src/platform/` is sign-in, settings, secrets, audit and drain, behind the `createPlatform: CreatePlatform` export (`src/contracts/platform.ts`). Modules see only the contract's `User`, `SettingsRegistry`, `SecretStore` and `AuditLog` through their context; nothing under `src/platform/` is imported by a module. It follows code-console's design and keeps its table names (`users`, `sessions`, `settings`, `secrets`, `audit_log`, ...).

- **Sign-in**: local accounts (scrypt, throttled per username and address) and any OIDC provider (code flow with PKCE, callback `<public URL>/auth/oidc/callback`; the public URL is the `site.publicUrl` setting, which `PUBLIC_ORIGIN` overrides), with optional TOTP and single-use recovery codes. Sessions are random cookies stored hashed, named from product.json. First boot creates `admin` from `BOOTSTRAP_ADMIN_PASSWORD`, which must be changed at first sign-in; until then, and until a required authenticator is enrolled, `/api` answers 403 outside `/api/me` and `/api/auth/*`.
- **Authorization** is tenancy A: anyone signed in may read, admins may write and administer. An API token (Admin > API tokens, `Authorization: Bearer`) acts as the admin who made it, capped by its scope (`read` or `write`), on `/api` and `/mcp` but never on `/api/admin` or `/api/auth`. Admins are an account's role, members of `auth.oidc.adminGroups` while signed in through OIDC, and anyone named in `ADMIN_USERS` / `ADMIN_GROUPS`.
- **Settings**: effective value is the admin UI's override, else the env var, else the default. Bootstrap and security variables (`TRUSTED_PROXIES`, `CLIENT_IP_HEADER`, `SECRETS_KEY`, `ADMIN_*`, ...) are env-only and shown read-only.
- **Secrets** are sealed in the database with `SECRETS_KEY`; without it nothing can be stored or read back.
- **Audit** goes to `audit_log` and is readable in the admin API; a failed audit write never fails the request.
- **Drain**: SIGTERM turns `/healthz` into 503, refuses mutations with 503 and waits for in-flight requests up to `DRAIN_MS`. A second SIGINT exits at once.
- **Dev bypass**: `DEV_AUTH=1` with `NODE_ENV` not `production` signs every request in as a built-in admin and logs a banner. The image sets production.
- **Break-glass**: `node dist/platform/cli.js reset-admin [username]` inside the pod resets the password and authenticator, clears network rules and re-enables password sign-in.
- **Tests** put an identity on a request through `PlatformDeps.identify`; the server entrypoint never passes it.

# Fixtures from a real cluster

`scripts/capture-fixtures.sh` dumps the object kinds Milestone A reads, using only `kubectl get`, with Secrets and ConfigMaps never fetched and env values, command/args, non-ownership annotations, Fleet bundle contents and URL credentials stripped. It writes `fixtures-<timestamp>.tar.gz`. Hostnames, IPs and names remain, so the archive is reviewed before any of it is committed under `test/fixtures/`.
