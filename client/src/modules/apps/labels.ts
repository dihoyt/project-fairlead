import type { CatalogSlot } from "@contracts/catalog";

export const SLOT_ORDER: CatalogSlot[] = [
  "cluster-basics",
  "links",
  "backups",
  "sign-in",
  "notifications",
  "remote-access",
];

export const SLOT_LABEL: Record<CatalogSlot, { title: string; about: string }> = {
  "cluster-basics": {
    title: "Cluster basics",
    about: "Storage, web routing, certificates and live usage: what most other apps expect to find.",
  },
  links: { title: "Tools", about: "Web consoles for your cluster, your code and your dashboards." },
  backups: { title: "Backups", about: "Somewhere for your volumes and apps to be copied to." },
  "sign-in": { title: "Sign-in", about: "One login, with two-factor, in front of all your apps." },
  notifications: { title: "Notifications", about: "Somewhere for alerts to go when nothing else is set up." },
  "remote-access": { title: "Remote access", about: "Reaching your apps from outside your network." },
};
