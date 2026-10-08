// A YAML writer for the manifests templates render, the same shape the
// deploy runner writes. Strings that could read as anything but a string
// (true, 1.0, a leading "*", a ": " inside) are written as JSON strings,
// which YAML accepts as double-quoted scalars.

export type YamlValue = string | number | boolean | null | undefined | YamlValue[] | { [key: string]: YamlValue };

const PLAIN = /^[A-Za-z_/][A-Za-z0-9_./@:+-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|y|n|null|~)$/i;

function scalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value !== "string") return String(value);
  return PLAIN.test(value) && !RESERVED.test(value) && !value.includes(": ") && !value.endsWith(":")
    ? value
    : JSON.stringify(value);
}

const isMap = (value: YamlValue): value is { [key: string]: YamlValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const present = (entries: Array<[string, YamlValue]>) => entries.filter(([, value]) => value !== undefined);

function lines(value: YamlValue, indent: string): string[] {
  if (Array.isArray(value)) {
    const items = value.filter((item) => item !== undefined);
    if (items.length === 0) return [`${indent}[]`];
    return items.flatMap((item) => {
      if ((isMap(item) && present(Object.entries(item)).length > 0) || (Array.isArray(item) && item.length > 0)) {
        const [first = "", ...rest] = lines(item, `${indent}  `);
        return [`${indent}- ${first.slice(indent.length + 2)}`, ...rest];
      }
      return [`${indent}- ${inline(item)}`];
    });
  }
  if (isMap(value)) {
    const entries = present(Object.entries(value));
    if (entries.length === 0) return [`${indent}{}`];
    return entries.flatMap(([key, item]) => {
      const name = scalar(key);
      if ((isMap(item) && present(Object.entries(item)).length > 0) || (Array.isArray(item) && item.length > 0)) {
        return [`${indent}${name}:`, ...lines(item, Array.isArray(item) ? indent : `${indent}  `)];
      }
      return [`${indent}${name}: ${inline(item)}`];
    });
  }
  return [`${indent}${inline(value)}`];
}

function inline(value: YamlValue): string {
  if (Array.isArray(value)) return "[]";
  if (isMap(value)) return "{}";
  return scalar(value ?? null);
}

export function toYaml(value: YamlValue): string {
  return `${lines(value, "").join("\n")}\n`;
}
