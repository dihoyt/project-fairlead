import { test } from "node:test";
import assert from "node:assert/strict";
import { JOIN_SECRET, type JoinLink, type JoinStatus } from "../../../src/contracts/cluster.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { createMockContext, mockViewer } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s, type FakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { MOCK_NOW } from "../../../src/contracts/mocks/time.js";
import mod from "../../../src/modules/cluster/index.js";
import { migrations } from "../../../src/modules/cluster/migrations.js";
import { createJoin } from "../../../src/modules/cluster/join.js";
import { joinScript } from "../../../src/modules/cluster/joinScript.js";
import { listen } from "../../runtime/helpers.js";

const NS = "console-test";
const TOKEN = "K10abc123::server:0123456789abcdef";
const AGENT_TOKEN = "K10abc123::node:fedcba9876543210";
const K3S = { major: "1", minor: "31", gitVersion: "v1.31.4+k3s1" };

const b64 = (value: string) => Buffer.from(value).toString("base64");

function joinSecret(data: Record<string, string>): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: JOIN_SECRET.name, namespace: NS },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)])),
  };
}

const node = (name: string, labels: Record<string, string> = {}): KubeObject => ({ metadata: { name, labels } });

function fake(options: { secret?: KubeObject | null; version?: typeof K3S; etcd?: boolean } = {}): FakeK8s {
  const secret =
    options.secret === undefined
      ? joinSecret({ [JOIN_SECRET.keys.serverUrl]: "https://10.0.0.10:6443", [JOIN_SECRET.keys.token]: TOKEN })
      : options.secret;
  return createFakeK8s({
    version: options.version ?? K3S,
    objects: [
      { ref: RESOURCES.secrets, items: secret ? [secret] : [] },
      {
        ref: RESOURCES.nodes,
        items: [
          node("k3s-server", options.etcd ? { "node-role.kubernetes.io/etcd": "true" } : {}),
          node("k3s-agent-01"),
        ],
      },
    ],
  });
}

async function boot(k8s: FakeK8s) {
  process.env.POD_NAMESPACE = NS;
  const mock = createMockContext("cluster", { migrations, services: { k8s } });
  await mod.register(mock.ctx);
  const server = await listen(mock.app);
  const post = (body: unknown) =>
    fetch(`${server.url}/api/cluster/join-links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    mock,
    url: server.url,
    post,
    status: async () => (await (await fetch(`${server.url}/api/cluster/join`)).json()) as JoinStatus,
    async close() {
      await server.close();
      await mock.close();
    },
  };
}

test("status is on with the k3s version and agent role when the Secret is there", async () => {
  const app = await boot(fake());
  try {
    const status = await app.status();
    assert.equal(status.state, "on");
    assert.equal(status.k3sVersion, "v1.31.4+k3s1");
    assert.deepEqual(status.roles, ["agent"]);
    assert.deepEqual(status.links, []);
  } finally {
    await app.close();
  }
});

test("status is off without the Secret, unsupported off k3s, and links are refused", async () => {
  const off = await boot(fake({ secret: null }));
  try {
    const status = await off.status();
    assert.equal(status.state, "off");
    assert.match(status.reason ?? "", /k3s-join/);
    assert.equal((await off.post({ baseUrl: "http://10.0.0.5:32450/" })).status, 409);
  } finally {
    await off.close();
  }
  const eks = await boot(fake({ version: { major: "1", minor: "31", gitVersion: "v1.31.4-eks-1234" } }));
  try {
    assert.equal((await eks.status()).state, "unsupported");
  } finally {
    await eks.close();
  }
});

test("status is denied when the Secret can't be read", async () => {
  const k8s = fake();
  const get = k8s.get.bind(k8s);
  k8s.get = (async (ref, name, namespace) => {
    if (ref === RESOURCES.secrets) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    return get(ref, name, namespace);
  }) as typeof k8s.get;
  const app = await boot(k8s);
  try {
    assert.equal((await app.status()).state, "denied");
  } finally {
    await app.close();
  }
});

test("a link is shown once, works once without a session, and never exposes the token through the API", async () => {
  const app = await boot(fake());
  try {
    const res = await app.post({ baseUrl: "http://10.0.0.5:32450/#/nodes" });
    assert.equal(res.status, 200);
    const link = (await res.json()) as JoinLink;
    assert.match(link.url, /^http:\/\/10\.0\.0\.5:32450\/join\/[A-Za-z0-9_-]{32}$/);
    assert.equal(link.command, `curl -fsSL '${link.url}' | sudo bash`);
    assert.equal(Date.parse(link.expiresAt) - Date.parse(link.createdAt), 3_600_000);
    assert.deepEqual(
      app.mock.audit.map((a) => a.action),
      ["cluster.join-link.create"]
    );

    const status = await app.status();
    assert.equal(status.links.length, 1);
    assert.ok(!JSON.stringify(status).includes(TOKEN));
    assert.ok(!JSON.stringify(link).includes(TOKEN));

    app.mock.setUser(null);
    const path = new URL(link.url).pathname;
    const first = await fetch(`${app.url}${path}`);
    assert.equal(first.status, 200);
    assert.match(first.headers.get("content-type") ?? "", /text\/x-shellscript/);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const script = await first.text();
    assert.match(script, /INSTALL_K3S_VERSION="\$K3S_VERSION"/);
    assert.match(script, /K3S_VERSION='v1\.31\.4\+k3s1'/);
    assert.match(script, /K3S_URL='https:\/\/10\.0\.0\.10:6443'/);
    assert.ok(script.includes(`K3S_TOKEN='${TOKEN}'`));
    assert.match(script, /open-iscsi nfs-common/);
    assert.match(script, /sh -s - agent\n/);
    assert.match(script, /EXISTING_NODES='k3s-server k3s-agent-01'/);

    const second = await fetch(`${app.url}${path}`);
    assert.equal(second.status, 404);
    assert.match(await second.text(), /already used/);
    assert.equal((await fetch(`${app.url}/join/nonsense`)).status, 404);
    assert.ok(app.mock.audit.some((a) => a.action === "cluster.join-link.use" && a.target === link.id));
  } finally {
    await app.close();
  }
});

test("agent links prefer the agent token; server links need etcd and use the server token", async () => {
  const k8s = fake({
    etcd: true,
    secret: joinSecret({
      [JOIN_SECRET.keys.serverUrl]: "https://10.0.0.10:6443",
      [JOIN_SECRET.keys.token]: TOKEN,
      [JOIN_SECRET.keys.agentToken]: AGENT_TOKEN,
    }),
  });
  const app = await boot(k8s);
  try {
    assert.deepEqual((await app.status()).roles, ["agent", "server"]);
    const fetchScript = async (role: string) => {
      const link = (await (await app.post({ role, baseUrl: "https://console.example.com/" })).json()) as JoinLink;
      return (await fetch(`${app.url}${new URL(link.url).pathname}`)).text();
    };
    const agent = await fetchScript("agent");
    assert.ok(agent.includes(`K3S_TOKEN='${AGENT_TOKEN}'`));
    const server = await fetchScript("server");
    assert.ok(server.includes(`K3S_TOKEN='${TOKEN}'`));
    assert.match(server, /sh -s - server\n/);
  } finally {
    await app.close();
  }
  const single = await boot(fake());
  try {
    assert.equal((await single.post({ role: "server", baseUrl: "https://console.example.com/" })).status, 400);
  } finally {
    await single.close();
  }
});

test("links are admin only, revocable, and bad base URLs are refused", async () => {
  const app = await boot(fake());
  try {
    assert.equal((await app.post({ baseUrl: "javascript:alert(1)" })).status, 400);
    assert.equal((await app.post({})).status, 400);
    const link = (await (await app.post({ baseUrl: "https://console.example.com/" })).json()) as JoinLink;
    const revoke = (id: string) => fetch(`${app.url}/api/cluster/join-links/${id}`, { method: "DELETE" });
    assert.equal((await revoke(link.id)).status, 200);
    assert.equal((await revoke(link.id)).status, 404);
    assert.equal((await fetch(`${app.url}${new URL(link.url).pathname}`)).status, 404);
    assert.deepEqual((await app.status()).links, []);
    app.mock.setUser(mockViewer);
    assert.equal((await app.post({ baseUrl: "https://console.example.com/" })).status, 403);
  } finally {
    await app.close();
  }
});

test("links expire after an hour", async () => {
  const mock = createMockContext("cluster", { migrations });
  let now = MOCK_NOW;
  const join = createJoin({
    db: mock.ctx.db,
    orgId: mock.ctx.orgId,
    k8s: () => fake(),
    namespace: () => NS,
    now: () => now,
  });
  const link = await join.create({ role: "agent", baseUrl: "https://console.example.com", actor: "admin" });
  assert.ok(link.url.startsWith("https://console.example.com/join/"));
  now += 3_600_001;
  assert.equal(await join.script(link.url.split("/join/")[1]!), null);
  assert.deepEqual((await join.status()).links, []);
  await mock.close();
});

test("the script refuses values a shell would act on", () => {
  const base = {
    role: "agent" as const,
    serverUrl: "https://10.0.0.10:6443",
    token: TOKEN,
    k3sVersion: "v1.31.4+k3s1",
    nodeNames: [],
  };
  assert.throws(() => joinScript({ ...base, token: "abc'; rm -rf / #" }), /validation/);
  assert.throws(() => joinScript({ ...base, serverUrl: "https://x'y:6443" }), /validation/);
  assert.throws(() => joinScript({ ...base, serverUrl: "http://10.0.0.10:6443" }), /validation/);
  assert.throws(() => joinScript({ ...base, k3sVersion: "v1.31.4'" }), /validation/);
  assert.match(joinScript({ ...base, nodeNames: ["ok-node", "bad'name"] }), /EXISTING_NODES='ok-node'/);
});
