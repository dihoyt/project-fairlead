import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Before anything reads the environment; variables already set win over the file.
if (existsSync(".env")) process.loadEnvFile(".env");

const { createApp } = await import("./app.js");
const { modules } = await import("./modules/index.js");
const { createPlatform } = await import("./platform/index.js");
const { readConfig } = await import("./runtime/config.js");
const { openDatabase } = await import("./runtime/db.js");
const { createRuntime } = await import("./runtime/index.js");
const { product } = await import("./product.js");

const config = readConfig();
const db = openDatabase(config.dbPath);
const runtime = await createRuntime({ db, dataDir: config.dataDir, modules, createPlatform });
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const app = createApp(runtime, { publicDir, version: config.version });

const server = app.listen(config.port, config.host, () => {
  runtime.log.info(`${product.displayName} listening`, {
    port: config.port,
    host: config.host,
    db: config.dbPath,
    version: config.version,
  });
});

runtime.platform.handleSignals(server, async () => {
  await runtime.stop();
  db.close();
});
