import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";

// Starts an app on an ephemeral loopback port for the test's duration.
export async function listen(app: Express): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
