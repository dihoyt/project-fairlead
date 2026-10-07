// Rewrites every line marked `# brand:generated <field>` with the current
// value from product.json. A rename is: edit product.json, move the old
// ownerMarker into legacyOwnerMarkers, run this, commit.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brandValues, GENERATED_LINE, isBinary, MARKER, readProduct, repoFiles } from "./brand-lib.mjs";

const root = path.resolve(process.argv[2] ?? ".");
const values = brandValues(readProduct(root));
let changed = 0;
let problems = 0;

for (const file of repoFiles(root)) {
  const full = path.join(root, file);
  if (file === "product.json" || file.startsWith("scripts/brand") || !existsSync(full)) continue;
  const buffer = readFileSync(full);
  if (isBinary(buffer)) continue;
  const text = buffer.toString("utf8");
  if (!text.includes(MARKER)) continue;
  const lines = text.split("\n").map((line, index) => {
    if (!line.includes(MARKER)) return line;
    const match = GENERATED_LINE.exec(line);
    const field = match?.[4];
    if (!match || !field || !(field in values)) {
      console.error(`${file}:${index + 1}: unrecognised generated line: ${line.trim()}`);
      problems++;
      return line;
    }
    const quote = /^["']/.test(match[2]) ? match[2][0] : "";
    return `${match[1]}${quote}${values[field]}${quote}${match[3]}`;
  });
  const next = lines.join("\n");
  if (next !== text) {
    writeFileSync(full, next);
    console.log(`updated ${file}`);
    changed++;
  }
}

console.log(`${changed} file(s) updated.`);
process.exit(problems > 0 ? 1 : 0);
