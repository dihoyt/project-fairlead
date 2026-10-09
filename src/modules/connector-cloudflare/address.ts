import { isIP } from "node:net";

// Each answers with the caller's address: plain text, or Cloudflare's trace
// format ("ip=203.0.113.7" among other lines). Tried in order.
export const DEFAULT_ADDRESS_LOOKUP =
  "https://cloudflare.com/cdn-cgi/trace https://icanhazip.com https://api.ipify.org";

const LOOKUP_TIMEOUT_MS = 5_000;

export function lookupUrls(setting: string): string[] {
  return setting.split(/[\s,]+/).filter(Boolean);
}

// The address this cluster's traffic leaves from, which behind a home
// router's NAT is the router's public IP: what a DNS-only record must point
// at. Throws one sentence naming every lookup that failed.
export async function detectPublicAddress(urls: string[], signal?: AbortSignal): Promise<string> {
  const failures: string[] = [];
  for (const url of urls) {
    try {
      const timeout = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
      const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = (await res.text()).trim();
      const address = (/^ip=(.+)$/m.exec(text)?.[1] ?? text).trim();
      if (!isIP(address)) throw new Error("no address in the answer");
      return address;
    } catch (err) {
      failures.push(`${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(
    `Couldn't look up this cluster's public address (${failures.join("; ") || "no lookup URLs"}); set Public address on the connector`
  );
}
