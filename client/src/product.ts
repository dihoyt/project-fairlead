import productJson from "../../product.json";

// The only reader of product.json in the client.
export const product: { displayName: string; slug: string; tagline: string } = productJson;
