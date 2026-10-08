import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDisk, formatBytes } from "../../src/contracts/disk.js";

const GiB = 1024 ** 3;
const app = (volumes: number, images: number) => ({ volumeBytes: volumes * GiB, imageBytes: images * GiB });

test("one roomy node is ok", () => {
  const check = checkDisk(
    [app(4, 1), app(2, 0.5)],
    [{ node: "n1", availableBytes: 80 * GiB, capacityBytes: 100 * GiB }]
  );
  assert.equal(check.status, "ok");
  assert.equal(check.volumeBytes, 6 * GiB);
  assert.equal(check.imageBytes, 1.5 * GiB);
  assert.match(check.detail, /Needs about 7\.5 GiB .* the node has 80 GiB free of 100 GiB\.$/);
});

test("under 20% left is a warning, more than free is crit", () => {
  const node = [{ node: "n1", availableBytes: 12 * GiB, capacityBytes: 30 * GiB }];
  const warn = checkDisk([app(5, 2)], node);
  assert.equal(warn.status, "warn");
  assert.match(warn.detail, /leaves 17% free/);
  const crit = checkDisk([app(10, 3)], node);
  assert.equal(crit.status, "crit");
  assert.match(crit.detail, /1 GiB short/);
});

test("nodes pool their free space; unread nodes are named", () => {
  const check = checkDisk(
    [app(21, 2)],
    [
      { node: "n1", availableBytes: 15 * GiB, capacityBytes: 20 * GiB },
      { node: "n2", availableBytes: 15 * GiB, capacityBytes: 20 * GiB },
      { node: "n3", error: "forbidden" },
    ]
  );
  assert.equal(check.status, "warn");
  assert.equal(check.nodesRead, 2);
  assert.equal(check.nodesTotal, 3);
  assert.match(check.detail, /the 2 nodes have 30 GiB free of 40 GiB between them/);
  assert.match(check.detail, /1 of 3 nodes couldn't be read/);
});

test("a separate image disk is checked on its own", () => {
  const disk = {
    node: "n1",
    availableBytes: 50 * GiB,
    capacityBytes: 60 * GiB,
    imageAvailableBytes: 1 * GiB,
    imageCapacityBytes: 10 * GiB,
  };
  const check = checkDisk([app(5, 3)], [disk]);
  assert.equal(check.status, "crit");
  assert.match(check.detail, /image disk is too small/);
  // Same capacity means the same disk: images count against the root filesystem.
  const shared = checkDisk([app(5, 3)], [{ ...disk, imageAvailableBytes: 50 * GiB, imageCapacityBytes: 60 * GiB }]);
  assert.equal(shared.status, "ok");
});

test("no readable node is unknown, never blocking", () => {
  assert.equal(checkDisk([app(1, 1)], undefined).status, "unknown");
  const check = checkDisk([app(1, 1)], [{ node: "n1", error: "timeout" }]);
  assert.equal(check.status, "unknown");
  assert.match(check.detail, /couldn't be read \(timeout\)/);
});

test("formatBytes", () => {
  assert.equal(formatBytes(512 * 1024 ** 2), "512 MiB");
  assert.equal(formatBytes(2 * GiB), "2 GiB");
  assert.equal(formatBytes(1.25 * GiB), "1.3 GiB");
});
