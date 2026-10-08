import { test } from "node:test";
import assert from "node:assert/strict";
import { deployedLabel, isDeployedByUs } from "../../../src/contracts/deployed.js";
import { createMockDeployService, mockDeployedReleases } from "../../../src/contracts/mocks/deploy.js";
import { product } from "../../../src/product.js";

test("the deployed-by label is built from the owner marker and recognised", () => {
  const key = `${product.ownerMarker.labelDomain}/deployed-by`;
  assert.deepEqual(deployedLabel(), { [key]: "deploy" });
  assert.equal(isDeployedByUs({ metadata: { name: "a", labels: deployedLabel() } }), true);
  assert.equal(isDeployedByUs({ metadata: { name: "a", labels: { [key]: "other" } } }), false);
  assert.equal(isDeployedByUs({ metadata: { name: "a" } }), false);
});

test("the mock deploy service returns copies of its releases", async () => {
  const service = createMockDeployService();
  const releases = await service.releases();
  assert.deepEqual(releases, mockDeployedReleases);
  releases[0]!.state = "failed";
  assert.equal((await service.releases())[0]!.state, "succeeded");
});
