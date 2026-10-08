// Adding a node to a k3s cluster from a one-liner the UI shows.
//
// The installer (install.sh) stores what a node needs to join in a Secret
// in this product's own namespace; the chart lets the product's
// ServiceAccount get that one Secret by name and nothing else. An admin
// creates a short-lived, single-use join link; fetching it (no sign-in: the
// new machine has no session) returns a bash script with the join values
// baked in. The token itself never appears in an API response, the UI or a
// log; only the link does.
//
// Server-free on purpose: the client imports this file.

// The Secret install.sh writes, in the namespace the product runs in. Every
// value is a plain string under `data` (base64, as for any Secret).
export const JOIN_SECRET = {
  name: "k3s-join",
  keys: {
    // https://<server address>:6443, an address the new machine can reach.
    serverUrl: "server-url",
    // /var/lib/rancher/k3s/server/node-token: joins agents and servers.
    token: "token",
    // Optional. /var/lib/rancher/k3s/server/agent-token when the cluster has
    // a separate one; agent links use it in preference to `token`.
    agentToken: "agent-token",
  },
} as const;

// agent: a worker node. server: another control-plane node, only possible
// when the cluster runs embedded etcd.
export type JoinRole = "agent" | "server";

// off: no Secret (the cluster wasn't installed by install.sh, or the
// Secret was deleted). denied: the Secret can't be read (the chart's grant
// is missing). unsupported: not a k3s cluster. on: links can be made.
export type JoinState = "on" | "off" | "denied" | "unsupported";

export interface JoinLinkSummary {
  id: string;
  role: JoinRole;
  createdBy: string;
  // ISO 8601.
  createdAt: string;
  expiresAt: string;
}

export interface JoinStatus {
  state: JoinState;
  // Why the state isn't "on", in a sentence the UI shows as is.
  reason?: string;
  // The version a joining node installs: the API server's, e.g. "v1.31.4+k3s1".
  k3sVersion?: string;
  // Which roles a link can be made for: server only with embedded etcd.
  roles: JoinRole[];
  // Unused, unexpired links, newest first. Never their URLs: only a hash of
  // each token is kept.
  links: JoinLinkSummary[];
}

export interface JoinLinkRequest {
  // Default "agent".
  role?: JoinRole;
  // The address the admin reaches this install at (the client sends
  // document.baseURI); the link is built under it. http or https only.
  baseUrl: string;
}

export interface JoinLink extends JoinLinkSummary {
  // <baseUrl>join/<token>. Shown once; GET /api/cluster/join can't return it.
  url: string;
  // `curl -fsSL '<url>' | sudo bash`
  command: string;
}

// Lifetime of a join link.
export const JOIN_LINK_TTL_MS = 60 * 60 * 1000;
