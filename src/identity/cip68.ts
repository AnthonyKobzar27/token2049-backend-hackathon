// Pure CIP-68 helpers: asset names, the reference datum (encode and decode), CIP-25/CIP-20 metadata
// for job receipts, and explorer links. No network access here.

import { createHash } from 'node:crypto';
import type { CardanoNetwork, JobReceipt, Reputation } from './types';
import { avgRating } from './types';

export const LABEL_100 = '000643b0'; // CIP-67 label 100: reference NFT
export const LABEL_222 = '000de140'; // CIP-67 label 222: user NFT

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
export const utf8ToHex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');
export const hexToUtf8 = (h: string): string => Buffer.from(h, 'hex').toString('utf8');

/** "HAAS-" + 16 hex of sha256(workerId): 21 bytes, within the 28 bytes left after the CIP-68 label. */
export const credentialAssetName = (workerId: string): string => utf8ToHex(`HAAS-${sha256hex(`worker:${workerId}`).slice(0, 16)}`);

/** "HAASJOB-" + 16 hex of sha256(bookingId): deterministic, so a retried mint can find an earlier success. */
export const receiptAssetNameUtf8 = (bookingId: string): string => `HAASJOB-${sha256hex(`booking:${bookingId}`).slice(0, 16)}`;
export const receiptAssetName = (bookingId: string): string => utf8ToHex(receiptAssetNameUtf8(bookingId));

export const refUnit = (policyId: string, assetName: string): string => `${policyId}${LABEL_100}${assetName}`;
export const userUnit = (policyId: string, assetName: string): string => `${policyId}${LABEL_222}${assetName}`;

// ----------------------------------------------------------------- datum

export type DatumFields = Record<string, string | number>;

/** Plutus data in the JSON shape Mesh and cardano-cli use. */
export type PlutusJson =
  | { constructor: number; fields: PlutusJson[] }
  | { map: { k: PlutusJson; v: PlutusJson }[] }
  | { list: PlutusJson[] }
  | { int: number | bigint }
  | { bytes: string };

/** Plutus byte strings in datums are chunked at 64 bytes when serialised; Mesh handles that. */
export function encodeCip68Datum(fields: DatumFields, version = 1): PlutusJson {
  const map = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => ({ k: { bytes: utf8ToHex(k) } as PlutusJson, v: (typeof v === 'number' ? { int: Math.round(v) } : { bytes: utf8ToHex(v) }) as PlutusJson }));
  return { constructor: 0, fields: [{ map }, { int: version }] };
}

export function decodeCip68Datum(datum: unknown): DatumFields | null {
  const d = datum as { constructor?: number | bigint; fields?: unknown[] } | null;
  if (!d || Number(d.constructor) !== 0 || !Array.isArray(d.fields)) return null;
  const m = d.fields[0] as { map?: { k: { bytes?: string }; v: { bytes?: string; int?: number | bigint } }[] } | undefined;
  if (!m || !Array.isArray(m.map)) return null;
  const out: DatumFields = {};
  for (const { k, v } of m.map) {
    if (typeof k?.bytes !== 'string') continue;
    const key = hexToUtf8(k.bytes);
    if (v && typeof v.bytes === 'string') out[key] = hexToUtf8(v.bytes);
    else if (v && v.int !== undefined) out[key] = Number(v.int);
  }
  return out;
}

const BADGE_SVG =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='30' fill='%230033ad'/><path d='M18 33l9 9 19-20' stroke='white' stroke-width='6' fill='none'/></svg>";

export interface CredentialDatumInput {
  workerId: string;
  walletAddress: string;
  issuedAt: number;
  image?: string;
  reputation: Reputation;
}

/** The reference datum: CIP-68 display fields plus the worker binding and the reputation totals. */
export function credentialDatumFields(input: CredentialDatumInput): DatumFields {
  const r = input.reputation;
  const f: DatumFields = {
    name: 'HAAS Verified Worker',
    image: input.image ?? BADGE_SVG,
    description: 'Issued by HAAS (Human as a Service). Bound to one wallet; reputation from verified, paid jobs.',
    issuer: 'HAAS',
    workerId: input.workerId,
    wallet: input.walletAddress,
    issuedAt: input.issuedAt,
    jobs: r.jobsCompleted,
    verifiedJobs: r.verifiedJobs,
    ratedJobs: r.ratedJobs,
    ratingSumX100: Math.round(r.ratingSum * 100),
    earnedUsdCents: Math.round(r.totalEarnedUsd * 100),
  };
  if (r.lastJobId) f.lastJob = r.lastJobId;
  if (r.lastBookingId) f.lastBooking = r.lastBookingId;
  if (r.lastResultHash) f.lastResult = r.lastResultHash;
  if (r.lastPaymentTx) f.lastPayment = r.lastPaymentTx;
  if (r.lastReceiptUnit) f.lastReceipt = r.lastReceiptUnit;
  if (r.lastUpdateTx) f.prevTx = r.lastUpdateTx;
  if (r.updatedAt) f.updatedAt = r.updatedAt;
  return f;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function reputationFromFields(f: DatumFields): Reputation {
  const r: Reputation = {
    jobsCompleted: num(f.jobs),
    verifiedJobs: num(f.verifiedJobs),
    ratedJobs: num(f.ratedJobs),
    ratingSum: num(f.ratingSumX100) / 100,
    totalEarnedUsd: num(f.earnedUsdCents) / 100,
  };
  const set = <K extends keyof Reputation>(k: K, v: Reputation[K] | undefined) => {
    if (v !== undefined) r[k] = v;
  };
  set('lastJobId', str(f.lastJob));
  set('lastBookingId', str(f.lastBooking));
  set('lastResultHash', str(f.lastResult));
  set('lastPaymentTx', str(f.lastPayment));
  set('lastReceiptUnit', str(f.lastReceipt));
  if (typeof f.updatedAt === 'number') r.updatedAt = f.updatedAt;
  return r;
}

/** Totals after one more job. Pure. */
export function applyJob(r: Reputation, job: Pick<JobReceipt, 'jobId' | 'bookingId' | 'resultHash' | 'qaPassed' | 'paymentTx' | 'priceUsd' | 'rating' | 'receiptUnit' | 'at'>): Reputation {
  const next: Reputation = {
    ...r,
    jobsCompleted: r.jobsCompleted + 1,
    verifiedJobs: r.verifiedJobs + (job.qaPassed ? 1 : 0),
    totalEarnedUsd: Math.round((r.totalEarnedUsd + Math.max(0, job.priceUsd)) * 100) / 100,
    lastJobId: job.jobId,
    lastBookingId: job.bookingId,
    lastResultHash: job.resultHash,
    updatedAt: job.at,
  };
  if (job.rating !== undefined && Number.isFinite(job.rating)) {
    next.ratedJobs = r.ratedJobs + 1;
    next.ratingSum = Math.round((r.ratingSum + Math.min(5, Math.max(0, job.rating))) * 100) / 100;
  }
  if (job.paymentTx) next.lastPaymentTx = job.paymentTx;
  else delete next.lastPaymentTx;
  if (job.receiptUnit) next.lastReceiptUnit = job.receiptUnit;
  return next;
}

// -------------------------------------------------------------- metadata

/** Transaction metadata strings are limited to 64 bytes; longer values become a list of chunks. */
export function chunk64(s: string): string | string[] {
  if (Buffer.byteLength(s, 'utf8') <= 64) return s;
  const out: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch, 'utf8') > 64) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export type Metadatum = string | number | Metadatum[] | { [k: string]: Metadatum };

/** CIP-20 (label 674) message, readable on every explorer. */
export function cip20Message(lines: string[]): Metadatum {
  return { msg: lines.map((l) => chunk64(l)).flat() };
}

/** CIP-25 (label 721) metadata for the job receipt NFT: links the worker to the job, the verified result and the payment. */
export function receiptMetadata(policyId: string, r: Omit<JobReceipt, 'txHash' | 'receiptUnit'>): Metadatum {
  const haas: Record<string, Metadatum> = {
    worker: chunk64(r.workerId),
    job: chunk64(r.masumiJobId ?? r.jobId),
    booking: chunk64(r.bookingId),
    result: chunk64(r.resultHash),
    resultKind: r.resultHashKind,
    qa: r.qaPassed === null ? 'none' : r.qaPassed ? 'pass' : 'fail',
    priceUsdCents: Math.round(r.priceUsd * 100),
  };
  if (r.masumiJobId) haas.haasJob = chunk64(r.jobId);
  if (r.paymentTx) haas.payment = chunk64(r.paymentTx);
  if (r.paymentKind) haas.paymentKind = r.paymentKind;
  if (r.rating !== undefined) haas.ratingX100 = Math.round(r.rating * 100);
  const name = receiptAssetNameUtf8(r.bookingId);
  return {
    [policyId]: {
      [name]: {
        name: `HAAS job receipt ${name.slice(8, 16)}`,
        image: chunk64(BADGE_SVG),
        mediaType: 'image/svg+xml',
        description: chunk64('Proof of a completed, verified and paid HAAS job.'),
        haas,
      },
    },
    version: 1,
  };
}

// ------------------------------------------------------------------ links

const EXPLORER: Record<CardanoNetwork, string> = { preprod: 'https://preprod.cardanoscan.io', mainnet: 'https://cardanoscan.io' };
export const explorer = (network: CardanoNetwork) => ({
  tx: (hash: string) => `${EXPLORER[network]}/transaction/${hash}`,
  token: (unit: string) => `${EXPLORER[network]}/token/${unit}`,
  policy: (policyId: string) => `${EXPLORER[network]}/tokenPolicy/${policyId}`,
  address: (addr: string) => `${EXPLORER[network]}/address/${addr}`,
});

export { avgRating };
