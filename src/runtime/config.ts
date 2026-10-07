import path from "node:path";
import { product } from "../product.js";

export interface RuntimeConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  version: string;
  production: boolean;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const dataDir = path.resolve(env.DATA_DIR || "data");
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be 1-65535, got ${env.PORT}`);
  return {
    port,
    host: env.HOST || "0.0.0.0",
    dataDir,
    // DB_PATH exists so a change to product.json's dbFile never strands an
    // existing install's database.
    dbPath: path.resolve(env.DB_PATH || path.join(dataDir, product.dbFile)),
    version: env.GIT_SHA || "dev",
    production: env.NODE_ENV === "production",
  };
}
