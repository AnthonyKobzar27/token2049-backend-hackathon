// One hash for one verified result, shared by the Masumi submit-result and the escrow release.
import { createHash } from 'node:crypto';
import type { DeliveredResult } from '../domain/types';
import { canonicalJson, resultHash } from '../masumi/hash';

/** Normalised delivery: trimmed text, de-duplicated URLs, fields as given. Empty parts are left out. */
export function normaliseDelivery(d: DeliveredResult): DeliveredResult {
  const text = d.text?.trim();
  const urls = [...new Set((d.urls ?? []).map((u) => u.trim()).filter(Boolean))];
  const fields = d.fields && Object.keys(d.fields).length ? d.fields : undefined;
  return { ...(text ? { text } : {}), ...(urls.length ? { urls } : {}), ...(fields ? { fields } : {}) };
}

/**
 * The string whose hash is the result hash: RFC 8785 JSON of { bookingId, delivery }.
 * Submit this string's hash to Masumi so Masumi and the escrow release reference the same result.
 */
export const resultPayload = (bookingId: string, d: DeliveredResult): string => canonicalJson({ bookingId, delivery: normaliseDelivery(d) });

/**
 * MIP-004 output hash (src/masumi/hash.ts) of resultPayload. `identifier` is the Masumi
 * identifierFromPurchaser when the job was paid through Masumi, otherwise the booking id.
 */
export const verifiedResultHash = (bookingId: string, d: DeliveredResult, identifier = bookingId): string =>
  resultHash(resultPayload(bookingId, d), identifier);

/** Content-only hash, to tell a new delivery from a re-read of the same one. */
export const deliveryHash = (d: DeliveredResult): string =>
  createHash('sha256').update(canonicalJson(normaliseDelivery(d)), 'utf8').digest('hex');

export const isEmptyDelivery = (d: DeliveredResult): boolean => Object.keys(normaliseDelivery(d)).length === 0;
