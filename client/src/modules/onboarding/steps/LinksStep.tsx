import { useEffect, useState } from "react";
import { Alert, Loader, SimpleGrid, TextInput } from "@mantine/core";
import { useApi } from "../../../ui";
import { formFromSettings, linkSettings, type LinkForm } from "../links";
import { putSetting, settingOf, stringSetting } from "../settings";
import { StepFrame, useAction, type StepProps } from "../shared";

const FIELDS: Array<{ key: keyof LinkForm; label: string; placeholder: string }> = [
  { key: "rancherUrl", label: "Rancher", placeholder: "https://rancher.example.com" },
  { key: "rancherClusterId", label: "Rancher cluster ID", placeholder: "local" },
  { key: "headlampUrl", label: "Headlamp", placeholder: "https://headlamp.example.com" },
  { key: "headlampCluster", label: "Headlamp cluster name", placeholder: "main" },
  { key: "longhornUrl", label: "Longhorn UI", placeholder: "https://longhorn.example.com" },
  { key: "giteaUrl", label: "Gitea", placeholder: "https://git.example.com" },
  { key: "grafanaUrl", label: "Grafana", placeholder: "https://grafana.example.com" },
];

const EMPTY: LinkForm = {
  rancherUrl: "",
  rancherClusterId: "local",
  headlampUrl: "",
  headlampCluster: "main",
  longhornUrl: "",
  giteaUrl: "",
  grafanaUrl: "",
};

export function LinksStep({ onFinish }: StepProps) {
  const overview = useApi("GET /api/admin/overview");
  const settings = overview.data?.settings;
  const [form, setForm] = useState<LinkForm>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useAction();

  useEffect(() => {
    if (!settings || loaded) return;
    setForm(formFromSettings((key) => stringSetting(settings, key), parse(settingOf(settings, "health.links"))));
    setLoaded(true);
  }, [settings, loaded]);

  async function submit(): Promise<boolean> {
    if (!settings) return false;
    const next = linkSettings(form, parse(settingOf(settings, "health.links")));
    const done = await save.run(async () => {
      for (const [key, value] of Object.entries(next)) {
        const current = settingOf(settings, key);
        if (current === undefined) continue;
        const wanted = key === "health.links" ? parse(value) : value;
        if (JSON.stringify(wanted) !== JSON.stringify(current)) await putSetting(key, value);
      }
      return true;
    });
    if (!done) return false;
    setSaved(true);
    overview.reload();
    return true;
  }

  return (
    <StepFrame
      onFinish={async (done) => {
        if (done && !saved && !(await submit())) throw new Error("Not saved; see the error above.");
        await onFinish(done);
      }}
      intro="The tools you already use. Checks, workloads and category pages link straight into them; leave any you don't run empty."
      fullPage={{ to: "/admin/settings", label: "All settings" }}
      finishLabel="Save and continue"
    >
      {overview.loading && !overview.data ? <Loader size="sm" /> : null}
      {overview.error ? <Alert color="red">{overview.error}</Alert> : null}
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {FIELDS.map((field) => (
          <TextInput
            key={field.key}
            label={field.label}
            placeholder={field.placeholder}
            value={form[field.key]}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setSaved(false);
              setForm((prev) => ({ ...prev, [field.key]: value }));
            }}
          />
        ))}
      </SimpleGrid>
      {save.error ? <Alert color="red">{save.error}</Alert> : null}
    </StepFrame>
  );
}

// health.links comes back as an object even though SettingValue's type has no such member.
function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
