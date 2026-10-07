import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Group, ScrollArea, Select, Switch, Text, Tooltip } from "@mantine/core";
import { IconPlayerPause, IconPlayerPlay, IconRefresh } from "@tabler/icons-react";
import type { PodView } from "@contracts/workloads";
import { ApiError, apiRequest, routeUrl } from "../../ui";

// Lines kept in the browser while following; older ones drop off the top.
const KEEP_LINES = 5000;
const TAILS = ["100", "500", "1000", "5000"];

type Mode = { kind: "snapshot" } | { kind: "follow" };

export function LogViewer({ pod }: { pod: PodView }) {
  const [container, setContainer] = useState(pod.containers[0]?.name ?? "");
  const [tail, setTail] = useState("500");
  const [previous, setPrevious] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "snapshot" });
  const [lines, setLines] = useState<string[]>([]);
  const [meta, setMeta] = useState<{ redacted: number; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reloads, setReloads] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const params = { namespace: pod.namespace, pod: pod.name };
    setError(null);
    setEnded(false);
    if (mode.kind === "snapshot") {
      const controller = new AbortController();
      setLoading(true);
      apiRequest("GET /api/workloads/namespaces/:namespace/pods/:pod/logs", {
        params,
        query: { container, tail, ...(previous ? { previous: "1" as const } : {}) },
        signal: controller.signal,
      })
        .then((res) => {
          setLines(res.lines);
          setMeta({ redacted: res.redacted, truncated: res.truncated });
        })
        .catch((err: unknown) => {
          if ((err as Error).name === "AbortError") return;
          setLines([]);
          setMeta(null);
          setError(err instanceof ApiError ? err.message : String(err));
        })
        .finally(() => setLoading(false));
      return () => controller.abort();
    }

    setLines([]);
    setMeta(null);
    const source = new EventSource(
      routeUrl("GET /api/workloads/namespaces/:namespace/pods/:pod/logs/stream", { params, query: { container, tail } })
    );
    source.addEventListener("message", (event: MessageEvent<string>) => {
      const { line } = JSON.parse(event.data) as { line: string };
      setLines((prev) => (prev.length >= KEEP_LINES ? [...prev.slice(-KEEP_LINES + 1), line] : [...prev, line]));
    });
    // EventSource reconnects on its own and would replay the tail; a
    // stream that ends here stays ended until the user resumes it.
    source.addEventListener("error", () => {
      source.close();
      setEnded(true);
    });
    return () => source.close();
  }, [pod.namespace, pod.name, container, tail, previous, mode, reloads]);

  useEffect(() => {
    if (stick.current && viewport.current) viewport.current.scrollTo({ top: viewport.current.scrollHeight });
  }, [lines]);

  const following = mode.kind === "follow" && !ended;

  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" mb="xs" wrap="wrap" gap="sm">
        <Group gap="sm" wrap="wrap">
          {pod.containers.length > 1 ? (
            <Select
              size="xs"
              w={180}
              aria-label="Container"
              data={pod.containers.map((c) => c.name)}
              value={container}
              onChange={(value) => value && setContainer(value)}
              allowDeselect={false}
            />
          ) : null}
          <Select
            size="xs"
            w={130}
            aria-label="Lines"
            data={TAILS.map((value) => ({ value, label: `Last ${value}` }))}
            value={tail}
            onChange={(value) => value && setTail(value)}
            allowDeselect={false}
          />
          <Tooltip label="The log of the container's previous run, from before its last restart">
            <Switch
              size="xs"
              label="Previous run"
              checked={previous}
              disabled={mode.kind === "follow"}
              onChange={(e) => setPrevious(e.currentTarget.checked)}
            />
          </Tooltip>
        </Group>
        <Group gap="xs">
          {meta?.redacted ? (
            <Tooltip label="Lines with a secret value or credential in them were masked">
              <Badge size="sm" variant="light" color="gray" radius="xs">
                {meta.redacted} masked
              </Badge>
            </Tooltip>
          ) : null}
          {following ? (
            <Badge size="sm" variant="dot" color="teal" radius="xs">
              Following
            </Badge>
          ) : null}
          {mode.kind === "follow" && ended ? (
            <Badge size="sm" variant="light" color="gray" radius="xs">
              Stream ended
            </Badge>
          ) : null}
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconRefresh size={14} />}
            loading={loading}
            onClick={() => setReloads((n) => n + 1)}
          >
            {mode.kind === "follow" && ended ? "Resume" : "Reload"}
          </Button>
          <Button
            size="compact-xs"
            variant={mode.kind === "follow" ? "light" : "filled"}
            leftSection={mode.kind === "follow" ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
            onClick={() => {
              setPrevious(false);
              setMode(mode.kind === "follow" ? { kind: "snapshot" } : { kind: "follow" });
            }}
          >
            {mode.kind === "follow" ? "Stop following" : "Follow"}
          </Button>
        </Group>
      </Group>
      {error ? (
        <Alert color="yellow" variant="light" mb="xs">
          {error}
        </Alert>
      ) : null}
      <ScrollArea
        h={480}
        viewportRef={viewport}
        type="auto"
        onScrollPositionChange={({ y }) => {
          const el = viewport.current;
          if (el) stick.current = el.scrollHeight - el.clientHeight - y < 24;
        }}
        bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))"
        style={{ borderRadius: "var(--mantine-radius-xs)" }}
      >
        <Text
          component="pre"
          ff="monospace"
          size="xs"
          p="xs"
          m={0}
          style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
        >
          {lines.length > 0 ? lines.join("\n") : loading ? "" : following ? "Waiting for output…" : "No output."}
        </Text>
      </ScrollArea>
      {meta?.truncated ? (
        <Text size="xs" c="dimmed" mt={4}>
          Showing the last {lines.length} lines; earlier output is not shown.
        </Text>
      ) : null}
    </Card>
  );
}
