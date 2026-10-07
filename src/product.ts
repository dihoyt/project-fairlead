import { readFileSync } from "node:fs";
import { z } from "zod";

// The only reader of product.json on the server. Resolved against this file
// so it works the same from src/ under tsx and from dist/ once built: both
// sit one level below the repo root, where the image must also place it.
const PRODUCT_JSON = new URL("../product.json", import.meta.url);

const ownerMarker = z.object({
  labelDomain: z.string().min(1),
  externalPrefix: z.string().min(1),
  externalTag: z.string().min(1),
});

const productSchema = z.object({
  displayName: z.string().min(1),
  slug: z.string().regex(/^[a-z][a-z0-9-]*$/),
  tagline: z.string(),
  imageRegistry: z.string().min(1),
  imageName: z.string().min(1),
  chartName: z.string().min(1),
  defaultNamespace: z.string().min(1),
  cookiePrefix: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  dbFile: z.string().min(1),
  ownerMarker,
  legacyOwnerMarkers: z.array(ownerMarker),
});

export type Product = z.infer<typeof productSchema>;
export type OwnerMarker = z.infer<typeof ownerMarker>;

export const product: Product = productSchema.parse(JSON.parse(readFileSync(PRODUCT_JSON, "utf8")));

// The current marker first, then every legacy one, for ownership checks
// that must still recognise objects written before a rename.
export const ownerMarkers: readonly OwnerMarker[] = [product.ownerMarker, ...product.legacyOwnerMarkers];

export const sessionCookieName = `${product.cookiePrefix}_session`;
