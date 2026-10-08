# MCP server and API tokens

The console serves an [MCP](https://modelcontextprotocol.io) server at `/mcp` on the same address as the UI. Claude and other MCP clients use it to read what the console knows (health, nodes, workloads, checks, backups, catalog, deploys, hosts) and, with a write token, to add checks and links and deploy catalog apps the way the setup wizard does. Everything they add shows up in the UI like anything you added yourself, and every change is in the audit log under your name.

The same tokens work on the REST API (`/api/...`) as `Authorization: Bearer <token>`.

## Make a token

**Admin > API tokens > Create token.**

- **Read** tokens can only look. MCP clients using one see only the read tools.
- **Read and write** tokens can do whatever you can: add, change and delete checks and links, preview and start deploys. Give one only to a client you trust to change things.
- **Expiry** defaults to 90 days. Leave it empty for a token that never expires.

The token is shown once. It acts as the admin who made it: if that account is disabled the token stops working, and if it stops being an admin the token can only read. Tokens are never accepted on account, sign-in or token management (`/api/admin`, `/api/auth`), so a leaked token can't mint more tokens or change who can sign in. Revoke a token on the same page; it stops working on the next request.

The endpoint is rate-limited per token (120 requests a minute by default; the `mcp.requestsPerMinute` setting or `MCP_REQUESTS_PER_MINUTE` changes it). Tool calls are logged at info level with the tool name, user and token id, never their arguments.

## Connect

The endpoint is streamable HTTP, stateless, JSON responses:

```
https://console.example.com/mcp
Authorization: Bearer api_...
```

Use the address your browser uses for the console. On a default install that's `http://<node-ip>:32450/mcp`.

### Claude Code

```bash
claude mcp add --transport http fairlead https://console.example.com/mcp \
  --header "Authorization: Bearer api_..."
```

Admin > API tokens shows this command with your address and the new token filled in. Add `--scope user` to have it in every project. Check it with `claude mcp list`, then ask Claude something like "what's unhealthy in my cluster?".

### Claude Desktop and other clients that speak stdio

Clients that only launch local servers can reach it through `mcp-remote`:

```json
{
  "mcpServers": {
    "fairlead": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://console.example.com/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer api_..." }
    }
  }
}
```

### claude.ai custom connectors

claude.ai connects from Anthropic's servers, so the console has to be reachable at a public HTTPS address, for example through a Cloudflare Tunnel set up in the wizard's Access step. claude.ai custom connectors sign in with OAuth and can't send a fixed bearer header, and the console doesn't offer OAuth sign-in for MCP yet, so for now use Claude Code or Claude Desktop.

### Anything else

Any client that supports streamable HTTP with custom headers works: point it at `/mcp` with the `Authorization` header. `GET /mcp` answers 405 because the server keeps no sessions and opens no streams.

## Tools

Read (any token):

| Tool | What it returns |
|---|---|
| `get_health_board` | Overall status and a tile per category with its worst issue |
| `get_health_category` | Every check in one category, with its links |
| `list_nodes` | Nodes with readiness, CPU and memory |
| `list_namespaces` | Namespaces with workload and pod counts |
| `list_workloads` | Workloads in a namespace |
| `list_pods` | Pods in a namespace, optionally one workload's |
| `list_checks` | HTTP/TCP checks with their last result |
| `list_links` | Links on the category pages |
| `get_backup_posture` | Every PVC and how it is backed up |
| `list_catalog_apps` | Deployable apps, their inputs, and whether each is installed |
| `get_discovery` | What the cluster already has |
| `list_deploy_jobs` | Recent deploys |
| `get_deploy_job_logs` | A deploy's log, secrets redacted |
| `list_bundle_runs` | Bundle rollouts |
| `list_hosts` | SSH-monitored hosts |

Write (a read-and-write token): `create_check`, `update_check` (only the fields you give change), `delete_check`, `run_check`, `accept_check_status` (the Checks page's "Accept this status"), `create_link`, `update_link`, `delete_link`, `plan_app_deploy`, `deploy_app`, `plan_bundle`, `start_bundle`.

Results are the same shapes the REST API returns (lists come back as `{ "items": [...] }`). No tool returns a stored secret: check secrets, host credentials, the SSH private key, the cluster join token and secret settings are write-only or not reachable at all. Deploys still need deploys turned on (`install.sh --enable-deploy`); without it `plan_app_deploy` says so.

## Example: add your own app's check and link

You run Paperless at `https://docs.example.com` and want it on the board. With Claude Code connected, ask:

> Add a check for https://docs.example.com and a link to it under Apps.

Claude calls:

```json
{ "name": "create_check", "arguments": { "label": "Paperless", "kind": "http", "target": "https://docs.example.com" } }
```

and then:

```json
{ "name": "create_link", "arguments": { "category": "apps", "label": "Paperless", "url": "https://docs.example.com" } }
```

The check appears on the Checks page and in the Checks tile and runs every minute; the link appears on the Apps category page. If Paperless answers 401 because it sits behind a login, the check warns; ask Claude to accept that status and it calls `accept_check_status`, which records 401 as expected and re-runs the check.

The same from a shell, without MCP:

```bash
TOKEN=api_...
curl -fsS https://console.example.com/api/checks -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"label":"Paperless","kind":"http","target":"https://docs.example.com"}'
curl -fsS https://console.example.com/api/health/links -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"category":"apps","label":"Paperless","url":"https://docs.example.com"}'
```

Links added this way can be changed or deleted through the API; the ones from the wizard's Links step are read-only there and are changed in the wizard or under Admin > Settings. Resetting "Native UI links" to defaults clears both kinds.
