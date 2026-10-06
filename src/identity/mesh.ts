// Live ReputationChain on Cardano with Mesh SDK and Blockfrost.
//
// Policy: a native script the operator key must sign, optionally time-locked (`before` a slot).
// The (100) reference NFT stays at the operator's address with an inline datum, so the operator can
// update it after each job by spending and re-locking it. The (222) user NFT goes to the worker.
// See docs/IDENTITY.md for why this is "soulbound by verification" rather than a script lock.

import {
  BlockfrostProvider,
  ForgeScript,
  MeshTxBuilder,
  MeshWallet,
  deserializeAddress,
  deserializeDatum,
  resolveScriptHash,
  type IFetcher,
  type ISubmitter,
  type NativeScript,
  type UTxO,
} from '@meshsdk/core';
import type { ReferenceState, ReputationChain } from './chain';
import { LABEL_100, LABEL_222, decodeCip68Datum, encodeCip68Datum } from './cip68';
import type { CardanoNetwork } from './types';

export interface MeshChainOptions {
  network: CardanoNetwork;
  mnemonic: string;
  /** Blockfrost project id for the network; ignored when `provider` is given. */
  blockfrostProjectId?: string;
  /** Injected provider (tests, or another backend such as Koios/Maestro). */
  provider?: IFetcher & ISubmitter;
  /** Optional time lock: no minting at or after this absolute slot. */
  policyLockSlot?: number;
  /** Poll interval for confirmations. */
  pollMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMeshChain(opts: MeshChainOptions): ReputationChain & { wallet: MeshWallet; nativeScript(): Promise<NativeScript> } {
  const networkId = opts.network === 'mainnet' ? 1 : 0;
  const provider: IFetcher & ISubmitter = opts.provider ?? new BlockfrostProvider(required(opts.blockfrostProjectId, 'BLOCKFROST_PROJECT_ID'));
  const words = opts.mnemonic.trim().split(/\s+/);
  const wallet = new MeshWallet({ networkId, fetcher: provider, submitter: provider, key: { type: 'mnemonic', words } });

  let setup: Promise<{ address: string; script: NativeScript; forging: string; policyId: string }> | undefined;
  const ready = () =>
    (setup ??= (async () => {
      await wallet.init();
      const address = await wallet.getChangeAddress();
      const { pubKeyHash } = deserializeAddress(address);
      const sig: NativeScript = { type: 'sig', keyHash: pubKeyHash };
      const script: NativeScript = opts.policyLockSlot !== undefined ? { type: 'all', scripts: [sig, { type: 'before', slot: String(opts.policyLockSlot) }] } : sig;
      const forging = ForgeScript.fromNativeScript(script);
      return { address, script, forging, policyId: resolveScriptHash(forging) };
    })());

  /** Operator UTxOs that hold none of our policy's tokens, so coin selection never moves a reference NFT. */
  async function spendable(policyId: string): Promise<UTxO[]> {
    const { address } = await ready();
    const utxos = await provider.fetchAddressUTxOs(address);
    return utxos.filter((u) => !u.output.amount.some((a) => a.unit.startsWith(policyId)));
  }

  function builder(): MeshTxBuilder {
    const tx = new MeshTxBuilder({ fetcher: provider, submitter: provider, verbose: false });
    tx.setNetwork(opts.network);
    return tx;
  }

  async function finish(tx: MeshTxBuilder, policyId: string): Promise<string> {
    const { address } = await ready();
    const inputs = await spendable(policyId);
    if (inputs.length === 0) throw new Error(`operator wallet ${address} has no spendable UTxOs; fund it from the preprod faucet`);
    if (opts.policyLockSlot !== undefined) tx.invalidHereafter(opts.policyLockSlot - 1);
    tx.changeAddress(address).selectUtxosFrom(inputs);
    const unsigned = await tx.complete();
    const signed = await wallet.signTx(unsigned);
    return provider.submitTx(signed);
  }

  async function findRef(policyId: string, assetName: string): Promise<UTxO | null> {
    const unit = `${policyId}${LABEL_100}${assetName}`;
    const holder = await holderOf(unit);
    if (!holder) return null;
    const utxos = await provider.fetchAddressUTxOs(holder, unit);
    return utxos.find((u) => u.output.amount.some((a) => a.unit === unit)) ?? null;
  }

  async function holderOf(unit: string): Promise<string | null> {
    try {
      const rows = await provider.fetchAssetAddresses(unit);
      if (!rows.length) return null;
      return [...rows].sort((a, b) => Number(b.quantity) - Number(a.quantity))[0]!.address;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  return {
    kind: 'mesh',
    network: opts.network,
    wallet,
    async nativeScript() {
      return (await ready()).script;
    },
    async policyId() {
      return (await ready()).policyId;
    },
    async operatorAddress() {
      return (await ready()).address;
    },

    async mintCredential({ assetName, holder, fields, message }) {
      const { address, forging, policyId } = await ready();
      const ref = `${LABEL_100}${assetName}`;
      const user = `${LABEL_222}${assetName}`;
      const tx = builder()
        .mint('1', policyId, ref)
        .mintingScript(forging)
        .mint('1', policyId, user)
        .mintingScript(forging)
        .txOut(address, [{ unit: policyId + ref, quantity: '1' }])
        .txOutInlineDatumValue(encodeCip68Datum(fields) as never, 'JSON')
        .txOut(holder, [{ unit: policyId + user, quantity: '1' }])
        .metadataValue(674, message);
      return { txHash: await finish(tx, policyId) };
    },

    async updateReference({ assetName, fields, message, receipt }) {
      const { address, forging, policyId } = await ready();
      const refUtxo = await findRef(policyId, assetName);
      if (!refUtxo) throw new Error(`reference NFT ${policyId}${LABEL_100}${assetName} not found on chain`);
      const tx = builder()
        .txIn(refUtxo.input.txHash, refUtxo.input.outputIndex, refUtxo.output.amount, refUtxo.output.address)
        .txOut(address, refUtxo.output.amount.filter((a) => a.unit !== 'lovelace'))
        .txOutInlineDatumValue(encodeCip68Datum(fields) as never, 'JSON')
        .metadataValue(674, message);
      if (receipt) {
        tx.mint('1', policyId, receipt.assetName).mintingScript(forging).txOut(receipt.holder, [{ unit: policyId + receipt.assetName, quantity: '1' }]).metadataValue(721, receipt.metadata);
      }
      return { txHash: await finish(tx, policyId) };
    },

    async readReference(assetName) {
      const { policyId } = await ready();
      const u = await findRef(policyId, assetName);
      if (!u?.output.plutusData) return null;
      const fields = decodeCip68Datum(deserializeDatum(u.output.plutusData));
      return fields ? ({ fields, address: u.output.address, txHash: u.input.txHash, outputIndex: u.input.outputIndex } satisfies ReferenceState) : null;
    },

    holderOf,

    async awaitTx(txHash, timeoutMs) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        try {
          await provider.fetchTxInfo(txHash);
          return true;
        } catch {
          await sleep(opts.pollMs ?? 5_000);
        }
      }
      return false;
    },
  };
}

function required(v: string | undefined, name: string): string {
  if (!v) throw new Error(`Set ${name} to use the Cardano identity chain`);
  return v;
}

function isNotFound(err: unknown): boolean {
  const s = typeof err === 'string' ? err : JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}));
  return /404|not.?found/i.test(s);
}
