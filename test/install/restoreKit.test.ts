// install.sh --restore opens the kit the console seals, with openssl alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sealKit } from "../../src/platform/recoveryKit.js";

const hasOpenssl = spawnSync("sh", ["-c", "command -v openssl"]).status === 0;
const install = readFileSync(new URL("../../install.sh", import.meta.url), "utf8");

// open_kit and kit_value as install.sh defines them, run with stand-ins for
// the helpers they call.
function openKit(kit: string, passphrase: string, flags = "") {
  const start = install.indexOf("open_kit() {");
  const end = install.indexOf("\n", install.indexOf("kit_value() {"));
  assert.ok(start > 0 && end > start, "open_kit not found in install.sh");
  const dir = mkdtempSync(join(tmpdir(), "kit-"));
  writeFileSync(join(dir, "kit.txt"), kit);
  const program = [
    'die() { echo "die: $*"; exit 1; }',
    'say() { echo "$*"; }',
    'has() { command -v "$1" >/dev/null 2>&1; }',
    "tty_ok() { return 1; }",
    "dns_label() { :; }",
    `RESTORE_KIT="${dir}/kit.txt"; RELEASE=default-release; NAMESPACE=default-ns; RELEASE_GIVEN=0; NAMESPACE_GIVEN=0`,
    flags,
    install.slice(start, end),
    "open_kit",
    'echo "key=$RESTORE_KEY release=$RELEASE namespace=$NAMESPACE secret=$SECRET_NAME"',
  ].join("\n");
  const result = spawnSync("sh", ["-c", program], {
    encoding: "utf8",
    env: { ...process.env, KIT_PASSPHRASE: passphrase },
  });
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, out: result.stdout.trim().split("\n") };
}

const kit = sealKit(
  {
    secretsKey: "abc123",
    release: "ops-console",
    namespace: "ops",
    version: "3f9c2e1",
    createdAt: "2026-10-09T00:00:00Z",
  },
  "a long kit passphrase"
);

test("the right passphrase gives the key, and the kit's release and namespace", { skip: !hasOpenssl }, () => {
  const r = openKit(kit, "a long kit passphrase");
  assert.equal(r.status, 0, r.out.join("\n"));
  assert.equal(r.out.at(-1), "key=abc123 release=ops-console namespace=ops secret=ops-console-secrets");
});

test("flags given win over the kit's names", { skip: !hasOpenssl }, () => {
  const r = openKit(kit, "a long kit passphrase", "RELEASE=mine; RELEASE_GIVEN=1");
  assert.equal(r.out.at(-1), "key=abc123 release=mine namespace=ops secret=mine-secrets");
});

test("a wrong passphrase or a file that is no kit stops the install", { skip: !hasOpenssl }, () => {
  assert.match(openKit(kit, "not the passphrase").out.at(-1)!, /^die: the passphrase does not open/);
  assert.match(openKit("# nothing\nnotbase64\n", "a long kit passphrase").out.at(-1)!, /^die: /);
});
