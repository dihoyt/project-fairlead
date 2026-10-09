import { createHash, createHmac } from "node:crypto";

// A signed ListObjectsV2 (AWS Signature Version 4), path-style so MinIO and
// other S3-compatible servers answer it the same way as AWS. Just enough of
// SigV4 for one GET with an empty body.

export interface S3ListRequest {
  // "https://minio.example.com:9000"; AWS when empty.
  endpoint?: string;
  bucket: string;
  region: string;
  // Key prefix, without a leading slash.
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date;
}

export interface S3ListResult {
  status: number;
  // ListBucketResult's KeyCount, on a 200.
  keyCount?: number;
  // The error document's Code and Message, otherwise.
  code?: string;
  message?: string;
  body: string;
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal }
) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

// RFC 3986 unreserved characters stay; everything else is %XX, as SigV4 wants.
const encode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

export const awsEndpoint = (region: string) => `https://s3.${region}.amazonaws.com`;

export interface SignInput {
  host: string;
  // Already encoded.
  uri: string;
  query: Array<[string, string]>;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}

// SigV4 for a GET with an empty body: the headers to send besides Host.
export function signGet(input: SignInput): { query: string; headers: Record<string, string> } {
  const amzDate = input.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const canonicalQuery = input.query
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const headers: Record<string, string> = {
    host: input.host,
    "x-amz-content-sha256": EMPTY_SHA256,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers).toSorted();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names.map((k) => `${k}:${headers[k]}\n`).join("");
  const canonicalRequest = ["GET", input.uri, canonicalQuery, canonicalHeaders, signedHeaders, EMPTY_SHA256].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join(
    "\n"
  );
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  const { host: _host, ...sent } = headers;
  return {
    query: canonicalQuery,
    headers: {
      ...sent,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export function signedListRequest(req: S3ListRequest): { url: string; headers: Record<string, string> } {
  const base = new URL(req.endpoint?.trim() || awsEndpoint(req.region));
  const uri = `${base.pathname.replace(/\/+$/, "")}/${encode(req.bucket)}`;
  const { query, headers } = signGet({
    host: base.host,
    uri,
    query: [
      ["list-type", "2"],
      ["max-keys", "1"],
      ...(req.prefix ? ([["prefix", req.prefix]] as Array<[string, string]>) : []),
    ],
    region: req.region,
    accessKeyId: req.accessKeyId,
    secretAccessKey: req.secretAccessKey,
    now: req.now ?? new Date(),
  });
  return { url: `${base.origin}${uri}?${query}`, headers };
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

export async function listObjects(req: S3ListRequest, fetchFn: Fetch, signal?: AbortSignal): Promise<S3ListResult> {
  const { url, headers } = signedListRequest(req);
  const res = await fetchFn(url, { method: "GET", headers, ...(signal ? { signal } : {}) });
  const body = (await res.text()).slice(0, 4000);
  if (res.status === 200) {
    const count = tag(body, "KeyCount");
    return { status: 200, ...(count !== undefined ? { keyCount: Number(count) } : {}), body };
  }
  const code = tag(body, "Code");
  const message = tag(body, "Message");
  return { status: res.status, ...(code ? { code } : {}), ...(message ? { message } : {}), body };
}
