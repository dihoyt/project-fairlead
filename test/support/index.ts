export { FIXTURES_ROOT, defaultFixtureSetName, fixtureItems, listFixtureSets, loadFixtureSet } from "./k8s/fixtures.js";
export type { FixtureList, FixtureSet } from "./k8s/fixtures.js";
export { matchesFieldSelector, matchesLabelSelector, startFakeApi } from "./k8s/fakeApi.js";
export type { FakeApi, FakeApiOptions } from "./k8s/fakeApi.js";
export { scenarios } from "./k8s/synthetic.js";
export { generateKeyPair, startFakeSshHost } from "./ssh/fakeHost.js";
export type { CannedResult, CommandTable, FakeSshHost, FakeSshOptions } from "./ssh/fakeHost.js";
