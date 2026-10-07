import type { ChartUnit } from "./contracts";

export function formatValue(value: number, unit: ChartUnit): string {
  switch (unit) {
    case "percent":
      return `${value.toFixed(1)}%`;
    case "celsius":
      return `${value.toFixed(0)}°C`;
    case "count":
      return String(Math.round(value));
    case "bytes":
    case "bytesPerSec": {
      const units = ["B", "KiB", "MiB", "GiB", "TiB"];
      let v = value;
      let i = 0;
      while (Math.abs(v) >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
      }
      return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}${unit === "bytesPerSec" ? "/s" : ""}`;
    }
  }
}
