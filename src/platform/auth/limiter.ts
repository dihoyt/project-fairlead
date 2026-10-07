// Fixed-window failure counter. Kept in memory, so each pod counts on its
// own and a rollout resets the count; at the scale of a sign-in form that
// costs an attacker a handful of extra guesses per deploy, which is not
// worth a shared store.
export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
    setInterval(() => this.prune(), windowMs).unref();
  }

  isBlocked(key: string): boolean {
    const entry = this.hits.get(key);
    return entry !== undefined && entry.resetAt > Date.now() && entry.count >= this.max;
  }

  retryAfterSeconds(key: string): number {
    const entry = this.hits.get(key);
    return entry ? Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)) : 0;
  }

  fail(key: string): void {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (entry === undefined || entry.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count += 1;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

// Per username can't be dodged by rotating addresses; per address catches
// spraying one password across many usernames.
export function createLoginLimits(): { byUser: FailureLimiter; byIp: FailureLimiter } {
  return { byUser: new FailureLimiter(5, FIFTEEN_MINUTES), byIp: new FailureLimiter(20, FIFTEEN_MINUTES) };
}
