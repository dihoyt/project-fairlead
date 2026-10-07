import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FIXTURES_ROOT } from "./fixtures.js";
import { buildSyntheticSet, renderFixtureFile } from "./synthetic.js";

const out = join(FIXTURES_ROOT, "synthetic");
rmSync(out, { recursive: true, force: true });
for (const [file, body] of Object.entries(buildSyntheticSet())) {
  const target = join(out, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, await renderFixtureFile(target, body));
}
console.log(`wrote ${out}`);
