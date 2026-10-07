import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const MARKER = "brand:generated";

// `key: value  # brand:generated <field>` (YAML) or `KEY=value # brand:generated <field>` (shell).
export const GENERATED_LINE = /^(\s*[A-Za-z_][\w.-]*\s*[:=]\s*)(.*?)(\s+#\s*brand:generated\s+([A-Za-z]+))\s*$/;

export function readProduct(root) {
  return JSON.parse(readFileSync(path.join(root, "product.json"), "utf8"));
}

// Every value a generated line may name: product.json's string fields, plus
// the derived image repository.
export function brandValues(product) {
  const values = {};
  for (const [key, value] of Object.entries(product)) if (typeof value === "string") values[key] = value;
  values.imageRepository = `${product.imageRegistry}/${product.imageName}`;
  values.ownerLabelDomain = product.ownerMarker.labelDomain;
  return values;
}

// Tracked files plus untracked ones not ignored, so a local run catches a
// new file before it is committed.
export function repoFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  return [...new Set(out.split("\0").filter(Boolean))];
}

export function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}
