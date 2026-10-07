import { z } from "zod";
import type { SettingsRegistry } from "../../contracts/platform.js";
import type { WorkloadLinks } from "../../contracts/workloads.js";

const url = z.union([z.literal(""), z.url({ protocol: /^https?$/ })]);
const name = z.string().regex(/^[\w.-]*$/, "letters, digits, dots, dashes and underscores only");

const trim = (value: string) => value.replace(/\/+$/, "");

export function declareLinks(settings: SettingsRegistry): () => WorkloadLinks {
  const headlampUrl = settings.declare({
    key: "workloads.headlampUrl",
    label: "Headlamp URL",
    help: "Where Headlamp is served, e.g. https://headlamp.example.com. Empty: no Headlamp links.",
    schema: url,
    default: "",
    env: "HEADLAMP_URL",
  });
  const headlampCluster = settings.declare({
    key: "workloads.headlampCluster",
    label: "Headlamp cluster name",
    help: "The cluster's name in Headlamp's URLs; \"main\" when Headlamp runs in the cluster.",
    schema: name,
    default: "main",
    env: "HEADLAMP_CLUSTER",
  });
  const rancherUrl = settings.declare({
    key: "workloads.rancherUrl",
    label: "Rancher URL",
    help: "Rancher's address, e.g. https://rancher.example.com. Empty: no Rancher links.",
    schema: url,
    default: "",
    env: "RANCHER_URL",
  });
  const rancherClusterId = settings.declare({
    key: "workloads.rancherClusterId",
    label: "Rancher cluster ID",
    help: 'This cluster\'s ID in Rancher ("local" for the cluster Rancher runs in, else c-xxxxx).',
    schema: name,
    default: "local",
    env: "RANCHER_CLUSTER_ID",
  });

  return () => {
    const links: WorkloadLinks = {};
    if (headlampUrl.get()) links.headlamp = { url: trim(headlampUrl.get()), cluster: headlampCluster.get() };
    if (rancherUrl.get()) links.rancher = { url: trim(rancherUrl.get()), clusterId: rancherClusterId.get() };
    return links;
  };
}
