import {
  CUSTOM_TEMPLATE,
  type AppTemplate,
  type TemplateDeployRequest,
  type TemplateInstance,
} from "@contracts/templates";
import { apiRequest } from "../../ui";

// What the deploy form holds; strings throughout so half-typed values stay
// as typed.
export interface TemplateForm {
  name: string;
  // false: no Ingress, reachable inside the cluster only.
  exposed: boolean;
  // "": the server's default under the base domain.
  host: string;
  volumeSize: string;
  storageClass: string;
  image: string;
  port: string;
  env: Array<{ name: string; value: string }>;
  volume: boolean;
  mountPath: string;
}

export function emptyForm(template: AppTemplate): TemplateForm {
  return {
    name: template.id === CUSTOM_TEMPLATE ? "" : template.id,
    exposed: true,
    host: "",
    volumeSize: "",
    storageClass: "",
    image: "",
    port: "",
    env: [],
    volume: false,
    mountPath: "/data",
  };
}

// A redeploy starts from what the instance was deployed with.
export function formFromInstance(template: AppTemplate, instance: TemplateInstance): TemplateForm {
  const custom = instance.custom;
  return {
    ...emptyForm(template),
    name: instance.name,
    exposed: instance.host !== "",
    host: instance.host,
    volumeSize: instance.volumeSize ?? "",
    storageClass: instance.storageClass ?? "",
    ...(custom
      ? {
          image: custom.image,
          port: String(custom.port),
          env: custom.env.map((e) => ({ ...e })),
          volume: Boolean(custom.volume),
          mountPath: custom.volume?.mountPath ?? "/data",
          volumeSize: custom.volume?.size ?? instance.volumeSize ?? "",
        }
      : {}),
  };
}

export function toRequest(template: AppTemplate, form: TemplateForm): TemplateDeployRequest {
  const custom = template.id === CUSTOM_TEMPLATE;
  const keepsData = custom ? form.volume : Boolean(template.volume);
  return {
    templateId: template.id,
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    ...(!form.exposed ? { host: "" } : form.host.trim() ? { host: form.host.trim() } : {}),
    ...(keepsData && form.volumeSize.trim() ? { volumeSize: form.volumeSize.trim() } : {}),
    ...(keepsData && form.storageClass.trim() ? { storageClass: form.storageClass.trim() } : {}),
    ...(custom
      ? {
          custom: {
            image: form.image.trim(),
            port: Number(form.port),
            env: form.env.filter((e) => e.name.trim() || e.value).map((e) => ({ name: e.name.trim(), value: e.value })),
            ...(form.volume
              ? { volume: { size: form.volumeSize.trim() || "1Gi", mountPath: form.mountPath.trim() } }
              : {}),
          },
        }
      : {}),
  };
}

// Like a bundle app that lands: an HTTP check on its URL, unless one
// already watches that host.
export async function addCheck(label: string, url: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  const checks = await apiRequest("GET /api/checks");
  const watched = checks.some((check) => {
    try {
      return check.kind === "http" && new URL(check.target).host === host;
    } catch {
      return false;
    }
  });
  if (watched) return false;
  await apiRequest("POST /api/checks", { body: { label, kind: "http", target: url } });
  return true;
}
