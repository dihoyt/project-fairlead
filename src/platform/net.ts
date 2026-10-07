import net from "node:net";
import type { Request } from "express";

// Who is on the other end of a request, as far as anything here can know.
//
// A forwarding header is a claim made by whoever sent the request, so it
// is believed only when the socket peer is a proxy the operator has named
// in TRUSTED_PROXIES. Without that, anyone who can reach the pod directly
// could send `X-Forwarded-For: <an allowed address>` and walk through a
// network rule. The default is to trust nothing and use the socket
// address, which is wrong behind a proxy (every request appears to come
// from it) but never wrong in the dangerous direction.

export interface Cidr {
  text: string;
  family: 4 | 6;
  bytes: Buffer;
  prefix: number;
}

// IPv4-mapped IPv6 (::ffff:a.b.c.d) is how Node reports an IPv4 peer on a
// dual-stack socket. Folding it back means a rule written as 10.0.0.0/8
// matches the address the operator thinks of, whichever socket accepted it.
export function normalizeIp(raw: string): string {
  const trimmed = raw.trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  return mapped ? mapped[1] : trimmed;
}

function ipBytes(ip: string): { family: 4 | 6; bytes: Buffer } | null {
  const family = net.isIP(ip);
  if (family === 4) return { family: 4, bytes: Buffer.from(ip.split(".").map(Number)) };
  if (family !== 6) return null;
  // Expand :: and any embedded IPv4 tail into eight 16-bit groups.
  let text = ip;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4[1].split(".").map(Number);
    text = text.slice(0, -v4[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const bytes = Buffer.alloc(16);
  groups.forEach((group, i) => bytes.writeUInt16BE(parseInt(group, 16), i * 2));
  return { family: 6, bytes };
}

export function parseCidr(raw: string): Cidr | null {
  const text = raw.trim();
  const [addr, bits] = text.split("/");
  const parsed = ipBytes(normalizeIp(addr ?? ""));
  if (parsed === null) return null;
  const max = parsed.family === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (bits !== undefined && !/^\d+$/.test(bits)))
    return null;
  return { text, family: parsed.family, bytes: parsed.bytes, prefix };
}

// Throws with the offending entry named, so a form can say which line is
// wrong rather than that the list is.
export function parseCidrList(entries: readonly string[]): Cidr[] {
  return entries.map((entry) => {
    const cidr = parseCidr(entry);
    if (cidr === null) throw new Error(`"${entry}" is not an IP address or CIDR range.`);
    return cidr;
  });
}

export function cidrContains(cidr: Cidr, ip: string): boolean {
  const parsed = ipBytes(normalizeIp(ip));
  if (parsed === null || parsed.family !== cidr.family) return false;
  const whole = Math.floor(cidr.prefix / 8);
  if (!parsed.bytes.subarray(0, whole).equals(cidr.bytes.subarray(0, whole))) return false;
  const rest = cidr.prefix % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (parsed.bytes[whole] & mask) === (cidr.bytes[whole] & mask);
}

export function inAny(cidrs: readonly Cidr[], ip: string): boolean {
  return cidrs.some((cidr) => cidrContains(cidr, ip));
}

export type ClientIpHeader = "none" | "x-forwarded-for" | "x-real-ip" | "cf-connecting-ip";
const HEADERS: readonly ClientIpHeader[] = ["none", "x-forwarded-for", "x-real-ip", "cf-connecting-ip"];

export interface ProxyTrust {
  header: ClientIpHeader;
  proxies: Cidr[];
}

// Read per call, like the rest of the config: a test can vary it, and an
// operator who got it wrong is corrected by a restart at worst.
export function proxyTrustFromEnv(source: NodeJS.ProcessEnv = process.env): ProxyTrust {
  const rawHeader = (source.CLIENT_IP_HEADER ?? "none").trim().toLowerCase();
  const header = HEADERS.find((candidate) => candidate === rawHeader);
  if (header === undefined) {
    throw new Error(`CLIENT_IP_HEADER must be one of ${HEADERS.join(", ")}; got "${source.CLIENT_IP_HEADER}".`);
  }
  const proxies = parseCidrList(
    (source.TRUSTED_PROXIES ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
  return { header, proxies };
}

function firstHeader(req: Request, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : (value ?? "")).trim();
}

export function clientIp(req: Request, trust: ProxyTrust = proxyTrustFromEnv()): string {
  const peer = normalizeIp(req.socket?.remoteAddress ?? "");
  if (trust.header === "none" || !inAny(trust.proxies, peer)) return peer;

  if (trust.header === "x-forwarded-for") {
    // Each proxy appends the address it received from, so the list reads
    // client-first and the right end is the hop nearest us. Walking from
    // the right and skipping our own proxies finds the first address no
    // trusted hop vouches for — anything left of it the client could have
    // written itself.
    const hops = firstHeader(req, "x-forwarded-for")
      .split(",")
      .map((hop) => normalizeIp(hop))
      .filter((hop) => net.isIP(hop) !== 0);
    for (let i = hops.length - 1; i >= 0; i -= 1) {
      if (!inAny(trust.proxies, hops[i])) return hops[i];
    }
    return hops[0] ?? peer;
  }

  const claimed = normalizeIp(firstHeader(req, trust.header));
  return net.isIP(claimed) !== 0 ? claimed : peer;
}
