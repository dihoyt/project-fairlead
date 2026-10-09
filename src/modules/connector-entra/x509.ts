import crypto from "node:crypto";

// Self-signed certificates for Entra key credentials, and the JWTs signed
// with their keys. node:crypto parses X.509 but cannot write it, so the
// certificate is assembled here in DER: a v3 TBSCertificate without
// extensions (Entra reads only the public key, the validity and the
// thumbprint) signed with sha256WithRSAEncryption.

const RSA_BITS = 2048;
// OID 1.2.840.113549.1.1.11 sha256WithRSAEncryption, 2.5.4.3 commonName.
const SHA256_RSA = Buffer.from("06092a864886f70d01010b", "hex");
const COMMON_NAME = Buffer.from("0603550403", "hex");

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, value: Buffer) => Buffer.concat([Buffer.from([tag]), length(value.length), value]);
const sequence = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const NULL = Buffer.from([0x05, 0x00]);
const algorithm = sequence(SHA256_RSA, NULL);

function integer(bytes: Buffer): Buffer {
  // Positive: a leading 1 bit would read as negative.
  return tlv(0x02, (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function name(commonName: string): Buffer {
  const attribute = sequence(COMMON_NAME, tlv(0x0c, Buffer.from(commonName, "utf8")));
  return sequence(tlv(0x31, attribute));
}

// RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime after.
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

const pem = (label: string, der: Buffer) =>
  `-----BEGIN ${label}-----\n${der
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .replace(/\n$/, "")}\n-----END ${label}-----\n`;

export interface CertificateKey {
  // PKCS#8 PEM.
  privateKey: string;
  // PEM.
  certificate: string;
  // base64 DER, as Graph's keyCredential.key takes it.
  der: string;
  // Upper-case hex SHA-1 of the DER, as the Entra portal shows it.
  thumbprint: string;
  notBefore: string;
  notAfter: string;
}

export function createCertificate(commonName: string, notBefore: Date, notAfter: Date): CertificateKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: RSA_BITS });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const serial = crypto.randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name(commonName),
    sequence(time(notBefore), time(notAfter)),
    name(commonName),
    spki
  );
  const signature = crypto.sign("sha256", tbs, privateKey);
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certificate: pem("CERTIFICATE", der),
    der: der.toString("base64"),
    thumbprint: crypto.createHash("sha1").update(der).digest("hex").toUpperCase(),
    // Second precision, as the certificate holds them.
    notBefore: new Date(Math.floor(notBefore.getTime() / 1000) * 1000).toISOString(),
    notAfter: new Date(Math.floor(notAfter.getTime() / 1000) * 1000).toISOString(),
  };
}

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

// An RS256 JWT with the certificate's thumbprints in the header, which is
// how Entra finds the key: client assertions and addKey/removeKey proofs.
export function signJwt(
  key: Pick<CertificateKey, "privateKey" | "certificate">,
  claims: Record<string, unknown>
): string {
  const der = new crypto.X509Certificate(key.certificate).raw;
  const header = {
    alg: "RS256",
    typ: "JWT",
    x5t: crypto.createHash("sha1").update(der).digest("base64url"),
    "x5t#S256": crypto.createHash("sha256").update(der).digest("base64url"),
  };
  const input = `${part(header)}.${part(claims)}`;
  const signature = crypto.sign("sha256", Buffer.from(input), crypto.createPrivateKey(key.privateKey));
  return `${input}.${signature.toString("base64url")}`;
}
