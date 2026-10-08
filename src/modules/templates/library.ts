import { z } from "zod";
import { CUSTOM_TEMPLATE, type AppTemplate } from "../../contracts/templates.js";

const MiB = 1024 ** 2;

export const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
export const SIZE = /^[1-9][0-9]{0,5}(Mi|Gi|Ti)$/;
// registry/path without a tag; the tag (or digest) is a separate field or suffix.
const IMAGE_NAME = /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-]{1,2}[a-z0-9]+)*)+$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MOUNT_PATH = /^\/(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]{1,200}$/;

// What a library template may say, and nothing else: strict objects, so a
// template that asks for a host path, a privileged container, host
// networking or RBAC can't even be written down. Everything the guardrail
// refuses is only reachable by adding a field here.
export const definitionSchema = z
  .object({
    id: z.string().regex(DNS_LABEL).max(40),
    name: z.string().min(1).max(60),
    summary: z.string().min(1).max(200),
    homepage: z.url().optional(),
    image: z.string().regex(IMAGE_NAME),
    version: z.string().regex(TAG),
    port: z.number().int().min(1).max(65_535),
    volume: z
      .object({ mountPath: z.string().regex(MOUNT_PATH), size: z.string().regex(SIZE) })
      .strict()
      .optional(),
    env: z
      .array(z.object({ name: z.string().regex(ENV_NAME), value: z.string().max(4096) }).strict())
      .max(50)
      .optional(),
    // The path a readiness probe asks over HTTP; omitted: a TCP check on the port.
    probePath: z
      .string()
      .regex(/^\/[A-Za-z0-9._/-]*$/)
      .optional(),
    disk: z.object({ volumeBytes: z.number().nonnegative(), imageBytes: z.number().nonnegative() }).strict().optional(),
    noLogin: z.boolean().optional(),
  })
  .strict();

export type TemplateDefinition = z.infer<typeof definitionSchema>;

const library: TemplateDefinition[] = [
  {
    id: "whoami",
    name: "whoami",
    summary: "A tiny web page that echoes back the request it got, for testing that routing and sign-in work.",
    homepage: "https://github.com/traefik/whoami",
    image: "docker.io/traefik/whoami",
    version: "v1.11.0",
    port: 80,
    disk: { volumeBytes: 0, imageBytes: 8 * MiB },
    noLogin: true,
  },
  {
    id: "uptime-kuma",
    name: "Uptime Kuma",
    summary: "A status page and uptime monitor for websites and services, with alerts.",
    homepage: "https://github.com/louislam/uptime-kuma",
    image: "docker.io/louislam/uptime-kuma",
    version: "1.23.16",
    port: 3001,
    volume: { mountPath: "/app/data", size: "1Gi" },
    disk: { volumeBytes: 1024 * MiB, imageBytes: 450 * MiB },
  },
  {
    id: "it-tools",
    name: "IT-Tools",
    summary: "Handy tools for developers and admins in one web page: converters, generators, encoders.",
    homepage: "https://github.com/CorentinTh/it-tools",
    image: "docker.io/corentinth/it-tools",
    version: "2024.10.22-7ca5933",
    port: 80,
    disk: { volumeBytes: 0, imageBytes: 60 * MiB },
    noLogin: true,
  },
];

export const LIBRARY: readonly TemplateDefinition[] = library.map((t) => definitionSchema.parse(t));

export const CUSTOM: AppTemplate = {
  id: CUSTOM_TEMPLATE,
  name: "Custom app",
  summary: "Any container image with a web page or API: give the image, its port and a hostname.",
  image: "",
  version: "",
  port: 0,
};

export function templateView(def: TemplateDefinition): AppTemplate {
  return {
    id: def.id,
    name: def.name,
    summary: def.summary,
    ...(def.homepage ? { homepage: def.homepage } : {}),
    image: def.image,
    version: def.version,
    port: def.port,
    ...(def.volume ? { volume: def.volume } : {}),
    ...(def.disk ? { disk: def.disk } : {}),
    ...(def.noLogin ? { noLogin: true } : {}),
  };
}

// "ghcr.io/org/app:1.2" -> name and tag; "...@sha256:<hex>" -> name and
// "sha256-<first 12>" as the version. A reference without either is refused,
// and so is a bare Docker Hub name ("nginx:1.27" -> "docker.io/library/nginx").
export function parseImage(
  ref: string
): { name: string; tag?: string; digest?: string; version: string } | { error: string } {
  const value = ref.trim();
  if (!value || /\s/.test(value) || value.length > 255) return { error: "must be an image like nginx:1.27" };
  const at = value.indexOf("@");
  let name = value;
  let tag: string | undefined;
  let digest: string | undefined;
  if (at !== -1) {
    digest = value.slice(at + 1);
    name = value.slice(0, at);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return { error: "digest must be sha256:<64 hex characters>" };
  }
  const colon = name.lastIndexOf(":");
  if (colon > name.lastIndexOf("/")) {
    tag = name.slice(colon + 1);
    name = name.slice(0, colon);
    if (!TAG.test(tag)) return { error: "has a tag that isn't valid" };
  }
  if (!tag && !digest) return { error: "needs a tag or digest, like nginx:1.27" };
  const parts = name.split("/");
  const first = parts[0]!;
  const hasRegistry = parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  const full = hasRegistry ? name : `docker.io/${parts.length === 1 ? `library/${name}` : name}`;
  if (!IMAGE_NAME.test(full)) return { error: "must be an image like nginx:1.27" };
  return { name: full, tag, digest, version: tag ?? `sha256-${digest!.slice(7, 19)}` };
}
