// A mock response for every route in ApiRoutes; the ApiMocks type makes a
// missing one a compile error. Pure data, so the client can import it.
import type { ApiMocks, ApiRoutes } from "../api.js";
import type { ApiTokenView, Me, UserView } from "../auth.js";
import type { BackupPosture, PostureRow } from "../backups.js";
import type { CheckView } from "../checks.js";
import type { JoinLink, JoinStatus } from "../cluster.js";
import type { CategoryDetail, CheckResult, HealthBoard, HealthLinkView, HealthTile } from "../health.js";
import type { HostView } from "../hosts.js";
import type { ChannelView, EmailSetupView } from "../notify.js";
import type { OnboardingState } from "../onboarding.js";
import { mockSeedDone } from "./seed.js";
import type { PodView, WorkloadLinks } from "../workloads.js";
import {
  mockFailingVolume,
  mockNeverBackedUpVolume,
  mockProtectedVolume,
  mockPvcs,
  mockBackupSchedules,
  mockBackupTargetView,
  mockReplicaAdvice,
  mockRestorePoints,
  mockStaleVolume,
  mockTargets,
} from "./backups.js";
import {
  mockAccess,
  mockBundlePlan,
  mockBundleRun,
  mockBundleView,
  mockCatalogApps,
  mockDeployJob,
  mockDeployLog,
  mockDeployPlan,
  mockDeployStatus,
  mockDiscovery,
  mockFailedJob,
  mockGateStatus,
  mockHostKeypair,
  mockBackupNowJob,
  mockBackupRecurringJob,
  mockBackupTargetJob,
  mockReplicasJob,
  mockReplicasPlan,
  mockRestoreJob,
  mockRestorePlan,
  mockRunningJob,
  mockUpgradeReport,
  mockUpgradeRun,
  mockVolumeBackup,
} from "./catalog.js";
import {
  mockCloudflareConnector,
  mockCloudflareDiscovery,
  mockCloudflareHosts,
  mockCloudflareView,
  mockConnectorKinds,
  mockConnectors,
  mockEntraGroups,
  mockEntraSignIn,
  mockNfsTarget,
  mockStorageTargets,
} from "./connectors/views.js";
import { mockCheckResults } from "./health.js";
import { mockPortsView, mockTemplateJob, mockTemplatePlan, mockTemplatesView } from "./templates.js";
import { mockSeriesResults } from "./metrics.js";
import { mockNodeSummaries } from "./nodes.js";
import { mockClusterUsage, mockSpaceUsage } from "./workloads.js";
import { DAY, HOUR, MOCK_NOW, isoAgo } from "./time.js";

const now = new Date(MOCK_NOW).toISOString();
const zero = { ok: 0, warn: 0, crit: 0, unknown: 0, absent: 0 };

export const mockMe: Me = {
  id: "admin",
  name: "Admin",
  email: "admin@example.test",
  groups: ["platform-admins"],
  admin: true,
  source: "password",
  mustChangePassword: false,
  orgId: "default",
};

export const mockUser: UserView = {
  id: 1,
  username: "admin",
  displayName: "Admin",
  email: "admin@example.test",
  role: "admin",
  disabled: false,
  mustChangePassword: false,
  hasPassword: true,
  totpEnabled: false,
  allowedNetworks: [],
  createdAt: isoAgo(30 * DAY),
  lastLoginAt: isoAgo(HOUR),
  identities: [],
};

const tile = (
  category: HealthTile["category"],
  status: HealthTile["status"],
  summary: string,
  counts: Partial<typeof zero>,
  worst?: CheckResult
): HealthTile => ({
  category,
  status,
  summary,
  counts: { ...zero, ...counts },
  ...(worst ? { worst: { ...worst, providerId: category } } : {}),
});

export const mockHealthBoard: HealthBoard = {
  status: "crit",
  generatedAt: now,
  tiles: [
    tile("cluster", "crit", mockCheckResults.crit.detail, { ok: 6, warn: 1, crit: 1 }, mockCheckResults.crit),
    tile("storage", "ok", "All 12 volumes healthy", { ok: 12 }),
    tile("backups", "warn", "gitea/gitea-shared-storage last backed up 3 days ago", { ok: 2, warn: 1, crit: 2 }),
    tile("gitops", "ok", "4/4 GitRepos ready", { ok: 4 }),
    tile("hosts", "absent", "No hosts added", {}),
    tile("checks", "ok", "All 3 checks OK", { ok: 3 }),
  ],
};

export const mockCategoryDetail: CategoryDetail = {
  category: "cluster",
  status: "crit",
  links: [{ label: "Rancher", url: "https://rancher.example.test" }],
  providers: [
    {
      id: "cluster",
      label: "Cluster",
      category: "cluster",
      status: "crit",
      lastRunAt: isoAgo(30_000),
      results: [mockCheckResults.ok, mockCheckResults.warn, mockCheckResults.crit],
    },
  ],
};

const postureRow = (
  row: Omit<PostureRow, "coverage" | "protected"> & { coverage?: PostureRow["coverage"] }
): PostureRow => ({
  ...row,
  coverage: row.coverage ?? [],
  protected: (row.coverage ?? []).length > 0,
});

export const mockPosture: BackupPosture = {
  generatedAt: now,
  target: mockBackupTargetView,
  schedules: mockBackupSchedules.schedules,
  sources: [
    { id: "longhorn", label: "Longhorn", state: "ok", volumes: 3 },
    { id: "velero", label: "Velero", state: "ok", volumes: 1 },
  ],
  rows: [
    postureRow({
      pvc: { ...mockPvcs.scratch, sizeBytes: 5 * 2 ** 30, storageClass: "longhorn" },
      app: "Deployment/cache",
      ageStatus: "crit",
      ageDetail: "Not covered by any backup",
      status: "crit",
    }),
    postureRow({
      pvc: { ...mockPvcs.grafana, sizeBytes: 10 * 2 ** 30, storageClass: "longhorn" },
      app: "Deployment/grafana",
      coverage: [mockFailingVolume],
      lastGood: { ...mockFailingVolume.lastGood!, sourceId: "longhorn" },
      ageStatus: "crit",
      ageDetail: "Last attempt failed: backup target unreachable: connection refused",
      target: { ...mockTargets.nas, free: 1.2e12, total: 4e12 },
      status: "crit",
    }),
    postureRow({
      pvc: { ...mockPvcs.gitea, sizeBytes: 20 * 2 ** 30, storageClass: "longhorn" },
      app: "StatefulSet/gitea",
      coverage: [mockStaleVolume],
      lastGood: { ...mockStaleVolume.lastGood!, sourceId: "velero" },
      ageStatus: "warn",
      ageDetail: "3 days old against a daily policy",
      target: mockTargets.s3,
      status: "warn",
    }),
    postureRow({
      pvc: { ...mockPvcs.jellyfin, sizeBytes: 2 * 2 ** 30, storageClass: "longhorn" },
      app: "Deployment/jellyfin",
      coverage: [mockNeverBackedUpVolume],
      ageStatus: "warn",
      ageDetail: "Covered, never backed up yet",
      target: { ...mockTargets.nas, free: 1.2e12, total: 4e12 },
      status: "warn",
    }),
    postureRow({
      pvc: { ...mockPvcs.postgres, sizeBytes: 50 * 2 ** 30, storageClass: "longhorn" },
      app: "StatefulSet/postgres",
      coverage: [mockProtectedVolume],
      lastGood: { ...mockProtectedVolume.lastGood!, sourceId: "longhorn" },
      ageStatus: "ok",
      ageDetail: "10 hours old against a daily policy",
      target: { ...mockTargets.nas, free: 1.2e12, total: 4e12 },
      restoreTested: {
        at: mockProtectedVolume.restoreEvidence!.at,
        from: "evidence",
        ref: mockProtectedVolume.restoreEvidence!.ref,
      },
      status: "ok",
    }),
  ],
};

export const mockChannel: ChannelView = {
  id: "ch_ntfy",
  kind: "ntfy",
  label: "Phone",
  enabled: true,
  minSeverity: "warn",
  config: { server: "https://ntfy.sh", topic: "cluster-alerts" },
  hasSecret: false,
  lastSentAt: isoAgo(2 * HOUR),
};

export const mockEmailChannel: ChannelView = {
  id: "ch_email",
  kind: "email",
  label: "Ops mailbox",
  enabled: true,
  minSeverity: "crit",
  config: {
    email: {
      preset: "gmail",
      mode: "smtp",
      host: "smtp.gmail.com",
      port: 587,
      security: "starttls",
      username: "alerts@example.com",
      from: "alerts@example.com",
      to: ["ops@example.com"],
    },
  },
  hasSecret: true,
  lastSentAt: isoAgo(3 * HOUR),
};

export const mockEmailOAuthChannel: ChannelView = {
  id: "ch_email_oauth",
  kind: "email",
  label: "Outlook",
  enabled: true,
  minSeverity: "warn",
  config: {
    email: {
      preset: "microsoft-oauth",
      mode: "oauth",
      clientId: "00000000-0000-0000-0000-000000000001",
      account: "someone@outlook.com",
      to: ["someone@outlook.com"],
    },
  },
  hasSecret: true,
};

export const mockEmailSetup: EmailSetupView = {
  redirectUri: "https://console.example.com/api/notify/oauth/callback",
  signInClient: { provider: "google", clientId: "1234-abc.apps.googleusercontent.com" },
  entra: { ready: false, reason: "Add the Microsoft Entra ID connector first (Admin > Connectors)." },
};

export const mockHost: HostView = {
  id: "host_nas",
  label: "NAS",
  address: "192.0.2.10",
  port: 22,
  username: "monitor",
  auth: "key",
  kind: "auto",
  detectedKind: "synology",
  hasCredential: true,
  backupTargetPaths: ["/volume1/backups"],
  status: "ok",
  lastSeenAt: isoAgo(60_000),
  facts: {
    hostname: "nas",
    os: "DSM 7.2",
    kernel: "4.4.302+",
    uptimeSeconds: 3_456_000,
    cpus: 4,
    memoryBytes: 8 * 2 ** 30,
  },
};

export const mockCheck: CheckView = {
  id: "chk_grafana",
  label: "Grafana",
  kind: "http",
  target: "https://grafana.example.test/api/health",
  intervalMs: 60_000,
  timeoutMs: 10_000,
  bodyMatch: '"database": "ok"',
  authHeader: "Authorization",
  hasSecret: true,
  insecureSkipVerify: false,
  tlsWarnDays: 21,
  enabled: true,
  last: {
    id: "chk_grafana",
    label: "Grafana",
    status: "ok",
    value: 84,
    detail: "200 in 84 ms; certificate valid 61 days",
    observedAt: isoAgo(30_000),
  },
};

// A self-signed target (Rancher's default certificate) with no auth header.
export const mockInsecureCheck: CheckView = {
  id: "chk_rancher",
  label: "Rancher",
  kind: "http",
  target: "https://rancher.example.test/healthz",
  intervalMs: 60_000,
  timeoutMs: 10_000,
  hasSecret: false,
  insecureSkipVerify: true,
  tlsWarnDays: 21,
  enabled: true,
  last: {
    id: "chk_rancher",
    label: "Rancher",
    status: "ok",
    value: 41,
    detail: "200 in 41 ms; certificate not verified (insecureSkipVerify)",
    observedAt: isoAgo(45_000),
  },
};

export const mockWorkloadLinks: WorkloadLinks = {
  headlamp: { url: "https://headlamp.example.test", cluster: "main" },
  rancher: { url: "https://rancher.example.test", clusterId: "local" },
};

// An install with neither UI configured.
export const mockWorkloadLinksEmpty: WorkloadLinks = {};

export const mockPod: PodView = {
  namespace: "media",
  name: "jellyfin-7c9d8",
  phase: "Running",
  ready: "0/1",
  restarts: 14,
  node: "node-2",
  owner: "Deployment/jellyfin",
  containers: [
    {
      name: "jellyfin",
      image: "jellyfin/jellyfin:10.9",
      ready: false,
      restarts: 14,
      state: "waiting",
      reason: "CrashLoopBackOff",
    },
  ],
  createdAt: isoAgo(30 * DAY),
};

export const mockOnboarding: OnboardingState = {
  complete: false,
  steps: [
    { id: "password", done: true, skipped: false, optional: false },
    { id: "cluster", done: true, skipped: false, optional: true },
    { id: "access", done: false, skipped: false, optional: true },
    { id: "oidc", done: false, skipped: true, optional: true },
    { id: "links", done: true, skipped: false, optional: true },
    { id: "hosts", done: false, skipped: false, optional: true },
    { id: "checks", done: false, skipped: false, optional: true },
    { id: "notifications", done: false, skipped: false, optional: true },
    { id: "findings", done: false, skipped: false, optional: false },
  ],
  findings: { unprotectedPvcs: 1, unhealthyNodes: 1, failingBackups: 1 },
};

// Both accepted shapes of the two-factor verify request.
export const mockTotpVerifyRequests: ApiRoutes["POST /api/auth/totp/verify"]["body"][] = [
  { pending: "pnd_7f3a", code: "123456" },
  { pending: "pnd_7f3a", recoveryCode: "aaaa-bbbb" },
];

const mockJoinLink: JoinLink = {
  id: "jl-1",
  role: "agent",
  createdBy: "admin",
  createdAt: now,
  expiresAt: new Date(MOCK_NOW + HOUR).toISOString(),
  url: "https://cluster.example.test/join/q7Vx2mN4pR8sT1wY5zA3bC6dE9fG0hJk",
  command: "curl -fsSL 'https://cluster.example.test/join/q7Vx2mN4pR8sT1wY5zA3bC6dE9fG0hJk' | sudo bash",
};

const mockJoinStatus: JoinStatus = {
  state: "on",
  k3sVersion: "v1.31.4+k3s1",
  roles: ["agent"],
  links: [
    {
      id: mockJoinLink.id,
      role: mockJoinLink.role,
      createdBy: mockJoinLink.createdBy,
      createdAt: mockJoinLink.createdAt,
      expiresAt: mockJoinLink.expiresAt,
    },
  ],
};

const mockJoinScript = `#!/usr/bin/env bash
# Joins this machine to the cluster as a k3s agent (v1.31.4+k3s1).
set -euo pipefail
echo "mock join script"
`;

export const mockApiToken: ApiTokenView = {
  id: "tok_1",
  name: "Claude Code",
  scope: "write",
  prefix: "api_Xk3d",
  createdBy: "admin",
  createdAt: isoAgo(2 * DAY),
  expiresAt: null,
  lastUsedAt: isoAgo(HOUR),
};

export const mockHealthLinks: HealthLinkView[] = [
  {
    id: "settings:cluster:0",
    category: "cluster",
    label: "Rancher",
    url: "https://rancher.example.com/dashboard/c/local/explorer",
    source: "settings",
  },
  {
    id: "lnk_1",
    category: "apps",
    label: "Paperless",
    url: "https://paperless.example.com",
    source: "custom",
    createdBy: "admin",
    createdAt: isoAgo(DAY),
  },
];

export const apiMocks: ApiMocks = {
  "GET /healthz": { status: "ok", version: "dev" },
  "GET /livez": { status: "ok" },
  "GET /api/system/modules": [
    { id: "k8s", milestone: "A", registered: true, schemaVersion: 0 },
    { id: "health", milestone: "A", registered: true, schemaVersion: 2 },
  ],
  "POST /api/system/reset": {
    cleared: [
      { scope: "settings", cleared: 4 },
      { scope: "checks", cleared: 3 },
      { scope: "onboarding", cleared: 5 },
    ],
    kept: ["links", "hosts", "notifications", "sshKey", "adminPassword"],
    wizardReopens: true,
  },
  "GET /api/system/jobs": [
    {
      name: "collect:cluster",
      module: "health",
      intervalMs: 30_000,
      running: false,
      runs: 120,
      failures: 1,
      lastStartedAt: isoAgo(20_000),
      lastFinishedAt: isoAgo(19_500),
      lastOk: true,
      heartbeatAt: isoAgo(20_000),
      nextRunAt: isoAgo(-10_000),
    },
  ],

  "GET /api/me": mockMe,
  "GET /api/auth/methods": {
    siteName: "Cluster",
    password: true,
    oidc: { label: "Sign in with SSO" },
    ip: "192.0.2.50",
  },
  "POST /api/auth/login": { mustChangePassword: false },
  "POST /api/auth/logout": { ok: true },
  "POST /api/auth/password": { ok: true },
  "GET /api/auth/account": {
    hasPassword: true,
    totpEnabled: false,
    totpAvailable: true,
    identities: [],
    sessions: [
      { id: "a1b2c3", method: "password", ip: "192.0.2.50", userAgent: "Mozilla/5.0", lastSeenAt: now, current: true },
    ],
  },
  "POST /api/auth/totp/verify": { mustChangePassword: false },
  "GET /api/auth/totp/status": { enabled: false, available: true, required: false, recoveryCodesLeft: 0 },
  "POST /api/auth/totp/enroll": {
    secret: "JBSWY3DPEHPK3PXP",
    otpauthUrl: "otpauth://totp/Cluster:admin?secret=JBSWY3DPEHPK3PXP",
  },
  "POST /api/auth/totp/confirm": { recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] },
  "POST /api/auth/totp/disable": { ok: true },
  "POST /api/auth/totp/recovery-codes": { recoveryCodes: ["eeee-ffff", "gggg-hhhh"] },
  "GET /api/admin/overview": {
    settings: [
      {
        key: "site.name",
        group: "General",
        label: "Site name",
        help: "Shown in the header and the sign-in page.",
        type: "string",
        default: "",
        value: "Cluster",
        source: "ui",
      },
      {
        key: "site.publicUrl",
        group: "General",
        label: "Public URL",
        help: "Where browsers reach this install.",
        type: "url",
        env: "PUBLIC_ORIGIN",
        default: "",
        value: "https://cluster.example.test",
        source: "ui",
      },
    ],
    environment: [
      {
        name: "TRUSTED_PROXIES",
        help: "Peers whose client-IP header is believed.",
        value: "",
        set: false,
      },
    ],
    publicUrl: { value: "https://cluster.example.test", source: "ui" },
    oidc: {
      redirectUri: "https://cluster.example.test/auth/oidc/callback",
      hasSecret: false,
      unavailable: "No issuer configured.",
    },
    secretKeyConfigured: true,
    you: { ip: "192.0.2.50" },
    version: "dev",
  },
  "PUT /api/admin/settings/:key": { key: "site.name", value: "Cluster" },
  "DELETE /api/admin/settings/:key": { key: "site.name", value: "" },
  "PUT /api/admin/oidc/secret": { hasSecret: true },
  "POST /api/admin/oidc/test": { ok: true, issuer: "https://login.example.test/v2.0" },
  "GET /api/admin/oidc/authentik": {
    authentikUrl: "https://auth.example.test",
    applicationName: "Console",
    slug: "console",
    redirectUri: "https://console.example.test/auth/oidc/callback",
    issuer: "https://auth.example.test/application/o/console/",
    hasStoredToken: false,
    blocked: null,
  },
  "POST /api/admin/oidc/authentik": {
    authentikUrl: "https://auth.example.test",
    slug: "console",
    issuer: "https://auth.example.test/application/o/console/",
    clientId: "mock-client-id",
    redirectUri: "https://console.example.test/auth/oidc/callback",
    application: "created",
    provider: "created",
    settings: ["auth.oidc.issuer", "auth.oidc.clientId", "auth.oidc.label", "auth.oidc.enabled"],
    tokenKept: false,
    discovery: { ok: true },
    testSignIn: "auth/oidc/start?link=1",
  },
  "GET /api/admin/oidc/pocket-id": {
    pocketIdUrl: "https://id.example.test",
    clientName: "Console",
    clientId: "console",
    redirectUri: "https://console.example.test/auth/oidc/callback",
    issuer: "https://id.example.test",
    hasStoredKey: false,
    blocked: null,
  },
  "POST /api/admin/oidc/pocket-id": {
    pocketIdUrl: "https://id.example.test",
    issuer: "https://id.example.test",
    clientId: "console",
    redirectUri: "https://console.example.test/auth/oidc/callback",
    client: "created",
    settings: ["auth.oidc.issuer", "auth.oidc.clientId", "auth.oidc.label", "auth.oidc.enabled"],
    keyKept: false,
    discovery: { ok: true },
    testSignIn: "auth/oidc/start?link=1",
  },
  "POST /api/admin/oidc/public": {
    provider: "google",
    issuer: "https://accounts.google.com",
    clientId: "mock-client-id.apps.googleusercontent.com",
    redirectUri: "https://console.example.test/auth/oidc/callback",
    settings: [
      "auth.oidc.issuer",
      "auth.oidc.clientId",
      "auth.oidc.label",
      "auth.oidc.enabled",
      "auth.oidc.scopes",
      "auth.oidc.usernameClaim",
      "auth.oidc.autoProvision",
      "auth.oidc.allowedGroups",
      "auth.oidc.adminGroups",
      "auth.oidc.allowedEmails",
      "auth.oidc.adminEmails",
    ],
    discovery: { ok: true },
  },
  "GET /api/admin/users": [mockUser],
  "POST /api/admin/users": {
    user: { ...mockUser, id: 2, username: "ops", role: "user", mustChangePassword: true },
    temporaryPassword: "correct-horse-battery",
  },
  "PATCH /api/admin/users/:id": mockUser,
  "DELETE /api/admin/users/:id": { ok: true },
  "POST /api/admin/users/:id/password": { temporaryPassword: "staple-orbit-lantern" },
  "POST /api/admin/users/:id/totp/reset": { ok: true },
  "GET /api/admin/users/:id/sessions": [
    {
      id: "a1b2c3",
      method: "password",
      ip: "192.0.2.50",
      userAgent: "Mozilla/5.0",
      createdAt: isoAgo(DAY),
      lastSeenAt: now,
    },
  ],
  "DELETE /api/admin/users/:id/sessions": { ended: 1 },
  "DELETE /api/admin/users/:id/sessions/:handle": { ok: true },
  "DELETE /api/admin/users/:id/identities": mockUser,
  "GET /api/admin/audit": [
    {
      id: 42,
      ts: MOCK_NOW - HOUR,
      username: "admin",
      ip: "192.0.2.50",
      action: "sign-in",
      target: "",
      detail: "password",
      result: "ok",
    },
  ],

  "GET /api/k8s/capabilities": {
    checkedAt: now,
    capabilities: [
      {
        id: "nodes",
        label: "Node",
        check: { verb: "list", group: "", resource: "nodes" },
        allowed: true,
        groupPresent: true,
      },
      {
        id: "secrets",
        label: "Secret",
        check: { verb: "list", group: "", resource: "secrets" },
        allowed: false,
        groupPresent: true,
        needs: "list on secrets",
        optIn: true,
      },
      {
        id: "veleroBackups",
        label: "Backup",
        check: { verb: "list", group: "velero.io", resource: "backups" },
        allowed: false,
        groupPresent: false,
        needs: "velero.io installed",
      },
    ],
  },

  "GET /api/admin/tokens": [
    mockApiToken,
    {
      ...mockApiToken,
      id: "tok_2",
      name: "Claude",
      kind: "oauth",
      client: "Claude",
      prefix: "api_Q7mz",
      expiresAt: null,
    },
    {
      ...mockApiToken,
      id: "tok_3",
      name: "Team apps CI",
      prefix: "api_Rb2n",
      namespaces: ["apps", "staging"],
      areas: ["workloads", "deploy"],
      lastUsedAt: null,
    },
  ],
  "POST /api/admin/tokens": { token: mockApiToken, secret: "api_Xk3dMockSecretNotReal0000000000000000000" },
  "PATCH /api/admin/tokens/:id": { ...mockApiToken, namespaces: ["apps"], areas: ["workloads"] },
  "DELETE /api/admin/tokens/:id": { ok: true },
  "POST /api/admin/oauth/consent": {
    client: { id: "cli_1", name: "Claude", redirectUri: "https://claude.ai/api/mcp/auth_callback" },
    requestedScope: "write",
  },

  "GET /api/health/board": mockHealthBoard,
  "GET /api/health/categories/:category": mockCategoryDetail,
  "GET /api/health/links": mockHealthLinks,
  "POST /api/health/links": mockHealthLinks[1]!,
  "PUT /api/health/links/:id": mockHealthLinks[1]!,
  "DELETE /api/health/links/:id": { ok: true },
  "GET /api/health/history/:providerId/:checkId": {
    providerId: "cluster",
    checkId: "pods.crashloop",
    points: [
      { at: isoAgo(6 * HOUR), status: "ok", detail: "No crashlooping pods" },
      { at: isoAgo(2 * HOUR), status: "crit", detail: mockCheckResults.crit.detail },
    ],
  },
  "POST /api/health/providers/:providerId/run": [mockCheckResults.ok, mockCheckResults.crit],

  "GET /api/cluster/join": mockJoinStatus,
  "POST /api/cluster/join-links": mockJoinLink,
  "DELETE /api/cluster/join-links/:id": { ok: true },
  "GET /join/:token": mockJoinScript,
  "GET /api/metrics/query": mockSeriesResults,
  "GET /api/metrics/series": [
    { series: "node.cpu.percent", labelKeys: ["node"], firstTs: MOCK_NOW - 30 * DAY, lastTs: MOCK_NOW },
    { series: "node.memory.percent", labelKeys: ["node"], firstTs: MOCK_NOW - 30 * DAY, lastTs: MOCK_NOW },
  ],

  "GET /api/notify/channels": [mockChannel, mockEmailChannel, mockEmailOAuthChannel],
  "POST /api/notify/channels": mockChannel,
  "PUT /api/notify/channels/:id": mockChannel,
  "DELETE /api/notify/channels/:id": { ok: true },
  "POST /api/notify/channels/:id/test": { ok: true, status: 250 },
  "GET /api/notify/email/setup": mockEmailSetup,
  "POST /api/notify/channels/:id/oauth": {
    url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=1234-abc.apps.googleusercontent.com&state=mock",
  },
  "GET /api/notify/oauth/callback": "",

  "GET /api/hosts": [mockHost],
  "POST /api/hosts": mockHost,
  "GET /api/hosts/:id": mockHost,
  "PUT /api/hosts/:id": mockHost,
  "DELETE /api/hosts/:id": { ok: true },
  "POST /api/hosts/test": {
    ok: true,
    hostKeyFingerprint: "SHA256:Q0ZBa2V5ZmluZ2VycHJpbnRmb3J0ZXN0aW5nb25seQ",
    detectedKind: "synology",
    results: [
      { id: "reachable", label: "Reachable", status: "ok", detail: "SSH as monitor, DSM 7.2", observedAt: now },
    ],
  },
  "GET /api/hosts/keypair": { keypair: mockHostKeypair },
  "POST /api/hosts/keypair": mockHostKeypair,

  "GET /api/checks": [mockCheck, mockInsecureCheck],
  "POST /api/checks": mockCheck,
  "PUT /api/checks/:id": mockCheck,
  "DELETE /api/checks/:id": { ok: true },
  "POST /api/checks/:id/run": mockCheck.last!,

  "GET /api/metrics-k8s/nodes": mockNodeSummaries,

  "GET /api/longhorn/replicas": mockReplicaAdvice,
  "GET /api/backups/posture": mockPosture,
  "GET /api/backups/posture.csv":
    "namespace,pvc,app,protected,source,last_good,age_status,target\n" +
    "apps,scratch-cache,Deployment/cache,false,,,crit,\n" +
    `apps,postgres-data,StatefulSet/postgres,true,longhorn,${mockProtectedVolume.lastGood!.at},ok,${mockTargets.nas.label}\n`,
  "POST /api/backups/volumes/:uid/restore-tests": {
    at: isoAgo(DAY),
    note: "Restored into scratch namespace, app started",
    by: "admin",
  },
  "GET /api/backups/target": mockBackupTargetView,
  "PUT /api/backups/target": mockBackupTargetJob,
  "GET /api/backups/schedules": mockBackupSchedules,
  "PUT /api/backups/schedules": mockBackupRecurringJob,
  "PUT /api/backups/volumes/:uid/groups": mockBackupRecurringJob,
  "POST /api/backups/volumes/:uid/backup-now": mockBackupNowJob,
  "GET /api/backups/volumes/:uid/backups": mockRestorePoints,
  "POST /api/backups/restore/plan": mockRestorePlan,
  "POST /api/backups/restore": mockRestoreJob,

  "GET /api/workloads/links": mockWorkloadLinks,
  "GET /api/workloads/namespaces": [
    {
      name: "media",
      status: "Active",
      workloads: 1,
      pods: 1,
      unhealthyPods: 1,
      managedBy: "fleet",
      createdAt: isoAgo(30 * DAY),
    },
    {
      name: "monitoring",
      status: "Active",
      workloads: 3,
      pods: 4,
      unhealthyPods: 0,
      managedBy: "helm",
      createdAt: isoAgo(30 * DAY),
    },
  ],
  "GET /api/workloads/namespaces/:namespace/workloads": [
    {
      namespace: "media",
      name: "jellyfin",
      kind: "Deployment",
      ready: "0/1",
      desired: 1,
      available: 0,
      images: ["jellyfin/jellyfin:10.9"],
      managedBy: "fleet",
      createdAt: isoAgo(30 * DAY),
    },
  ],
  "GET /api/workloads/namespaces/:namespace/pods": [mockPod],
  "GET /api/workloads/namespaces/:namespace/pods/:pod": mockPod,
  "GET /api/workloads/namespaces/:namespace/events": [
    {
      type: "Warning",
      reason: "BackOff",
      message: "Back-off restarting failed container jellyfin in pod jellyfin-7c9d8",
      object: "Pod/jellyfin-7c9d8",
      count: 57,
      lastSeen: isoAgo(60_000),
    },
  ],
  "GET /api/workloads/usage": mockClusterUsage,
  "GET /api/workloads/namespaces/:namespace/usage": mockSpaceUsage,
  "GET /api/workloads/namespaces/:namespace/pods/:pod/logs": {
    lines: [
      "[INF] Starting Jellyfin",
      "[ERR] Database connection string: Password=********",
      "[FTL] Unhandled exception",
    ],
    redacted: 1,
    truncated: false,
  },
  "GET /api/workloads/namespaces/:namespace/pods/:pod/logs/stream": [
    { line: "[INF] Starting Jellyfin" },
    { line: "[FTL] Unhandled exception" },
  ],

  "GET /api/catalog/apps": mockCatalogApps,
  "GET /api/catalog/apps/:id": mockCatalogApps.find((app) => app.id === "headlamp")!,
  "GET /api/catalog/discovery": mockDiscovery,
  "GET /api/catalog/bundles": [mockBundleView],

  "GET /api/deploy/status": mockDeployStatus,
  "GET /api/deploy/access": mockAccess,
  "PUT /api/deploy/access": mockAccess,
  "POST /api/deploy/plan": mockDeployPlan,
  "POST /api/deploy/jobs": { ...mockRunningJob, appId: "headlamp", release: "headlamp", namespace: "headlamp" },
  "GET /api/deploy/jobs": [mockRunningJob, mockDeployJob, mockFailedJob],
  "GET /api/deploy/jobs/:id": mockDeployJob,
  "GET /api/deploy/jobs/:id/logs": { lines: mockDeployLog, redacted: 0, truncated: false },
  "GET /api/deploy/jobs/:id/logs/stream": mockDeployLog.map((line) => ({ line })),
  "POST /api/deploy/jobs/:id/cancel": { ...mockRunningJob, state: "cancelled", finishedAt: now },
  "POST /api/deploy/bundles/plan": mockBundlePlan,
  "POST /api/deploy/bundles": mockBundleRun,
  "GET /api/deploy/bundles": [mockBundleRun],
  "GET /api/deploy/bundles/:id": mockBundleRun,
  "POST /api/deploy/bundles/:id/cancel": {
    ...mockBundleRun,
    state: "cancelled",
    finishedAt: now,
    steps: mockBundleRun.steps.map((step) => (step.state === "running" ? { ...step, state: "cancelled" } : step)),
  },
  "GET /api/deploy/upgrades": mockUpgradeReport,
  "POST /api/deploy/upgrades": mockUpgradeRun,
  "GET /api/deploy/gate": mockGateStatus,
  "GET /api/deploy/ports": mockPortsView,
  "POST /api/deploy/actions/plan": mockReplicasPlan,
  "POST /api/deploy/actions/run": mockReplicasJob,
  "GET /api/deploy/actions/backups/:id": mockVolumeBackup,
  "GET /api/deploy/actions/backups/:id/files/:claim": "",
  "POST /api/deploy/actions/backups/:id/done": { ...mockVolumeBackup, state: "gone" },

  "GET /api/templates": mockTemplatesView,
  "POST /api/templates/plan": mockTemplatePlan,
  "POST /api/templates/jobs": mockTemplateJob,

  "GET /api/connectors/kinds": mockConnectorKinds,
  "GET /api/connectors": mockConnectors,
  "POST /api/connectors": mockCloudflareConnector,
  "POST /api/connectors/test": { ok: true, checks: mockCloudflareConnector.checks },
  "GET /api/connectors/:id": mockCloudflareConnector,
  "PUT /api/connectors/:id": mockCloudflareConnector,
  "DELETE /api/connectors/:id": { ok: true, removed: 2, errors: [] },
  "POST /api/connectors/:id/test": mockCloudflareConnector,
  "POST /api/connectors/:id/reconcile": mockCloudflareConnector,
  "GET /api/connector-cloudflare/view": mockCloudflareView,
  "POST /api/connector-cloudflare/sync": mockCloudflareView,
  "PUT /api/connector-cloudflare/hosts/:host": mockCloudflareHosts[0]!,
  "POST /api/connector-cloudflare/discover": mockCloudflareDiscovery,
  "POST /api/connector-cloudflare/tunnel": mockCloudflareView,
  "POST /api/connector-cloudflare/tunnel/deploy": {
    ...mockRunningJob,
    appId: "cloudflared",
    release: "cloudflared",
    namespace: "cloudflared",
  },
  "GET /api/connector-entra/view": mockEntraSignIn,
  "POST /api/connector-entra/signin": mockEntraSignIn,
  "GET /api/connector-entra/groups": mockEntraGroups,
  "GET /api/connector-storage/targets": mockStorageTargets,
  "GET /api/connector-storage/targets/:id": mockNfsTarget,
  "POST /api/mcp": {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "{}" }], structuredContent: mockHealthBoard },
  },
  "GET /api/mcp": { error: "Method not allowed." },
  "DELETE /api/mcp": { error: "Method not allowed." },

  "GET /api/onboarding/state": mockOnboarding,
  "POST /api/onboarding/steps/:step": mockOnboarding,
  "GET /api/onboarding/seed": mockSeedDone,
  "POST /api/onboarding/seed/apply": mockSeedDone,
  "POST /api/onboarding/seed/dismiss": { ...mockSeedDone, dismissed: true },
};
