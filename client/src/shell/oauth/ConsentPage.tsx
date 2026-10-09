import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Alert, Button, Code, Group, Loader, Paper, SegmentedControl, Stack, Text, Title } from "@mantine/core";
import type { ApiTokenScope, OAuthAuthorizeParams, OAuthConsentView } from "@contracts/auth";
import { product } from "../../product";
import { apiRequest } from "../../ui/api";
import { GrantFields, NO_LIMITS, limitsBody, limitsProblem, type GrantLimits } from "../admin/GrantFields";

// The query /oauth/authorize passed on, as the consent route takes it back.
export function paramsOf(search: string): OAuthAuthorizeParams {
  const query = new URLSearchParams(search);
  const params: Record<string, string> = {};
  for (const [key, value] of query) params[key] = value;
  return params as unknown as OAuthAuthorizeParams;
}

const hostOf = (uri: string) => {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
};

// Where an MCP client sends an admin to approve it. Approving issues a
// grant that acts as this account, listed under Admin > API tokens.
export function ConsentPage({
  navigate = (url: string) => window.location.assign(url),
}: {
  navigate?: (url: string) => void;
}) {
  const { search } = useLocation();
  const [params] = useState(() => paramsOf(search));
  const [view, setView] = useState<OAuthConsentView | null>(null);
  const [scope, setScope] = useState<ApiTokenScope>("read");
  const [limits, setLimits] = useState<GrantLimits>(NO_LIMITS);
  const problem = limitsProblem(limits);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiRequest("POST /api/admin/oauth/consent", { body: { params, decision: "preview" } })
      .then((next) => {
        setView(next);
        setScope(next.requestedScope);
      })
      .catch((err: Error) => setError(err.message));
  }, [params]);

  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    try {
      const result = await apiRequest("POST /api/admin/oauth/consent", {
        body: { params, decision, scope, ...(decision === "approve" ? limitsBody(limits) : {}) },
      });
      if (result.redirect) navigate(result.redirect);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  // Inside a frame the Approve button could be clicked through a page laid
  // over it, so approval only happens in a top-level window.
  if (window.top !== window.self) {
    return <Alert color="red">Open this page in its own window to approve an app.</Alert>;
  }

  return (
    <Stack maw={520} mx="auto" mt="xl" gap="md">
      <Title order={3}>Connect an app to {product.displayName}</Title>
      {error ? <Alert color="red">{error}</Alert> : null}
      {!view && !error ? <Loader size="sm" /> : null}
      {view ? (
        <Paper withBorder p="md">
          <Stack gap="sm">
            <Text>
              <b>{view.client.name}</b> wants to use this install through its MCP server, as you.
            </Text>
            <Text size="sm" c="dimmed">
              After you approve, it is sent back to <Code>{hostOf(view.client.redirectUri)}</Code>.
            </Text>
            <SegmentedControl
              value={scope}
              onChange={(value) => setScope(value as ApiTokenScope)}
              data={[
                { value: "read", label: "Read only" },
                { value: "write", label: "Read and write" },
              ]}
            />
            <Text size="xs" c="dimmed">
              {scope === "write"
                ? "It can add and change checks and links and start deploys, like you can."
                : "It can look at everything you can, and change nothing."}{" "}
              Revoke it any time under Admin &gt; API tokens.
            </Text>
            <GrantFields value={limits} onChange={setLimits} />
            {problem ? (
              <Text size="xs" c="orange">
                {problem}
              </Text>
            ) : null}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => void decide("deny")} disabled={busy}>
                Deny
              </Button>
              <Button onClick={() => void decide("approve")} loading={busy} disabled={problem !== null}>
                Approve
              </Button>
            </Group>
          </Stack>
        </Paper>
      ) : null}
    </Stack>
  );
}
