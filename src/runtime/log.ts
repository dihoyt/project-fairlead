import type { Logger } from "../contracts/runtime.js";

// One JSON object per line, so the cluster's log tooling can parse it.
export function createLogger(scope: string, write: (line: string) => void = (line) => console.log(line)): Logger {
  const emit = (level: string, message: string, detail?: Record<string, unknown>) =>
    write(JSON.stringify({ ts: new Date().toISOString(), level, scope, message, ...detail }));
  return {
    info: (message, detail) => emit("info", message, detail),
    warn: (message, detail) => emit("warn", message, detail),
    error: (message, detail) => emit("error", message, detail),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
