import type { ChannelRequest, ChannelView, TestSendResult } from "@contracts/notify";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(new URL(`api/notify/${path}`, document.baseURI), {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const notifyApi = {
  list: () => call<ChannelView[]>("GET", "channels"),
  create: (req: ChannelRequest) => call<ChannelView>("POST", "channels", req),
  update: (id: string, req: ChannelRequest) => call<ChannelView>("PUT", `channels/${encodeURIComponent(id)}`, req),
  remove: (id: string) => call<{ ok: true }>("DELETE", `channels/${encodeURIComponent(id)}`),
  test: (id: string) => call<TestSendResult>("POST", `channels/${encodeURIComponent(id)}/test`),
};
