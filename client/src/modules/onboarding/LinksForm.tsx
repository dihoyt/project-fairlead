import { useEffect, useState } from "react";
import { SimpleGrid, TextInput } from "@mantine/core";
import type { SettingView } from "@contracts/auth";
import { formFromSettings, linkSettings, type LinkForm } from "./links";
import { putSetting, settingOf, stringSetting } from "./settings";
import { useAction } from "./shared";

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

// health.links comes back as an object even though SettingValue's type has no such member.
export function parseLinks(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function formOf(settings: SettingView[]): LinkForm {
  return formFromSettings((key) => stringSetting(settings, key), parseLinks(settingOf(settings, "health.links")));
}

// Writes the settings the form derives, skipping any that already hold the value.
export async function saveLinks(settings: SettingView[], form: LinkForm): Promise<void> {
  const next = linkSettings(form, parseLinks(settingOf(settings, "health.links")));
  for (const [key, value] of Object.entries(next)) {
    const current = settingOf(settings, key);
    if (current === undefined) continue;
    const wanted = key === "health.links" ? parseLinks(value) : value;
    if (JSON.stringify(wanted) !== JSON.stringify(current)) await putSetting(key, value);
  }
}

// The links form's state over the stored settings, shared by the setup step
// and the settings page. `reload` refetches the settings after a save.
export function useLinksForm(settings: SettingView[] | undefined, reload: () => void) {
  const [form, setForm] = useState<LinkForm>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const save = useAction();

  useEffect(() => {
    if (!settings || loaded) return;
    setForm(formOf(settings));
    setLoaded(true);
  }, [settings, loaded]);

  function change(key: keyof LinkForm, value: string) {
    setSaved(false);
    setDirty(true);
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // Fills empty fields only: what someone typed or saved always wins.
  function fill(values: Partial<LinkForm>) {
    const next = { ...form };
    let changed = false;
    for (const [key, value] of Object.entries(values) as Array<[keyof LinkForm, string]>) {
      if (value && !form[key].trim()) {
        next[key] = value;
        changed = true;
      }
    }
    if (!changed) return;
    setForm(next);
    setSaved(false);
    setDirty(true);
  }

  async function submit(): Promise<boolean> {
    if (!settings) return false;
    const done = await save.run(async () => {
      await saveLinks(settings, form);
      return true;
    });
    if (!done) return false;
    setSaved(true);
    setDirty(false);
    reload();
    return true;
  }

  return { form, change, fill, loaded, submit, saved, dirty, busy: save.busy, error: save.error };
}

export function LinksFields({
  form,
  onChange,
  disabled,
}: {
  form: LinkForm;
  onChange: (key: keyof LinkForm, value: string) => void;
  disabled?: boolean;
}) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }}>
      {FIELDS.map((field) => (
        <TextInput
          key={field.key}
          label={field.label}
          placeholder={field.placeholder}
          value={form[field.key]}
          disabled={disabled}
          onChange={(e) => onChange(field.key, e.currentTarget.value)}
        />
      ))}
    </SimpleGrid>
  );
}
