import type { SettingValue, SettingView } from "@contracts/auth";
import { apiRequest } from "../../ui";

export function settingOf(settings: SettingView[] | undefined, key: string): SettingValue | undefined {
  return settings?.find((s) => s.key === key)?.value;
}

export function stringSetting(settings: SettingView[] | undefined, key: string): string {
  const value = settingOf(settings, key);
  return typeof value === "string" ? value : "";
}

export function putSetting(key: string, value: SettingValue) {
  return apiRequest("PUT /api/admin/settings/:key", { params: { key }, body: { value } });
}
