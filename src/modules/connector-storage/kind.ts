import net from "node:net";
import {
  STORAGE_TARGET_KIND,
  type ConnectorField,
  type ConnectorInstance,
  type ConnectorKind,
  type ConnectorValues,
  type StorageProtocol,
} from "../../contracts/connectors.js";
import type { CheckResult, Status } from "../../contracts/health.js";
import { awsEndpoint, listObjects, type Fetch } from "./s3.js";
import { isProtocol, parseTarget, type ParsedTarget } from "./url.js";

const TCP_TIMEOUT_MS = 5_000;
const S3_TIMEOUT_MS = 10_000;

export const PORTS: Record<Exclude<StorageProtocol, "s3">, number> = { nfs: 2049, smb: 445 };

const s3Only = { key: "protocol", values: ["s3"] };
const smbOnly = { key: "protocol", values: ["smb"] };

export const FIELDS: ConnectorField[] = [
  {
    key: "protocol",
    label: "Protocol",
    type: "select",
    required: true,
    options: [
      { value: "nfs", label: "NFS export" },
      { value: "s3", label: "S3 or MinIO bucket" },
      { value: "smb", label: "SMB/CIFS share" },
    ],
  },
  {
    key: "url",
    label: "Target URL",
    type: "text",
    required: true,
    help: "nfs://server:/export, s3://bucket@region/ or cifs://server/share",
    placeholder: "nfs://nas.example.com:/backups",
  },
  { key: "path", label: "Path prefix", type: "text", required: false, help: "A folder under it, for this cluster." },
  {
    key: "endpoint",
    label: "S3 endpoint",
    type: "url",
    required: false,
    help: "MinIO or another S3-compatible server; empty for AWS.",
    placeholder: "https://minio.example.com:9000",
    showWhen: s3Only,
  },
  { key: "accessKeyId", label: "Access key ID", type: "text", required: false, showWhen: s3Only },
  { key: "secretAccessKey", label: "Secret access key", type: "secret", required: false, showWhen: s3Only },
  { key: "username", label: "Username", type: "text", required: false, showWhen: smbOnly },
  { key: "password", label: "Password", type: "secret", required: false, showWhen: smbOnly },
];

// The fields each protocol needs besides protocol and url.
const NEEDS: Record<StorageProtocol, string[]> = {
  nfs: [],
  s3: ["accessKeyId", "secretAccessKey"],
  smb: ["username", "password"],
};

export interface StorageKindDeps {
  // Tests replace the network.
  connect?: (host: string, port: number, signal: AbortSignal) => Promise<void>;
  fetch?: Fetch;
  now?: () => Date;
  // Longhorn's view of an instance's target, for health: a "crit" or "ok"
  // check once Longhorn has tried it, undefined while it points elsewhere.
  longhornCheck?: (instance: ConnectorInstance) => Promise<CheckResult | undefined>;
}

export interface Settled {
  protocol: StorageProtocol;
  target: ParsedTarget;
  // "host:port" the console checks.
  host: string;
  port: number;
  endpoint?: string;
}

// The protocol, the parsed URL and where to knock, or one sentence why not.
// Credentials aren't looked at.
export function locate(values: ConnectorValues): Settled | { error: string } {
  const protocol = (values.protocol ?? "").trim();
  if (!isProtocol(protocol)) return { error: 'Protocol must be "nfs", "s3" or "smb".' };
  const target = parseTarget(protocol, values.url ?? "");
  if ("error" in target) return target;
  if (target.protocol === "s3") {
    const endpoint = values.endpoint?.trim() || awsEndpoint(target.region);
    const url = new URL(endpoint);
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return { protocol, target, host: url.hostname.replace(/^\[|\]$/g, ""), port, endpoint };
  }
  return { protocol, target, host: target.server.replace(/^\[|\]$/g, ""), port: PORTS[target.protocol] };
}

// locate(), and the credentials the protocol needs are there.
export function settle(values: ConnectorValues): Settled | { error: string } {
  const located = locate(values);
  if ("error" in located) return located;
  const missing = NEEDS[located.protocol].filter((key) => !values[key]?.trim());
  if (missing.length > 0) {
    const labels = missing.map((key) => FIELDS.find((f) => f.key === key)!.label);
    return {
      error: `${labels.join(" and ")} ${missing.length === 1 ? "is" : "are"} required for ${located.protocol}.`,
    };
  }
  return located;
}

function defaultConnect(host: string, port: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, signal });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

const reasonOf = (err: unknown): string => {
  const e = err as NodeJS.ErrnoException;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "did not answer in time";
  switch (e?.code) {
    case "ECONNREFUSED":
      return "refused the connection";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "does not resolve from the console";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "is unreachable from the console";
    case "ETIMEDOUT":
      return "did not answer in time";
    default:
      return `failed: ${e?.message ?? String(err)}`;
  }
};

const PORT_LABEL: Record<StorageProtocol, string> = { nfs: "NFS port", s3: "Endpoint", smb: "SMB port" };

// What an S3 answer means, in one sentence for the admin.
function s3Detail(status: number, code: string | undefined, bucket: string): { status: Status; detail: string } {
  if (status === 200) return { status: "ok", detail: `Listed ${bucket} with the access key` };
  switch (code) {
    case "NoSuchBucket":
      return { status: "crit", detail: `Bucket ${bucket} does not exist on this endpoint` };
    case "InvalidAccessKeyId":
      return { status: "crit", detail: "The access key ID is not known to this endpoint" };
    case "SignatureDoesNotMatch":
      return { status: "crit", detail: "The secret access key does not match the access key ID" };
    case "AccessDenied":
      return { status: "crit", detail: `The access key may not list ${bucket}; it needs list, read and write on it` };
    case "PermanentRedirect":
    case "AuthorizationHeaderMalformed":
      return { status: "crit", detail: `${bucket} is in another region than the URL says` };
    default:
      return {
        status: "crit",
        detail: `The endpoint answered ${status}${code ? ` ${code}` : ""} to a bucket listing`,
      };
  }
}

export function createStorageKind(deps: StorageKindDeps = {}): ConnectorKind {
  const connect = deps.connect ?? defaultConnect;
  const fetchFn: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => new Date());
  const check = (id: string, label: string, status: Status, detail: string, raw?: unknown): CheckResult => ({
    id,
    label,
    status,
    detail,
    observedAt: now().toISOString(),
    ...(raw === undefined ? {} : { raw }),
  });

  async function verify(values: ConnectorValues, signal: AbortSignal): Promise<CheckResult[]> {
    const settled = settle(values);
    if ("error" in settled) {
      return [check("config", "Settings", "crit", settled.error, { protocol: values.protocol, url: values.url })];
    }
    const { protocol, target, host, port } = settled;
    const where = `${host.includes(":") ? `[${host}]` : host}:${port}`;
    const started = Date.now();
    try {
      await connect(host, port, AbortSignal.any([signal, AbortSignal.timeout(TCP_TIMEOUT_MS)]));
    } catch (err) {
      return [
        check("tcp", PORT_LABEL[protocol], "crit", `${where} ${reasonOf(err)}`, {
          error: (err as Error).message,
          code: (err as NodeJS.ErrnoException).code,
        }),
      ];
    }
    const took = `${where} accepts connections (${Date.now() - started} ms)`;
    if (target.protocol !== "s3") {
      // A mount needs privileges the console doesn't have; Longhorn's own
      // attempt is the proof, reported by health once it is the target.
      return [
        check("tcp", PORT_LABEL[protocol], "ok", `${took}; Longhorn proves the mount once it is the backup target`),
      ];
    }
    const checks = [check("tcp", PORT_LABEL[protocol], "ok", took)];
    const prefix = [target.path, values.path ?? ""]
      .flatMap((p) => p.split("/"))
      .filter(Boolean)
      .join("/");
    try {
      const result = await listObjects(
        {
          endpoint: settled.endpoint,
          bucket: target.bucket,
          region: target.region,
          ...(prefix ? { prefix: `${prefix}/` } : {}),
          accessKeyId: values.accessKeyId!.trim(),
          secretAccessKey: values.secretAccessKey!.trim(),
          now: now(),
        },
        fetchFn,
        AbortSignal.any([signal, AbortSignal.timeout(S3_TIMEOUT_MS)])
      );
      const judged = s3Detail(result.status, result.code, target.bucket);
      checks.push(
        check(
          "list",
          "Bucket access",
          judged.status,
          judged.detail,
          judged.status === "ok" ? undefined : { status: result.status, code: result.code, message: result.message }
        )
      );
    } catch (err) {
      checks.push(
        check("list", "Bucket access", "crit", `The bucket listing ${reasonOf(err)}`, { error: (err as Error).message })
      );
    }
    return checks;
  }

  return {
    kind: STORAGE_TARGET_KIND,
    label: "Storage target",
    description:
      "A place backups go: an NFS export, an S3 or MinIO bucket, or an SMB/CIFS share. " +
      "S3 needs an access key that can list, read and write the bucket; SMB a user that can write the share.",
    capabilities: ["backup-target"],
    fields: FIELDS,
    single: false,
    verify,
    async health(instance, signal) {
      const checks = await verify({ ...instance.config, ...instance.secrets }, signal);
      const longhorn = await deps.longhornCheck?.(instance).catch(() => undefined);
      if (!longhorn) return checks;
      return [...checks, longhorn];
    },
  };
}
