// Fails if the product's name appears anywhere it shouldn't: outside
// product.json, docs (*.md, docs/) and lines marked `# brand:generated`.
// Runs in CI so the name stays in exactly one place.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isBinary, MARKER, readProduct, repoFiles } from "./brand-lib.mjs";

const root = path.resolve(process.argv[2] ?? ".");
const product = readProduct(root);
const terms = [
  ...new Set([product.slug, product.displayName, product.imageName, product.chartName].map((t) => t.toLowerCase())),
];

const allowed = (file) =>
  file === "product.json" || file === "LICENSE" || file.endsWith(".md") || file.startsWith("docs/");

const hits = [];
for (const file of repoFiles(root)) {
  const full = path.join(root, file);
  if (allowed(file) || !existsSync(full)) continue;
  const buffer = readFileSync(full);
  if (isBinary(buffer)) continue;
  buffer
    .toString("utf8")
    .split("\n")
    .forEach((line, index) => {
      if (line.includes(MARKER)) return;
      const lower = line.toLowerCase();
      if (terms.some((term) => lower.includes(term))) hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 160)}`);
    });
}

if (hits.length > 0) {
  console.error(`The product name appears outside product.json (${hits.length}):`);
  for (const hit of hits) console.error(`  ${hit}`);
  console.error("Read it from product.json (server: src/product.ts, client: client/src/product.ts) instead.");
  process.exit(1);
}
console.log("brand:check passed.");
