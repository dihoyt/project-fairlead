import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { NewApiToken } from "../../../src/contracts/auth.js";
import type { HealthLinkView } from "../../../src/contracts/health.js";
import { MCP_TOOLS } from "../../../src/contracts/mcp.js";
import health from "../../../src/modules/health/index.js";
import mcp from "../../../src/modules/mcp/index.js";
import { boot } from "../../platform/harness.js";

async function setup(env: Record<string, string> = {}) {
  const app = await boot({ modules: [health, mcp], env });
  await app.makeUser("root", "root password!!", { role: "admin" });
  const { cookie } = await app.login("root", "root password!!");
  const mint = async (scope: "read" | "write") => {
    const res = await app.send("POST", "/api/admin/tokens", { name: scope, scope }, cookie);
    return ((await res.json()) as NewApiToken).secret;
  };
  const connect = async (secret: string) => {
    const client = new Client({ name: "test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${secret}` } },
    });
    await client.connect(transport);
    return client;
  };
  return { app, cookie, mint, connect };
}

test("a write token lists every tool and adds a link that shows on its category page", async () => {
  const { app, cookie, mint, connect } = await setup();
  try {
    const client = await connect(await mint("write"));
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      MCP_TOOLS.map((t) => t.name)
    );
    const create = tools.find((t) => t.name === "create_link")!;
    assert.deepEqual(create.inputSchema.required?.toSorted(), ["category", "label", "url"]);
    assert.equal(create.annotations?.readOnlyHint, false);

    const created = await client.callTool({
      name: "create_link",
      arguments: { category: "apps", label: "Paperless", url: "https://docs.example.com" },
    });
    assert.equal(created.isError, undefined);
    const link = created.structuredContent as unknown as HealthLinkView;
    assert.equal(link.createdBy, "root");

    const page = await client.callTool({ name: "get_health_category", arguments: { category: "apps" } });
    assert.deepEqual((page.structuredContent as { links: unknown[] }).links, [
      { label: "Paperless", url: "https://docs.example.com" },
    ]);

    const audit = app.db.prepare("SELECT username, action FROM audit_log WHERE action LIKE 'health.%'").all();
    assert.deepEqual(audit, [{ username: "root", action: "health.link-create" }]);

    const missing = await client.callTool({ name: "delete_link", arguments: { id: "lnk_nope" } });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing.content), /No link/);

    const bad = await client.callTool({
      name: "create_link",
      arguments: { category: "apps", label: "x", url: "ftp://x" },
    });
    assert.equal(bad.isError, true);
    await client.close();
    void cookie;
  } finally {
    await app.close();
  }
});

test("a read token sees only read tools", async () => {
  const { app, mint, connect } = await setup();
  try {
    const client = await connect(await mint("read"));
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.deepEqual(
      names,
      MCP_TOOLS.filter((t) => t.scope === "read").map((t) => t.name)
    );
    const refused = await client.callTool({
      name: "create_link",
      arguments: { category: "apps", label: "x", url: "https://x.example.com" },
    });
    assert.equal(refused.isError, true);
    const board = await client.callTool({ name: "get_health_board", arguments: {} });
    assert.equal(board.isError, undefined);
    assert.ok((board.structuredContent as { tiles: unknown[] }).tiles.length > 0);
    await client.close();
  } finally {
    await app.close();
  }
});

test("/mcp needs a token, refuses a cookie, rate-limits, and answers 405 to GET", async () => {
  const { app, cookie, mint } = await setup({ MCP_REQUESTS_PER_MINUTE: "2" });
  try {
    const ping = (headers: Record<string, string>) =>
      fetch(`${app.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
    assert.equal((await ping({})).status, 401);
    const cookieOnly = await ping({ cookie });
    assert.equal(cookieOnly.status, 401);
    assert.equal(cookieOnly.headers.get("www-authenticate"), 'Bearer realm="mcp"');

    const auth = { authorization: `Bearer ${await mint("read")}` };
    assert.equal((await ping(auth)).status, 200);
    assert.equal((await ping(auth)).status, 200);
    const limited = await ping(auth);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);

    assert.equal((await fetch(`${app.url}/mcp`, { headers: auth })).status, 405);
  } finally {
    await app.close();
  }
});
