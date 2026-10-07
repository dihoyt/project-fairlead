import type { CheckRequest, CheckView } from "@contracts/checks";
import type { CheckResult } from "@contracts/health";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(new URL(`api/checks${path}`, document.baseURI), {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const checksApi = {
  list: () => call<CheckView[]>("GET", ""),
  create: (req: CheckRequest) => call<CheckView>("POST", "", req),
  update: (id: string, req: CheckRequest) => call<CheckView>("PUT", `/${encodeURIComponent(id)}`, req),
  remove: (id: string) => call<{ ok: true }>("DELETE", `/${encodeURIComponent(id)}`),
  run: (id: string) => call<CheckResult>("POST", `/${encodeURIComponent(id)}/run`),
};
