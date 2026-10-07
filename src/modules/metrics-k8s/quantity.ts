const DECIMAL: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};
const BINARY: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };

// A Kubernetes resource quantity ("412000000n", "16263064Ki", "4", "1.5e3")
// as a plain number in base units; undefined when it doesn't parse.
export function parseQuantity(text: unknown): number | undefined {
  if (typeof text === "number") return Number.isFinite(text) ? text : undefined;
  if (typeof text !== "string") return undefined;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:([eE][+-]?\d+)|(Ki|Mi|Gi|Ti|Pi|Ei|[numkMGTPE])?)$/.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1] + (match[2] ?? ""));
  const suffix = match[3] ?? "";
  const factor = BINARY[suffix] ?? DECIMAL[suffix];
  return factor === undefined || !Number.isFinite(value) ? undefined : value * factor;
}
