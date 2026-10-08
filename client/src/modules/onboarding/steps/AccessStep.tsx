import { useEffect, useState, type ReactNode } from "react";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Loader,
  Radio,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import type { AccessMode, AccessView } from "@contracts/deploy";
import { apiRequest, useApi } from "../../../ui";
import { CloudflarePanel } from "../../connector-cloudflare/CloudflarePage";
import { AppOffer, useDiscovery } from "../discovery";
import { StepFrame, useAction, type StepProps } from "../shared";

export const ACCESS_MODES: Array<{ mode: AccessMode; label: string; about: string }> = [
  {
    mode: "cloudflare-tunnel",
    label: "Cloudflare Tunnel",
    about: "Reach the apps from anywhere through Cloudflare, without opening a port. Needs a domain on Cloudflare.",
  },
  {
    mode: "tailscale",
    label: "Tailscale",
    about: "Reach the apps only from your own devices on your tailnet; nothing is exposed to the internet.",
  },
  {
    mode: "local",
    label: "Local network only",
    about: "Reach the apps at home only; you add their names to your router's DNS or your hosts file.",
  },
  {
    mode: "direct",
    label: "Direct",
    about: "Your router forwards ports 80 and 443 to the cluster and a public DNS record points at you.",
  },
];

export function CopyBlock({ value, label }: { value: string; label: string }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Code block style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {value}
      </Code>
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? "Copied" : "Copy"} withArrow>
            <ActionIcon variant="light" color={copied ? "teal" : undefined} onClick={copy} aria-label={label}>
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

// Cloudflare asks for the scheme separately; the port stays even when it is the default.
const hostPort = (url: string) => url.replace(/^[a-z]+:\/\//, "").replace(/\/+$/, "");

function Hosts({ view }: { view: AccessView }) {
  if (!view.hosts.length) {
    return (
      <Text size="sm" c="dimmed">
        No apps under {view.baseDomain} yet; they appear here once deployed.
      </Text>
    );
  }
  return (
    <Stack gap={4} data-access-hosts>
      {view.hosts.map((h) => (
        <Group key={h.host} gap="xs" data-host={h.host}>
          <Anchor href={h.url} target="_blank" rel="noreferrer" size="sm">
            {h.url}
          </Anchor>
          {h.resolves === undefined ? null : (
            <Badge size="sm" variant="light" color={h.resolves ? "green" : "yellow"}>
              {h.resolves ? "DNS set up" : "no DNS yet"}
            </Badge>
          )}
        </Group>
      ))}
    </Stack>
  );
}

// What the user does outside the cluster for the saved mode, with values to copy.
export function AccessInstructions({ view }: { view: AccessView }) {
  if (!view.mode || !view.baseDomain) return null;
  let steps: ReactNode;
  switch (view.mode) {
    case "cloudflare-tunnel":
      steps = (
        <>
          <Text size="sm">
            In Cloudflare Zero Trust, open Networks &gt; Tunnels, pick this cluster&apos;s tunnel and add one public
            hostname: subdomain <b>*</b>, domain <b>{view.baseDomain}</b>, service type <b>HTTP</b>, URL:
          </Text>
          {view.ingressService ? (
            <CopyBlock value={hostPort(view.ingressService)} label="Copy service URL" />
          ) : (
            <Text size="sm" c="yellow">
              No ingress controller found yet; it appears here once one is installed.
            </Text>
          )}
          <Text size="sm">
            If Cloudflare does not add the DNS record itself, add a proxied CNAME named <b>*</b> in the{" "}
            {view.baseDomain} zone pointing at <Code>&lt;tunnel id&gt;.cfargotunnel.com</Code>.
          </Text>
        </>
      );
      break;
    case "tailscale":
      steps = (
        <Text size="sm">
          Turn on MagicDNS and HTTPS certificates in the Tailscale admin console under DNS. Each app joins your tailnet
          as its own machine; open it from any device signed in to {view.baseDomain}.
        </Text>
      );
      break;
    case "local":
      steps = (
        <>
          <Text size="sm">
            Add these names to your router, Pi-hole or AdGuard as local DNS records, or paste them into the hosts file
            of each computer that should reach the apps. A wildcard record <b>*.{view.baseDomain}</b> pointing at{" "}
            {view.ingressAddress ?? "the ingress IP"} covers every app at once.
          </Text>
          {view.hostsFile ? <CopyBlock value={view.hostsFile.trimEnd()} label="Copy hosts lines" /> : null}
        </>
      );
      break;
    case "direct":
      steps = (
        <Text size="sm">
          Add a DNS record <b>{view.wildcard}</b> pointing at your public IP, and forward ports 80 and 443 on your
          router to {view.ingressAddress ?? "the cluster's ingress"}.
        </Text>
      );
      break;
  }
  return (
    <Stack gap="xs" data-access-instructions={view.mode}>
      <Title order={5}>Finish outside the cluster</Title>
      {steps}
      <Hosts view={view} />
    </Stack>
  );
}

const DOMAIN_LABEL: Record<AccessMode, string> = {
  "cloudflare-tunnel": "Domain on Cloudflare",
  tailscale: "Tailnet DNS name",
  local: "Local domain",
  direct: "Domain",
};

const DOMAIN_HELP: Record<AccessMode, string> = {
  "cloudflare-tunnel": "Apps get names under it, like git.example.com.",
  tailscale: "Shown in the Tailscale admin console under DNS, like tail1234.ts.net.",
  local: "Apps get names under it, like git.home.arpa. home.arpa is reserved for exactly this.",
  direct: "Apps get names under it, like git.example.com.",
};

// Cloudflare Tunnel either through the connector (an API token: the tunnel,
// routes and DNS records are made for you) or by hand (a tunnel token and
// one wildcard route).
function CloudflareSetup({ view, manual }: { view: AccessView; manual: ReactNode }) {
  const [how, setHow] = useState<"api" | "manual">("api");
  return (
    <Stack gap="sm" data-cloudflare-setup={how}>
      <SegmentedControl
        value={how}
        onChange={(value) => setHow(value as "api" | "manual")}
        data={[
          { value: "api", label: "Connect with an API token (recommended)" },
          { value: "manual", label: "Paste a tunnel token" },
        ]}
      />
      {how === "api" ? (
        <>
          <Text size="sm" c="dimmed">
            The app creates the tunnel, runs cloudflared and adds a DNS record and route for every app it deploys.
          </Text>
          <CloudflarePanel baseDomain={view.baseDomain} />
        </>
      ) : (
        manual
      )}
    </Stack>
  );
}

export function AccessStep({ onFinish }: StepProps) {
  const access = useApi("GET /api/deploy/access");
  const discovery = useDiscovery();
  const [mode, setMode] = useState<AccessMode>();
  const [domain, setDomain] = useState("");
  const [saved, setSaved] = useState<AccessView>();
  const [filled, setFilled] = useState(false);
  const action = useAction();

  useEffect(() => {
    if (access.data) setSaved(access.data);
  }, [access.data]);

  useEffect(() => {
    if (filled || !access.data) return;
    if (access.data.mode) setMode(access.data.mode);
    const suggested = discovery.report?.suggested.baseDomain;
    if (!access.data.baseDomain && !suggested && discovery.loading) return;
    setDomain(access.data.baseDomain ?? suggested ?? "");
    setFilled(true);
  }, [access.data, discovery.report, discovery.loading, filled]);

  if (!access.data && !access.error) return <Loader size="sm" />;

  async function save() {
    if (!mode) return;
    const next = await action.run(() =>
      apiRequest("PUT /api/deploy/access", { body: { mode, baseDomain: domain.trim() } })
    );
    if (next) setSaved(next);
  }

  const current = saved?.mode === mode && saved?.baseDomain === domain.trim().toLowerCase() ? saved : undefined;
  const app = current?.appId ? discovery.app(current.appId) : undefined;
  const manual = (
    <>
      {current && app ? (
        <AppOffer
          app={app}
          onDeployed={() => {
            discovery.refresh();
            access.reload();
          }}
        />
      ) : null}
      {current ? <AccessInstructions view={current} /> : null}
    </>
  );

  return (
    <StepFrame
      what="How you and others open the apps this cluster runs. It decides how every app is published, so pick it before deploying apps."
      intro="Pick one; you can change it later. Apps deployed after this follow it."
      canFinish={current !== undefined}
      onFinish={onFinish}
    >
      {access.error ? <Alert color="red">{access.error}</Alert> : null}
      <Radio.Group value={mode ?? null} onChange={(value) => setMode(value as AccessMode)} data-access-modes>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          {ACCESS_MODES.map((m) => (
            <Radio.Card key={m.mode} value={m.mode} p="sm" withBorder data-mode={m.mode}>
              <Group wrap="nowrap" align="flex-start">
                <Radio.Indicator />
                <Stack gap={2}>
                  <Text fw={600} size="sm">
                    {m.label}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {m.about}
                  </Text>
                </Stack>
              </Group>
            </Radio.Card>
          ))}
        </SimpleGrid>
      </Radio.Group>
      {mode ? (
        <Group align="flex-end">
          <TextInput
            label={DOMAIN_LABEL[mode]}
            description={DOMAIN_HELP[mode]}
            value={domain}
            onChange={(e) => setDomain(e.currentTarget.value)}
            spellCheck={false}
            style={{ flex: 1 }}
          />
          <Button loading={action.busy} disabled={!domain.trim()} onClick={() => void save()}>
            Save
          </Button>
        </Group>
      ) : null}
      {action.error ? <Alert color="red">{action.error}</Alert> : null}
      {current?.mode === "cloudflare-tunnel" ? (
        <CloudflareSetup view={current} manual={manual} />
      ) : (
        manual
      )}
    </StepFrame>
  );
}
