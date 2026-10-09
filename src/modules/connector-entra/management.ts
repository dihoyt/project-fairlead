import type {
  ConnectorInstance,
  ConnectorRegistry,
  ConnectorValues,
  EntraCredential,
  EntraManagementView,
} from "../../contracts/connectors.js";
import type { DriftItem } from "../../contracts/ownership.js";
import type { SecretStore } from "../../contracts/platform.js";
import { product } from "../../product.js";
import {
  GraphError,
  createGraphClient,
  isCertificate,
  keyCredentialBody,
  keyProof,
  selfRef,
  type GraphClient,
  type GraphCredential,
  type GraphEndpoints,
} from "./graph.js";
import { createCertificate, type CertificateKey } from "./x509.js";

// The management app's own credential. The admin pastes a client secret;
// the console generates a certificate, gets it onto the management app
// (itself when Graph lets it, else the admin uploads it), then signs in
// with it and gets rid of the secret. From then on it rolls the certificate
// with addKey/removeKey, which need no permission for an app's own keys.

export const SCOPE = "connector-entra";
export const MANAGEMENT_KEY = "management";
export const DAY_MS = 24 * 60 * 60 * 1000;
// Certificates (sign-in and management) live this long and are replaced
// once less than ROTATE_BEFORE_MS is left.
export const CERT_LIFETIME_MS = 365 * DAY_MS;
export const ROTATE_BEFORE_MS = 30 * DAY_MS;
// Covers clock skew between this pod and Entra.
const BACKDATE_MS = 5 * 60 * 1000;

export const UPLOAD_STEP =
  "Upload the console's certificate (the download link on this check) to the management app under Certificates & secrets; the console switches to it on the next sync.";
export const DELETE_SECRET_STEP =
  "Delete the management app's client secret under Certificates & secrets: the console signs in with its certificate now and no longer needs it.";
const objectIdStep = (until: string) =>
  `Add the management app's Object ID (from its Overview page) to the connector, so the console can replace its certificate before ${until}.`;

interface HeldCertificate {
  privateKey: string;
  certificate: string;
  der: string;
  thumbprint: string;
  notAfter: string;
  // Entra's id for it, once known (addKey's answer, or read back).
  keyId?: string;
}

// Sealed under SCOPE, id "<instanceId>:management".
export interface ManagementState extends HeldCertificate {
  // A token has been issued for it.
  working?: boolean;
  // Replaced by addKey; kept until the new one works, then removed.
  previous?: HeldCertificate;
  // What the last sync left for the admin to do.
  step?: string;
}

export interface ManagementDeps {
  endpoints: GraphEndpoints;
  secrets: SecretStore;
  connectors(): ConnectorRegistry;
  now(): Date;
}

const stateId = (instanceId: string) => `${instanceId}:${MANAGEMENT_KEY}`;

export async function loadManagement(deps: ManagementDeps, instanceId: string): Promise<ManagementState | undefined> {
  const raw = await deps.secrets.get(SCOPE, stateId(instanceId));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ManagementState;
  } catch {
    return undefined;
  }
}

const saveManagement = (deps: ManagementDeps, instanceId: string, state: ManagementState) =>
  deps.secrets.put(SCOPE, stateId(instanceId), JSON.stringify(state));

export const forgetManagement = (deps: ManagementDeps, instanceId: string) =>
  deps.secrets.delete(SCOPE, stateId(instanceId));

export const certDisplayName = (what: string, thumbprint: string) => `${product.displayName} ${what} ${thumbprint}`;

export function issueCertificate(what: string, now: Date): CertificateKey {
  return createCertificate(
    `${product.displayName} ${what}`,
    new Date(now.getTime() - BACKDATE_MS),
    new Date(now.getTime() + CERT_LIFETIME_MS)
  );
}

function held(cert: CertificateKey): HeldCertificate {
  return {
    privateKey: cert.privateKey,
    certificate: cert.certificate,
    der: cert.der,
    thumbprint: cert.thumbprint,
    notAfter: cert.notAfter,
  };
}

// The certificate the management app should carry, created on first use.
export async function managementCertificate(deps: ManagementDeps, instanceId: string): Promise<ManagementState> {
  const state = await loadManagement(deps, instanceId);
  if (state) return state;
  const fresh: ManagementState = held(issueCertificate("connector", deps.now()));
  await saveManagement(deps, instanceId, fresh);
  return fresh;
}

const certCredential = (cert: HeldCertificate): GraphCredential => ({
  kind: "certificate",
  privateKey: cert.privateKey,
  certificate: cert.certificate,
  thumbprint: cert.thumbprint,
});

const ids = (values: ConnectorValues) => ({
  tenantId: (values.tenantId ?? "").trim(),
  clientId: (values.clientId ?? "").trim(),
});

function clientFor(values: ConnectorValues, credential: GraphCredential, deps: Pick<ManagementDeps, "endpoints">) {
  return createGraphClient({ ...ids(values), credential }, deps.endpoints);
}

// A refusal from the token endpoint: this credential is not (or no longer)
// accepted. Anything else (Graph down, a timeout) is not a verdict on it.
const refused = (err: unknown) => err instanceof GraphError && (err.status === 400 || err.status === 401);

// A Graph client that has signed in, with what it signed in with: the
// certificate once it has worked (or when no secret is left), else the
// secret, each falling back to the other; a replaced certificate while its
// successor is new to Entra.
export async function signInManagement(
  values: ConnectorValues,
  state: ManagementState | undefined,
  deps: Pick<ManagementDeps, "endpoints">,
  signal?: AbortSignal,
  fresh = false
): Promise<{ graph: GraphClient; credential: EntraCredential }> {
  const secret = values.clientSecret ?? "";
  const certs: Array<[EntraCredential, GraphCredential]> = state
    ? [
        ["certificate", certCredential(state)],
        ...(state.previous
          ? [["certificate", certCredential(state.previous)] as [EntraCredential, GraphCredential]]
          : []),
      ]
    : [];
  const secrets: Array<[EntraCredential, GraphCredential]> = secret
    ? [["secret", { kind: "secret", clientSecret: secret }]]
    : [];
  const order = state?.working || !secret ? [...certs, ...secrets] : [...secrets, ...certs];
  let last: unknown;
  for (const [credential, c] of order) {
    const graph = clientFor(values, c, deps);
    try {
      await graph.token(signal, fresh);
      return { graph, credential };
    } catch (err) {
      if (!refused(err)) throw err;
      last = err;
    }
  }
  throw (
    last ??
    new GraphError(
      400,
      "no_credential",
      "The Entra connector has no client secret or working certificate to sign in with."
    )
  );
}

export function managementView(instance: ConnectorInstance, state: ManagementState | undefined): EntraManagementView {
  const secretStored = Boolean(instance.secrets.clientSecret);
  const certificate = state?.working === true || !secretStored;
  return {
    credential: certificate ? "certificate" : "secret",
    ...(certificate && state ? { certificateExpiresAt: state.notAfter } : {}),
    secretStored,
    ...(state?.step ? { step: state.step } : {}),
  };
}

const day = (iso: string) => iso.slice(0, 10);

// Moves the management app onto the console's certificate and keeps it
// there; returns what it changed.
export async function reconcileManagement(
  instance: ConnectorInstance,
  deps: ManagementDeps,
  signal: AbortSignal
): Promise<DriftItem[]> {
  const now = deps.now();
  const values = { ...instance.config, ...instance.secrets };
  const { clientId } = ids(values);
  const self = selfRef(clientId);
  const items: DriftItem[] = [];
  const base = { key: MANAGEMENT_KEY, kind: "entra-credential" };
  let state = await managementCertificate(deps, instance.id);
  const secret = values.clientSecret ?? "";
  let step: string | undefined;

  // An unused certificate that ran out is no use for an upload either.
  if (!state.working && Date.parse(state.notAfter) <= now.getTime()) {
    state = held(issueCertificate("connector", now));
  }

  const certGraph = clientFor(values, certCredential(state), deps);
  let certWorks = false;
  try {
    await certGraph.token(signal, true);
    certWorks = true;
  } catch (err) {
    if (!refused(err)) throw err;
  }

  if (certWorks) {
    if (!state.working)
      items.push({ ...base, state: "drifted", diff: [{ path: "credential", want: "certificate", have: "secret" }] });
    state.working = true;
    let app: Awaited<ReturnType<GraphClient["self"]>> | null = null;
    const readSelf = async () => (app === null ? (app = await certGraph.self(signal)) : app);
    if (!state.keyId) {
      const found = (await readSelf())?.keyCredentials?.find((k) => isCertificate(k, state.thumbprint));
      if (found) state.keyId = found.keyId;
    }
    const objectId = (values.objectId ?? "").trim() || (await readSelf())?.id;

    if (state.previous) {
      if (state.previous.keyId && objectId) {
        try {
          await certGraph.removeKey(objectId, state.previous.keyId, keyProof(state, objectId), signal);
        } catch (err) {
          // Already gone, or refused: it expires on its own either way.
          if (!(err instanceof GraphError)) throw err;
        }
      }
      delete state.previous;
    }

    if (secret) {
      let secretValid = true;
      try {
        await clientFor(values, { kind: "secret", clientSecret: secret }, deps).token(signal, true);
      } catch (err) {
        if (!refused(err)) throw err;
        secretValid = false;
      }
      let gone = !secretValid;
      if (secretValid) {
        // passwordCredentials carry the secret's first three characters;
        // only an unambiguous match is removed.
        const matches = ((await readSelf())?.passwordCredentials ?? []).filter((p) => p.hint === secret.slice(0, 3));
        if (matches.length === 1) {
          try {
            await certGraph.removePassword(self, matches[0]!.keyId, signal);
            gone = true;
          } catch (err) {
            if (!(err instanceof GraphError)) throw err;
          }
        }
      }
      if (gone) {
        await deps.connectors().clearSecret(instance.id, "clientSecret");
        items.push({ ...base, state: "drifted", diff: [{ path: "clientSecret", want: "deleted", have: "stored" }] });
      } else {
        step = DELETE_SECRET_STEP;
      }
    }

    if (Date.parse(state.notAfter) - now.getTime() < ROTATE_BEFORE_MS) {
      if (!objectId) {
        step ??= objectIdStep(day(state.notAfter));
      } else {
        const next = held(issueCertificate("connector", now));
        const added = await certGraph.addKey(
          objectId,
          { key: next.der, displayName: certDisplayName("connector", next.thumbprint) },
          keyProof(state, objectId, now.getTime()),
          signal
        );
        const { previous: _none, step: _step, working: _working, ...current } = state;
        state = { ...next, keyId: added.keyId, previous: current };
        items.push({
          ...base,
          state: "drifted",
          diff: [
            {
              path: "certificate",
              want: `valid for more than ${ROTATE_BEFORE_MS / DAY_MS} days`,
              have: `expires ${day(current.notAfter)}`,
            },
          ],
        });
      }
    }
  } else if (state.previous) {
    // The successor from addKey is not usable yet (Entra replicates new
    // keys within minutes); the replaced one signs in meanwhile.
  } else if (!secret) {
    // Removed in the portal, or never uploaded.
    state.working = false;
    step = UPLOAD_STEP;
  } else {
    state.working = false;
    const secretGraph = clientFor(values, { kind: "secret", clientSecret: secret }, deps);
    const app = await secretGraph.self(signal);
    // Only onto an app with no certificates: PATCH replaces the list, and
    // the console can't send back certificates it doesn't hold.
    if (app && !(app.keyCredentials ?? []).length) {
      try {
        await secretGraph.updateApplication(
          self,
          {
            keyCredentials: [
              keyCredentialBody({ key: state.der, displayName: certDisplayName("connector", state.thumbprint) }),
            ],
          },
          signal
        );
        items.push({
          ...base,
          state: "drifted",
          diff: [{ path: "keyCredentials", want: state.thumbprint, have: "none" }],
        });
      } catch (err) {
        if (!(err instanceof GraphError)) throw err;
        step = UPLOAD_STEP;
      }
    } else {
      step = UPLOAD_STEP;
    }
  }

  if (step) state.step = step;
  else delete state.step;
  await saveManagement(deps, instance.id, state);
  return items;
}
