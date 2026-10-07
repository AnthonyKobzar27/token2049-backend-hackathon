// MIP-004 hashing. Input: sha256(identifier + ";" + JCS(input_data)). Output: sha256(identifier + ";" + output).
// The output side follows the pip-masumi reference (create_masumi_output_hash), which JSON-escapes the
// string before hashing, not the MIP-004 prose, which says raw. They differ only for " \ and control chars.
import { createHash } from 'node:crypto';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** RFC 8785 JSON Canonicalization: sorted keys (UTF-16 order), no whitespace, ECMAScript number format. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

export function inputHash(inputData: unknown, identifierFromPurchaser: string): string {
  return sha256(`${identifierFromPurchaser};${canonicalJson(inputData)}`);
}

/** Escapes like Python's json.dumps(s, ensure_ascii=False)[1:-1]. */
const escapeOutput = (s: string): string => JSON.stringify(s).slice(1, -1);

export function resultHash(output: string, identifierFromPurchaser: string, opts: { raw?: boolean } = {}): string {
  return sha256(`${identifierFromPurchaser};${opts.raw ? output : escapeOutput(output)}`);
}

/** SHA-256 of the canonical JSON of an input_schema, for /provide_input's input_schema_hash. */
export const schemaHash = (schema: unknown): string => createHash('sha256').update(canonicalJson(schema), 'utf8').digest('hex');
