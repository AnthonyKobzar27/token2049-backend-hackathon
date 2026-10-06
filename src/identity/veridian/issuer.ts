// VeridianCredentialIssuer: issues the "HAAS Verified Worker" ACDC from HAAS's own KERI identifier
// (AID) in a KERIA agent, delivers it to the worker's Veridian wallet over IPEX, and verifies
// credentials that workers present back. Implements the CredentialIssuer seam in ../issuer.ts.
//
//   init()          create or load the issuer AID, its agent end role, the credential registry
//                   (TEL) and resolve the schema OOBI so KERIA can validate against it
//   issueToHolder() credentials().issue -> wait -> ipex().grant -> submitGrant to the worker AID
//   verify()        POST /credentials/verify (KERIA parses the ACDC + iss event), then checks schema,
//                   issuer, holder and the registry state (issued vs revoked)
//   presentations() IPEX grants sent *to* HAAS by workers: the exn is signed by the sender's AID, so
//                   a grant whose sender is the credential's issuee proves the worker holds it

import { ready, Saider } from 'signify-ts';
import type { CredentialIssuer, CredentialStatus, CredentialSubject } from '../issuer';
import type { CardanoNetwork, WorkerCredential } from '../types';
import { isNotFound, waitOp, type SignifyPort } from './client';
import { HAAS_WORKER_SCHEMA_SAID } from './schema';

export interface VeridianIssuerOptions {
  /** Name of the HAAS issuer AID inside the KERIA agent. */
  issuerName?: string;
  registryName?: string;
  schemaSaid?: string;
  /** URL that serves the schema JSON (HAAS serves it at /oobi/{said}). Resolved during init(). */
  schemaOobiUrl?: string;
  /**
   * Public base URL that serves /oobi/{schemaSaid} (HAAS itself). Registered as the issuer's 'indexer'
   * end role + location scheme: the Veridian wallet looks schemas up there when it admits a grant.
   */
  oobiBaseUrl?: string;
  /** Alias the wallet shows for the connection (appended to the OOBI as ?name=). */
  displayName?: string;
  /** Witness OOBIs to resolve and witness AIDs to use for the issuer AID. Empty: no witnesses (local demo). */
  witnessOobis?: string[];
  witnessAids?: string[];
  /** Accept credentials from these issuer AIDs as well as our own. */
  trustedIssuers?: string[];
  network?: CardanoNetwork;
  /** Deadline for each KERIA operation on the write path. */
  opTimeoutMs?: number;
  now?: () => number;
}

/** What HAAS attests about a worker. */
export interface WorkerAttributes {
  workerId: string;
  platformsVerified: string[];
  verificationMethod: string;
  /** ISO date time of the verification; defaults to now. */
  issuedAt?: string;
  /** CIP-68 reputation asset (policy id + asset name hex), when the worker also has one on Cardano. */
  cardanoReputationAsset?: string;
}

/**
 * The ACDC, mapped onto WorkerCredential so the rest of src/identity can store it unchanged:
 * policyId = schema SAID, assetName = credential SAID, refUnit = registry id, userUnit = holder AID,
 * walletAddress = holder AID, txHash = SAID of the TEL issuance event.
 */
export interface VeridianCredential extends WorkerCredential {
  issuer: 'veridian';
  said: string;
  schemaSaid: string;
  registryId: string;
  issuerAid: string;
  holderAid: string;
  attributes: Required<Omit<WorkerAttributes, 'cardanoReputationAsset'>> & { cardanoReputationAsset?: string };
  /** SAID of the IPEX grant exn sent to the worker. */
  grantSaid: string;
}

/** A credential as the worker presents it: the ACDC body and its TEL issuance event (both JSON). */
export interface PresentedCredential {
  acdc: Record<string, any>;
  iss: Record<string, any>;
}

export interface VerificationResult {
  valid: boolean;
  /** Why it is not valid; absent when valid. */
  reason?: string;
  said?: string;
  issuerAid?: string;
  holderAid?: string;
  workerId?: string;
  platformsVerified?: string[];
  verificationMethod?: string;
  /** TEL state: iss/bis issued, rev/brv revoked. */
  registryState?: string;
  /** The presenter proved control of the holder AID (signed IPEX grant). */
  holderProven: boolean;
  checkedAt: number;
}

export interface Presentation {
  /** SAID of the grant exn the worker sent. */
  grantSaid: string;
  sender: string;
  result: VerificationResult;
}

export interface VeridianCredentialIssuer extends CredentialIssuer {
  readonly kind: 'veridian';
  init(): Promise<{ issuerAid: string; registryId: string; schemaSaid: string }>;
  issuerAid(): Promise<string>;
  /** OOBI of the HAAS issuer, for the worker's wallet to resolve (the onboarding QR code). */
  issuerOobi(): Promise<string>;
  /** Resolves a worker wallet's OOBI and returns its AID. */
  resolveHolder(oobi: string, alias?: string): Promise<string>;
  issueToHolder(holderAid: string, attrs: WorkerAttributes): Promise<VeridianCredential>;
  /** Did the holder send an IPEX admit for this grant? Marks the notification read when found. */
  admitted(grantSaid: string): Promise<boolean>;
  verify(presented: PresentedCredential, opts?: { timeoutMs?: number; expectedHolder?: string; holderProven?: boolean }): Promise<VerificationResult>;
  /** Verifies a credential HAAS issued, by SAID (used by the router cache: no wallet in the loop). */
  verifySaid(said: string, opts?: { timeoutMs?: number }): Promise<VerificationResult>;
  /** IPEX grants workers sent to HAAS since the last call, each verified. */
  presentations(opts?: { timeoutMs?: number }): Promise<Presentation[]>;
  revoke(said: string): Promise<void>;
}

const REVOKED = new Set(['rev', 'brv']);
const ISSUED = new Set(['iss', 'bis']);

const aidOfOobi = (oobi: string): string | undefined => {
  try {
    return new URL(oobi).pathname.split('/').filter(Boolean)[1];
  } catch {
    return undefined;
  }
};

const isAid = (s: string) => /^[A-Za-z0-9_-]{44}$/.test(s);

/**
 * `source` is a connected client, or a function that connects (HAAS boots without waiting on KERIA:
 * the first call that needs the agent connects, and a failed connection is retried on the next call).
 */
export function createVeridianCredentialIssuer(source: SignifyPort | (() => Promise<SignifyPort>), opts: VeridianIssuerOptions = {}): VeridianCredentialIssuer {
  const connect = typeof source === 'function' ? source : async () => source;
  let client!: SignifyPort;
  const issuerName = opts.issuerName ?? 'haas-issuer';
  const registryName = opts.registryName ?? 'haas-verified-workers';
  const schemaSaid = opts.schemaSaid ?? HAAS_WORKER_SCHEMA_SAID;
  const opTimeout = opts.opTimeoutMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const network = opts.network ?? 'preprod';

  let initialized: Promise<{ issuerAid: string; registryId: string; schemaSaid: string }> | undefined;

  async function ensureAid(): Promise<string> {
    try {
      return (await client.identifiers().get(issuerName)).prefix;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    for (const [i, oobi] of (opts.witnessOobis ?? []).entries()) {
      await waitOp(client, await client.oobis().resolve(oobi, `witness-${i}`), opTimeout);
    }
    const wits = opts.witnessAids ?? [];
    const created = await client.identifiers().create(issuerName, wits.length ? { toad: Math.min(wits.length, Math.ceil((wits.length + 1) / 2)), wits } : {});
    await waitOp(client, await created.op(), opTimeout);
    const hab = await client.identifiers().get(issuerName);
    // The agent end role makes /oobi/{aid}/agent/{agentAid} resolvable for wallets.
    const eid = client.agent?.pre;
    if (eid) await waitOp(client, await (await client.identifiers().addEndRole(issuerName, 'agent', eid)).op(), opTimeout);
    return hab.prefix;
  }

  async function ensureRegistry(): Promise<string> {
    const existing = (await client.registries().list(issuerName)).find((r) => r.name === registryName);
    if (existing) return existing.regk;
    const res = await client.registries().create({ name: issuerName, registryName, noBackers: true });
    await waitOp(client, await res.op(), opTimeout);
    const made = (await client.registries().list(issuerName)).find((r) => r.name === registryName);
    if (!made) throw new Error(`registry ${registryName} was not created`);
    return made.regk;
  }

  /** The wallet finds the schema at {indexer url}/oobi/{said}; see docs/VERIDIAN.md. Idempotent in KERIA. */
  async function ensureIndexer(issuerAid: string, url: string) {
    try {
      await waitOp(client, await (await client.identifiers().addLocScheme(issuerName, { url, scheme: new URL(url).protocol.replace(':', '') })).op(), opTimeout);
      await waitOp(client, await (await client.identifiers().addEndRole(issuerName, 'indexer', issuerAid)).op(), opTimeout);
    } catch (err) {
      console.warn(`[veridian] could not register the indexer end role at ${url}: ${(err as Error).message}`);
    }
  }

  const init = () => {
    initialized ??= (async () => {
      client = await connect();
      const issuerAid = await ensureAid();
      const registryId = await ensureRegistry();
      if (opts.oobiBaseUrl) await ensureIndexer(issuerAid, opts.oobiBaseUrl);
      if (opts.schemaOobiUrl) await waitOp(client, await client.oobis().resolve(opts.schemaOobiUrl, 'haas-verified-worker-schema'), opTimeout);
      return { issuerAid, registryId, schemaSaid };
    })().catch((err) => {
      initialized = undefined;
      throw err;
    });
    return initialized;
  };

  async function registryState(ri: string, said: string): Promise<string | undefined> {
    try {
      return (await client.credentials().state(ri, said)).et;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  /** Content checks that need no network: SAIDs, schema, issuer, issuance event. */
  async function checkShape(p: PresentedCredential, trusted: Set<string>): Promise<string | null> {
    const { acdc, iss } = p;
    if (!acdc || typeof acdc !== 'object' || !iss || typeof iss !== 'object') return 'acdc and iss are required';
    if (acdc.s !== schemaSaid) return `not a HAAS Verified Worker credential (schema ${acdc.s})`;
    if (!trusted.has(acdc.i)) return `issuer ${acdc.i} is not trusted`;
    if (iss.t !== 'iss' || iss.i !== acdc.d || iss.ri !== acdc.ri) return 'issuance event does not match the credential';
    if (typeof acdc.a !== 'object' || !acdc.a?.i) return 'credential has no issuee';
    await ready();
    try {
      if (!new Saider({ qb64: acdc.d }).verify(acdc, true, true, undefined, 'd')) return 'credential SAID does not match its content';
      if (!new Saider({ qb64: acdc.a.d }).verify(acdc.a, true, false, undefined, 'd')) return 'attributes SAID does not match their content';
    } catch (err) {
      return `malformed credential: ${(err as Error).message}`;
    }
    return null;
  }

  function result(acdc: Record<string, any>, extra: Partial<VerificationResult>): VerificationResult {
    const a = (acdc?.a ?? {}) as Record<string, any>;
    return {
      valid: false,
      holderProven: false,
      checkedAt: now(),
      ...(acdc?.d ? { said: acdc.d } : {}),
      ...(acdc?.i ? { issuerAid: acdc.i } : {}),
      ...(a.i ? { holderAid: a.i } : {}),
      ...(a.workerId ? { workerId: a.workerId } : {}),
      ...(Array.isArray(a.platformsVerified) ? { platformsVerified: a.platformsVerified } : {}),
      ...(a.verificationMethod ? { verificationMethod: a.verificationMethod } : {}),
      ...extra,
    };
  }

  const self: VeridianCredentialIssuer = {
    kind: 'veridian',
    init,
    issuerAid: async () => (await init()).issuerAid,

    async issuerOobi() {
      await init();
      const res = await client.oobis().get(issuerName, 'agent');
      const oobi = res.oobis[0];
      if (!oobi) throw new Error('KERIA returned no agent OOBI for the issuer; is KERIA_CURLS / the agent end role set?');
      const u = new URL(oobi);
      u.searchParams.set('name', opts.displayName ?? 'HAAS');
      return u.toString();
    },

    async resolveHolder(oobi, alias) {
      if (isAid(oobi)) return oobi;
      await init();
      const op = await client.oobis().resolve(oobi, alias);
      const done = await waitOp<{ i?: string }>(client, op, opTimeout);
      const aid = done.response?.i ?? aidOfOobi(oobi);
      if (!aid || !isAid(aid)) throw new Error(`could not read an AID from OOBI ${oobi}`);
      return aid;
    },

    async issueToHolder(holderAid, attrs) {
      const { issuerAid, registryId } = await init();
      const issuedAt = attrs.issuedAt ?? new Date(now()).toISOString();
      const a: Record<string, unknown> = {
        i: holderAid,
        workerId: attrs.workerId,
        platformsVerified: attrs.platformsVerified,
        verificationMethod: attrs.verificationMethod,
        issuedAt,
        ...(attrs.cardanoReputationAsset ? { cardanoReputationAsset: attrs.cardanoReputationAsset } : {}),
      };
      const issued = await client.credentials().issue(issuerName, { ri: registryId, s: schemaSaid, a });
      await waitOp(client, issued.op, opTimeout);

      const datetime = new Date(now()).toISOString().replace('Z', '000+00:00');
      const [grant, sigs, atc] = await client.ipex().grant({ senderName: issuerName, recipient: holderAid, datetime, acdc: issued.acdc, anc: issued.anc, iss: issued.iss, message: 'HAAS Verified Worker' });
      await waitOp(client, await client.ipex().submitGrant(issuerName, grant, sigs, atc, [holderAid]), opTimeout);

      const said = String(issued.acdc.sad.d);
      return {
        workerId: attrs.workerId,
        walletAddress: holderAid,
        issuer: 'veridian',
        network,
        policyId: schemaSaid,
        assetName: said,
        refUnit: registryId,
        userUnit: holderAid,
        txHash: String(issued.iss.sad.d),
        issuedAt: Date.parse(issuedAt) || now(),
        said,
        schemaSaid,
        registryId,
        issuerAid,
        holderAid,
        attributes: { workerId: attrs.workerId, platformsVerified: attrs.platformsVerified, verificationMethod: attrs.verificationMethod, issuedAt, ...(attrs.cardanoReputationAsset ? { cardanoReputationAsset: attrs.cardanoReputationAsset } : {}) },
        grantSaid: String(grant.sad?.d ?? grant.ked?.d ?? ''),
      };
    },

    // CredentialIssuer seam: walletAddress is the worker's AID or wallet OOBI.
    async issue(subject: CredentialSubject) {
      const holder = await self.resolveHolder(subject.walletAddress, `worker-${subject.workerId}`);
      return self.issueToHolder(holder, { workerId: subject.workerId, platformsVerified: [], verificationMethod: 'operator-review' });
    },

    async status(cred: WorkerCredential): Promise<CredentialStatus> {
      await init();
      const said = (cred as Partial<VeridianCredential>).said ?? cred.assetName;
      const ri = (cred as Partial<VeridianCredential>).registryId ?? cred.refUnit;
      const et = await registryState(ri, said);
      return { valid: !!et && ISSUED.has(et), bound: !!et && !REVOKED.has(et), holder: (cred as Partial<VeridianCredential>).holderAid ?? cred.walletAddress };
    },

    async admitted(grantSaid) {
      await init();
      const { notes } = await client.notifications().list(0, 99);
      for (const note of notes) {
        if (note.a.r !== '/exn/ipex/admit' || !note.a.d) continue;
        const { exn } = await client.exchanges().get(note.a.d);
        if (exn.p !== grantSaid) continue;
        if (!note.r) await client.notifications().mark(note.i).catch(() => undefined);
        return true;
      }
      return false;
    },

    async verify(presented, vopts = {}) {
      const { issuerAid } = await init();
      const trusted = new Set([issuerAid, ...(opts.trustedIssuers ?? [])]);
      const shapeError = await checkShape(presented, trusted);
      if (shapeError) return result(presented?.acdc, { reason: shapeError });
      const { acdc, iss } = presented;
      if (vopts.expectedHolder && acdc.a.i !== vopts.expectedHolder) return result(acdc, { reason: `credential was issued to ${acdc.a.i}, not ${vopts.expectedHolder}` });

      // KERIA parses the ACDC with its TEL event and checks it against the issuer's KEL and the schema.
      const res = await client.fetch('/credentials/verify', 'POST', { acdc, iss });
      if (!res.ok) return result(acdc, { reason: `KERIA rejected the credential (${res.status}): ${(await res.text()).slice(0, 200)}` });
      try {
        await waitOp(client, (await res.json()) as { name: string }, vopts.timeoutMs ?? opTimeout);
      } catch (err) {
        return result(acdc, { reason: (err as Error).message });
      }
      const et = await registryState(acdc.ri, acdc.d);
      if (!et) return result(acdc, { reason: 'credential is not in the issuer registry' });
      if (REVOKED.has(et)) return result(acdc, { reason: 'credential was revoked', registryState: et });
      return result(acdc, { valid: ISSUED.has(et), registryState: et, holderProven: !!vopts.holderProven, ...(ISSUED.has(et) ? {} : { reason: `unexpected registry state ${et}` }) });
    },

    async verifySaid(said, vopts = {}) {
      const { issuerAid } = await init();
      const deadline = AbortSignal.timeout(vopts.timeoutMs ?? opTimeout);
      const race = <T>(p: Promise<T>) =>
        Promise.race([p, new Promise<never>((_, rej) => deadline.addEventListener('abort', () => rej(new Error(`verification of ${said} timed out`)), { once: true }))]);
      let cred: any;
      try {
        cred = await race(client.credentials().get(said));
      } catch (err) {
        if (isNotFound(err)) return result({ d: said }, { reason: 'unknown credential' });
        return result({ d: said }, { reason: (err as Error).message });
      }
      const acdc = (cred?.sad ?? {}) as Record<string, any>;
      if (acdc.s !== schemaSaid) return result(acdc, { reason: 'not a HAAS Verified Worker credential' });
      if (acdc.i !== issuerAid && !(opts.trustedIssuers ?? []).includes(acdc.i)) return result(acdc, { reason: `issuer ${acdc.i} is not trusted` });
      // KERIA reports the TEL state with the credential; ask again only when it is missing.
      const et: string | undefined = cred?.status?.et ?? (await race(registryState(acdc.ri, said)).catch(() => undefined));
      if (!et) return result(acdc, { reason: 'registry state unavailable' });
      if (REVOKED.has(et)) return result(acdc, { reason: 'credential was revoked', registryState: et });
      return result(acdc, { valid: ISSUED.has(et), registryState: et });
    },

    async presentations(popts = {}) {
      const { issuerAid } = await init();
      const { notes } = await client.notifications().list(0, 99);
      const out: Presentation[] = [];
      for (const note of notes) {
        if (note.r || note.a.r !== '/exn/ipex/grant' || !note.a.d) continue;
        const { exn } = await client.exchanges().get(note.a.d);
        // KERIA 0.4 also notifies the sender of its own grants (the credentials HAAS issued).
        if (exn.i === issuerAid) {
          await client.notifications().mark(note.i).catch(() => undefined);
          continue;
        }
        const acdc = exn.e?.acdc as Record<string, any> | undefined;
        const iss = exn.e?.iss as Record<string, any> | undefined;
        let res: VerificationResult;
        if (!acdc || !iss) res = result({}, { reason: 'grant carries no credential' });
        else if (exn.i !== acdc.a?.i) res = result(acdc, { reason: `presented by ${exn.i}, but issued to ${acdc.a?.i}` });
        else res = await self.verify({ acdc, iss }, { holderProven: true, ...(popts.timeoutMs ? { timeoutMs: popts.timeoutMs } : {}) });
        await client.notifications().mark(note.i).catch(() => undefined);
        out.push({ grantSaid: note.a.d, sender: exn.i, result: res });
      }
      return out;
    },

    async revoke(said) {
      await init();
      const { op } = await client.credentials().revoke(issuerName, said);
      await waitOp(client, op, opTimeout);
    },
  };
  return self;
}
