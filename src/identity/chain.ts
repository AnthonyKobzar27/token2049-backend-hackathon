// The chain port used by the identity module, and an in-memory implementation for tests and for
// running without Cardano credentials. The live implementation is src/identity/mesh.ts.

import { createHash } from 'node:crypto';
import { encodeCip68Datum, decodeCip68Datum, refUnit, userUnit, receiptAssetName, type DatumFields, type Metadatum } from './cip68';
import type { CardanoNetwork } from './types';

export interface ReferenceState {
  fields: DatumFields;
  /** Where the reference NFT sits and in which output. */
  address: string;
  txHash: string;
  outputIndex: number;
}

export interface ReputationChain {
  readonly kind: 'mesh' | 'memory';
  readonly network: CardanoNetwork;
  policyId(): Promise<string>;
  operatorAddress(): Promise<string>;
  /** Mints the (100) reference NFT to the operator with the datum and the (222) user NFT to `holder`. */
  mintCredential(input: { assetName: string; holder: string; fields: DatumFields; message: Metadatum }): Promise<{ txHash: string }>;
  /**
   * Spends the reference NFT and re-locks it with a new datum. Optionally mints a CIP-25 receipt
   * NFT (label 721 metadata) to `receipt.holder` in the same transaction.
   */
  updateReference(input: {
    assetName: string;
    fields: DatumFields;
    message: Metadatum;
    receipt?: { assetName: string; holder: string; metadata: Metadatum };
  }): Promise<{ txHash: string }>;
  readReference(assetName: string): Promise<ReferenceState | null>;
  /** Address holding the most of `unit`, or null when the asset does not exist. */
  holderOf(unit: string): Promise<string | null>;
  /** True once the transaction is in a block; false on timeout. */
  awaitTx(txHash: string, timeoutMs: number): Promise<boolean>;
}

// ------------------------------------------------------------------ memory

export interface MemoryChain extends ReputationChain {
  /** Everything submitted, for assertions. */
  readonly txs: { txHash: string; kind: 'mint' | 'update'; mints: string[]; message: Metadatum; receiptMetadata?: Metadatum }[];
  /** Makes the next n submissions throw. */
  failNext(n: number, message?: string): void;
  /** Moves a token, e.g. to simulate a worker transferring the user NFT. */
  transfer(unit: string, to: string): void;
}

export function createMemoryChain(opts: { network?: CardanoNetwork; policyId?: string; operator?: string } = {}): MemoryChain {
  const network = opts.network ?? 'preprod';
  const policy = opts.policyId ?? 'a'.repeat(56);
  const operator = opts.operator ?? 'addr_test1_operator';
  const holders = new Map<string, string>();
  const refs = new Map<string, ReferenceState & { datum: unknown }>();
  const txs: MemoryChain['txs'] = [];
  let failures = 0;
  let failMessage = 'chain unavailable';
  let n = 0;

  const nextHash = (): string => createHash('sha256').update(`memtx:${++n}`).digest('hex');
  const maybeFail = () => {
    if (failures > 0) {
      failures--;
      throw new Error(failMessage);
    }
  };

  return {
    kind: 'memory',
    network,
    txs,
    async policyId() {
      return policy;
    },
    async operatorAddress() {
      return operator;
    },
    async mintCredential({ assetName, holder, fields, message }) {
      maybeFail();
      const ref = refUnit(policy, assetName);
      if (holders.has(ref)) throw new Error(`credential ${assetName} already minted`);
      const txHash = nextHash();
      holders.set(ref, operator);
      holders.set(userUnit(policy, assetName), holder);
      // Round-trip through the datum encoding so tests exercise it.
      refs.set(assetName, { fields: decodeCip68Datum(encodeCip68Datum(fields))!, datum: encodeCip68Datum(fields), address: operator, txHash, outputIndex: 0 });
      txs.push({ txHash, kind: 'mint', mints: [ref, userUnit(policy, assetName)], message });
      return { txHash };
    },
    async updateReference({ assetName, fields, message, receipt }) {
      maybeFail();
      if (!refs.has(assetName)) throw new Error(`reference NFT for ${assetName} not found`);
      const txHash = nextHash();
      const mints: string[] = [];
      if (receipt) {
        const unit = `${policy}${receipt.assetName}`;
        if (holders.has(unit)) throw new Error(`receipt ${receipt.assetName} already minted`);
        holders.set(unit, receipt.holder);
        mints.push(unit);
      }
      refs.set(assetName, { fields: decodeCip68Datum(encodeCip68Datum(fields))!, datum: encodeCip68Datum(fields), address: operator, txHash, outputIndex: 0 });
      txs.push({ txHash, kind: 'update', mints, message, ...(receipt ? { receiptMetadata: receipt.metadata } : {}) });
      return { txHash };
    },
    async readReference(assetName) {
      const r = refs.get(assetName);
      return r ? { fields: { ...r.fields }, address: r.address, txHash: r.txHash, outputIndex: r.outputIndex } : null;
    },
    async holderOf(unit) {
      return holders.get(unit) ?? null;
    },
    async awaitTx() {
      return true;
    },
    failNext(count, message) {
      failures = count;
      if (message) failMessage = message;
    },
    transfer(unit, to) {
      holders.set(unit, to);
    },
  };
}

export { receiptAssetName };
