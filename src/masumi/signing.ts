// Ed25519 signatures for /provide_input (MIP-003: "signature ... verifiable with the agent's Ed25519 key").
// Signed message: the UTF-8 bytes of the lowercase hex `input_hash` string the response carries.
// Key: MASUMI_SIGNING_KEY (32-byte seed, hex), else a seed generated once and kept in the store.
// The public key is served at GET /signing_key; the signature is 64 bytes, hex encoded.
import { createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const HEX64 = /^[0-9a-fA-F]{64}$/;
export const SIGNING_KEY_KV = 'masumi:ed25519_seed';

export interface Signer {
  /** Raw 32-byte Ed25519 public key, hex. */
  readonly publicKey: string;
  sign(message: string): string;
}

export function signerFromSeed(seedHex: string): Signer {
  if (!HEX64.test(seedHex)) throw new Error('MASUMI_SIGNING_KEY must be a 32-byte Ed25519 seed in hex (64 characters)');
  const key: KeyObject = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  const publicKey = Buffer.from(spki.subarray(SPKI_PREFIX.length)).toString('hex');
  return { publicKey, sign: (message) => sign(null, Buffer.from(message, 'utf8'), key).toString('hex') };
}

/** Verifies a hex signature over a UTF-8 message with a raw hex Ed25519 public key. */
export function verifySignature(message: string, signatureHex: string, publicKeyHex: string): boolean {
  if (!/^[0-9a-fA-F]{128}$/.test(signatureHex) || !HEX64.test(publicKeyHex)) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureHex, 'hex'));
}

/** The configured key, else the persisted one, else a new one that is persisted. */
export function loadSigner(opts: { seed?: string; getKv(k: string): string | null; setKv(k: string, v: string): void }): Signer {
  if (opts.seed) return signerFromSeed(opts.seed);
  let seed = opts.getKv(SIGNING_KEY_KV);
  if (!seed || !HEX64.test(seed)) {
    seed = randomBytes(32).toString('hex');
    opts.setKv(SIGNING_KEY_KV, seed);
  }
  return signerFromSeed(seed);
}
