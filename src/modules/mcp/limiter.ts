// A fixed window per key. In memory, so per pod: during a rollout two pods
// each allow the limit, which is fine for a guard against a runaway client.
export function createRateLimiter(windowMs: number, maxKeys = 1000) {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    // 0 when allowed; otherwise how long until the window resets, in ms.
    take(key: string, limit: number, now = Date.now()): number {
      let entry = windows.get(key);
      if (!entry || now - entry.start >= windowMs) {
        windows.delete(key);
        if (windows.size >= maxKeys) windows.delete(windows.keys().next().value!);
        entry = { start: now, count: 0 };
        windows.set(key, entry);
      }
      if (entry.count >= limit) return entry.start + windowMs - now;
      entry.count += 1;
      return 0;
    },
  };
}
