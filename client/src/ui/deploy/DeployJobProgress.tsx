import { useContext, useEffect, useRef, useState } from "react";
import { Alert, Anchor, Badge, Button, Card, Group, Loader, ScrollArea, Stack, Text, Tooltip } from "@mantine/core";
import { IconExternalLink, IconPlayerStop } from "@tabler/icons-react";
import type { DeployJobView } from "@contracts/deploy";
import { ApiError, apiRequest, routeUrl, useApi } from "../api";
import type { DeployJobProgressProps } from "../contracts";
import { SessionContext } from "../session";
import { relativeTime } from "../time";
import { JOB_STATE_COLOR, isFinished } from "./jobs";

const POLL_MS = 2_000;
// Lines kept in the browser while following; older ones drop off the top.
const KEEP_LINES = 2_000;

export function DeployJobProgress({ jobId, follow = true, onFinished }: DeployJobProgressProps) {
  const session = useContext(SessionContext);
  const [finished, setFinished] = useState(false);
  const job = useApi("GET /api/deploy/jobs/:id", { params: { id: jobId } }, { pollMs: finished ? undefined : POLL_MS });
  const [cancelled, setCancelled] = useState<DeployJobView | null>(null);
  const view = cancelled ?? job.data;
  const state = view?.state;
  const done = state !== undefined && isFinished(state);

  const [lines, setLines] = useState<string[]>([]);
  const [redacted, setRedacted] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const reported = useRef<string | null>(null);

  useEffect(() => {
    if (done) setFinished(true);
  }, [done]);

  useEffect(() => {
    if (!view || !done || reported.current === view.id) return;
    reported.current = view.id;
    onFinished?.(view);
  }, [view, done, onFinished]);

  // While the job runs the log follows the stream; a snapshot is taken when
  // it ends (or the stream does), which also carries the masked-line count.
  const live = follow && state !== undefined && !done && typeof EventSource !== "undefined";
  const [streamEnded, setStreamEnded] = useState(false);

  useEffect(() => {
    if (!live || streamEnded) return;
    setLines([]);
    setStreaming(true);
    const source = new EventSource(routeUrl("GET /api/deploy/jobs/:id/logs/stream", { params: { id: jobId } }));
    source.addEventListener("message", (event: MessageEvent<string>) => {
      const { line } = JSON.parse(event.data) as { line: string };
      setLines((prev) => (prev.length >= KEEP_LINES ? [...prev.slice(-KEEP_LINES + 1), line] : [...prev, line]));
    });
    // EventSource would reconnect and replay; the snapshot takes over instead.
    source.addEventListener("error", () => {
      source.close();
      setStreaming(false);
      setStreamEnded(true);
    });
    return () => {
      source.close();
      setStreaming(false);
    };
  }, [live, streamEnded, jobId]);

  const snapshot = state !== undefined && (!live || streamEnded);
  const snapshotKey = snapshot ? `${state}:${streamEnded}` : null;

  useEffect(() => {
    if (snapshotKey === null) return;
    const controller = new AbortController();
    apiRequest("GET /api/deploy/jobs/:id/logs", { params: { id: jobId }, signal: controller.signal })
      .then((res) => {
        setLines(res.lines);
        setRedacted(res.redacted);
        setTruncated(res.truncated);
        setLogError(null);
      })
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
        setLogError(err instanceof ApiError ? err.message : String(err));
      });
    return () => controller.abort();
  }, [snapshotKey, jobId]);

  useEffect(() => {
    const el = viewport.current;
    if (stick.current && el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      setCancelled(await apiRequest("POST /api/deploy/jobs/:id/cancel", { params: { id: jobId } }));
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  }

  if (!view) {
    return job.error ? (
      <Alert color="red" variant="light">
        {job.error}
      </Alert>
    ) : (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Loading the job…
        </Text>
      </Group>
    );
  }

  const canCancel = !done && (session?.me.admin ?? true);

  return (
    <Stack gap="xs" data-job-state={view.state}>
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="xs" wrap="wrap">
          <Badge color={JOB_STATE_COLOR[view.state]} variant={done ? "light" : "dot"} radius="xs">
            {view.mode === "dry-run" ? `dry run ${view.state}` : view.state}
          </Badge>
          <Text size="sm">
            {view.release} {view.version} into {view.namespace}
          </Text>
          <Text size="xs" c="dimmed">
            {view.finishedAt
              ? `finished ${relativeTime(view.finishedAt)}`
              : `started ${relativeTime(view.startedAt ?? view.createdAt)}`}{" "}
            by {view.startedBy}
          </Text>
        </Group>
        <Group gap="xs">
          {redacted ? (
            <Tooltip label="Lines with a secret value in them were masked">
              <Badge size="sm" variant="light" color="gray" radius="xs">
                {redacted} masked
              </Badge>
            </Tooltip>
          ) : null}
          {streaming ? (
            <Badge size="sm" variant="dot" color="teal" radius="xs">
              Following
            </Badge>
          ) : null}
          {canCancel ? (
            <Tooltip label="Stops the job. Whatever it already applied to the cluster stays." multiline maw={260}>
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                leftSection={<IconPlayerStop size={14} />}
                loading={cancelling}
                onClick={() => void cancel()}
              >
                Cancel
              </Button>
            </Tooltip>
          ) : null}
        </Group>
      </Group>
      {view.message ? (
        <Alert
          color={view.state === "failed" ? "red" : view.state === "succeeded" ? "teal" : "gray"}
          variant="light"
          p="xs"
        >
          <Text size="sm" style={{ wordBreak: "break-word" }}>
            {view.message}
          </Text>
        </Alert>
      ) : null}
      {view.state === "succeeded" && view.url ? (
        <Anchor href={view.url} target="_blank" rel="noreferrer" size="sm">
          <Group gap={4} wrap="nowrap">
            {view.url}
            <IconExternalLink size={14} />
          </Group>
        </Anchor>
      ) : null}
      {cancelError ? (
        <Alert color="red" variant="light" p="xs">
          {cancelError}
        </Alert>
      ) : null}
      {logError ? (
        <Alert color="yellow" variant="light" p="xs">
          {logError}
        </Alert>
      ) : null}
      <Card withBorder padding={0}>
        <ScrollArea
          h={260}
          viewportRef={viewport}
          type="auto"
          onScrollPositionChange={({ y }) => {
            const el = viewport.current;
            if (el) stick.current = el.scrollHeight - el.clientHeight - y < 24;
          }}
          bg="light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))"
        >
          <Text
            component="pre"
            ff="monospace"
            size="xs"
            p="xs"
            m={0}
            data-testid="deploy-log"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
          >
            {lines.length > 0 ? lines.join("\n") : done ? "No output." : "Waiting for output…"}
          </Text>
        </ScrollArea>
      </Card>
      {truncated ? (
        <Text size="xs" c="dimmed">
          Showing the last {lines.length} lines; earlier output is not shown.
        </Text>
      ) : null}
    </Stack>
  );
}
