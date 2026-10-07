import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { product } from "../../src/product.js";

const repo = path.resolve(import.meta.dirname, "../..");
const script = (name: string) => path.join(repo, "scripts", name);

// A throwaway git repo holding a copy of product.json; the name is only ever
// read from it, so this file stays clean for the real check.
function scratchRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "brand-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  copyFileSync(path.join(repo, "product.json"), path.join(dir, "product.json"));
  writeFileSync(path.join(dir, "clean.ts"), "export const name = product.displayName;\n");
  return dir;
}

const run = (name: string, dir: string) => spawnSync(process.execPath, [script(name), dir], { encoding: "utf8" });

test("passes when the name only lives in product.json and docs", () => {
  const dir = scratchRepo();
  try {
    writeFileSync(path.join(dir, "README.md"), `# ${product.displayName}\n`);
    const result = run("brand-check.mjs", dir);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails on a planted literal, in any case", () => {
  const dir = scratchRepo();
  try {
    mkdirSync(path.join(dir, "src"));
    writeFileSync(
      path.join(dir, "src", "planted.ts"),
      `const title = "${product.displayName.toUpperCase()} console";\n`
    );
    const result = run("brand-check.mjs", dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /src\/planted\.ts:1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brand rewrites generated lines and the check accepts them", () => {
  const dir = scratchRepo();
  try {
    mkdirSync(path.join(dir, "chart"));
    const chart = path.join(dir, "chart", "Chart.yaml");
    writeFileSync(chart, "apiVersion: v2\nname: old-name # brand:generated chartName\nversion: 0.1.0\n");
    const values = path.join(dir, "chart", "values.yaml");
    writeFileSync(values, 'image:\n  repository: "ghcr.io/x/old" # brand:generated imageRepository\n');
    const result = run("brand.mjs", dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      readFileSync(chart, "utf8"),
      new RegExp(`^name: ${product.chartName} # brand:generated chartName$`, "m")
    );
    assert.match(
      readFileSync(values, "utf8"),
      new RegExp(`repository: "${product.imageRegistry}/${product.imageName}" # brand:generated imageRepository`)
    );
    assert.equal(run("brand-check.mjs", dir).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brand refuses a marker naming an unknown field", () => {
  const dir = scratchRepo();
  try {
    writeFileSync(path.join(dir, "x.yaml"), "name: a # brand:generated noSuchField\n");
    assert.equal(run("brand.mjs", dir).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
