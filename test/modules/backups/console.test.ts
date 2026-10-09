import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { ConsoleBackupView } from "../../../src/contracts/backups.js";
import { RESOURCES, type KubeObject } from "../../../src/contracts/k8s.js";
import { mockConsoleNightly } from "../../../src/contracts/mocks/catalog.js";
import { createMockContext, mockViewer, type MockContext } from "../../../src/contracts/mocks/context.js";
import { createFakeK8s } from "../../../src/contracts/mocks/k8s.js";
import { registerConsoleRoutes } from "../../../src/modules/backups/console.js";
import { listen } from "../../runtime/helpers.js";

let env: { mock: MockContext; server: { url: string; close(): Promise<void> } } | undefined;

afterEach(async () => {
  await env?.server.close();
  await env?.mock.close();
  env = undefined;
});

const own = {
  ref: { namespace: "ops", name: "console", uid: "uid-console" },
  storageClass: "local-path",
  ownData: true,
};

async function start(options: { longhorn?: boolean; secretsKey?: boolean } = {}) {
  const k8s = createFakeK8s({
    objects: [
      {
        ref: RESOURCES.storageClasses,
        items: [
          { metadata: { name: "local-path" }, provisioner: "rancher.io/local-path" },
          { metadata: { name: "longhorn" }, provisioner: "driver.longhorn.io" },
        ],
      },
      {
        ref: RESOURCES.longhornVolumes,
        items: options.longhorn
          ? [
              {
                metadata: {
                  name: "pvc-console",
                  namespace: "longhorn-system",
                  labels: { "recurring-job-group.longhorn.io/critical": "enabled" },
                },
                status: { kubernetesStatus: { namespace: "ops", pvcName: "console" } },
              },
            ]
          : [],
      },
    ] as Array<{ ref: (typeof RESOURCES)[keyof typeof RESOURCES]; items: KubeObject[] }>,
  });
  const mock = createMockContext("backups", {
    services: { k8s },
    calls: { "GET /api/deploy/console-backup": () => mockConsoleNightly },
  });
  const started: string[] = [];
  registerConsoleRoutes(mock.ctx, {
    pvcs: async () => [options.longhorn ? { ...own, storageClass: "longhorn" } : own],
    runAction: async (_req, body) => {
      started.push(body.kind);
      return { id: "dj_1" } as never;
    },
    env: {
      POD_NAMESPACE: "ops",
      HELM_RELEASE: "console",
      ...(options.secretsKey === false ? {} : { SECRETS_KEY: "k" }),
    },
  });
  env = { mock, server: await listen(mock.app) };
  return { mock, started };
}

const get = async () => (await (await fetch(`${env!.server.url}/api/backups/console`)).json()) as ConsoleBackupView;

test("on local-path: the nightly copy and the line that restores from it", async () => {
  await start();
  const view = await get();
  assert.equal(view.storage, "local-path");
  assert.deepEqual(view.claim, own.ref);
  assert.equal(view.secretsKey, true);
  assert.equal(view.nightly.lastGood?.file, mockConsoleNightly.lastGood!.file);
  assert.match(view.restoreCommand, /--restore \.\/recovery-kit\.txt --from \.\/console-20261008T033000Z\.db/);
  assert.match(view.restoreCommand, /--release console --namespace ops$/);
});

test("on Longhorn: its groups come along", async () => {
  await start({ longhorn: true });
  const view = await get();
  assert.equal(view.storage, "longhorn");
  assert.deepEqual(view.groups, ["critical"]);
});

test("back up now is for admins and runs the console-backup action", async () => {
  const { mock, started } = await start({ secretsKey: false });
  assert.equal((await get()).secretsKey, false);
  const res = await fetch(`${env!.server.url}/api/backups/console/backup-now`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(started, ["console-backup"]);
  mock.setUser(mockViewer);
  const refused = await fetch(`${env!.server.url}/api/backups/console/backup-now`, { method: "POST" });
  assert.equal(refused.status, 403);
});
