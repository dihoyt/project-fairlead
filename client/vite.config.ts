import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Relative, not "/": the app may be served under a path prefix (an
  // ingress path, a dev proxy), and absolute asset URLs would miss it.
  base: "./",
  resolve: {
    alias: { "@contracts": path.resolve(here, "../src/contracts") },
  },
  server: {
    // product.json and src/contracts sit outside the client root.
    fs: { allow: [path.resolve(here, "..")] },
    proxy: { "/api": "http://127.0.0.1:8080", "/auth": "http://127.0.0.1:8080" },
  },
  build: {
    // Express serves ../public; emptied so old hashed bundles don't pile up.
    outDir: "../public",
    emptyOutDir: true,
  },
});
