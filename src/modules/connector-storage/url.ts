import type { StorageProtocol } from "../../contracts/connectors.js";

// A storage target's URL, taken apart. Longhorn's forms only:
// nfs://server:/export, s3://bucket@region/path/, cifs://server/share/path.
export type ParsedTarget =
  | { protocol: "nfs"; server: string; path: string }
  | { protocol: "s3"; bucket: string; region: string; path: string }
  | { protocol: "smb"; server: string; share: string; path: string };

export const PROTOCOLS: readonly StorageProtocol[] = ["nfs", "s3", "smb"];

export const isProtocol = (value: string): value is StorageProtocol => (PROTOCOLS as readonly string[]).includes(value);

const EXAMPLES: Record<StorageProtocol, string> = {
  nfs: "nfs://server:/export",
  s3: "s3://bucket@region/",
  smb: "cifs://server/share",
};

// "/a//b/" -> "a/b"
const segments = (path: string) => path.split("/").filter(Boolean).join("/");

const NFS = /^nfs:\/\/(\[[0-9a-fA-F:.]+\]|[^/:@\s]+)(?::\d*)?:?(\/[^\s?#]*)$/;
const S3 = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])@([a-z0-9-]+)(\/[^\s?#]*)?$/;
const SMB = /^cifs:\/\/(\[[0-9a-fA-F:.]+\]|[^/:@\s]+)\/([^/\s?#]+)(\/[^\s?#]*)?$/;

// The URL as given, or why it isn't one Longhorn takes for this protocol.
export function parseTarget(protocol: StorageProtocol, url: string): ParsedTarget | { error: string } {
  const value = url.trim();
  const expect = `Use ${EXAMPLES[protocol]}.`;
  if (protocol === "nfs") {
    const m = NFS.exec(value);
    if (!m) return { error: `"${value}" is not an NFS target URL. ${expect}` };
    return { protocol, server: m[1]!, path: `/${segments(m[2]!)}` };
  }
  if (protocol === "s3") {
    const m = S3.exec(value);
    if (!m) return { error: `"${value}" is not an S3 target URL. ${expect}` };
    return { protocol, bucket: m[1]!, region: m[2]!, path: segments(m[3] ?? "") };
  }
  if (/^smb:\/\//i.test(value)) return { error: `Longhorn takes SMB shares as cifs://, not smb://. ${expect}` };
  const m = SMB.exec(value);
  if (!m) return { error: `"${value}" is not an SMB target URL. ${expect}` };
  return { protocol, server: m[1]!, share: m[2]!, path: segments(m[3] ?? "") };
}

const join = (...parts: string[]) => parts.map(segments).filter(Boolean).join("/");

// The URL Longhorn's BackupTarget gets: the parsed URL with the path prefix
// under it, in one normal form so two spellings of a target compare equal.
export function targetUrl(target: ParsedTarget, prefix = ""): string {
  switch (target.protocol) {
    case "nfs":
      return `nfs://${target.server}:/${join(target.path, prefix)}`;
    case "s3": {
      const path = join(target.path, prefix);
      return `s3://${target.bucket}@${target.region}/${path ? `${path}/` : ""}`;
    }
    case "smb":
      return `cifs://${target.server}/${join(target.share, target.path, prefix)}`;
  }
}

// For comparing with what Longhorn holds, which may differ in a trailing
// slash or a stray port colon.
const norm = (u: string) =>
  u
    .trim()
    .replace(/^(nfs:\/\/[^/]+?):\d*:?\//, "$1:/")
    .replace(/\/+$/, "")
    .toLowerCase();

export function sameTarget(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

export const serverOf = (target: ParsedTarget): string =>
  target.protocol === "s3" ? "" : target.server.replace(/^\[|\]$/g, "");
