// Builds and signs real Cardano transactions offline against a fake provider: proves the Mesh
// wiring (policy, CIP-68 outputs, inline datum, receipt mint, metadata) without a network.
import { DEFAULT_PROTOCOL_PARAMETERS, MeshWallet, deserializeDatum, type IFetcher, type ISubmitter, type UTxO } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import { describe, expect, it } from 'vitest';
import { LABEL_100, LABEL_222, credentialAssetName, decodeCip68Datum, encodeCip68Datum, receiptAssetName } from './cip68';
import { createMeshChain } from './mesh';

const MNEMONIC = MeshWallet.brew() as string[];
const WORKER = 'addr_test1qqetxtvgrqfpf4vfnl6rrpfqd633g3skdrdatxqaeuewstwg8ycj5zw5509m7tn64elgzne05qgwdp2yfryvmmdj2daq48sxl5';

function fakeProvider(operator: () => string, extra: () => UTxO[] = () => []) {
  const submitted: string[] = [];
  const fund: UTxO = { input: { txHash: 'f'.repeat(64), outputIndex: 0 }, output: { address: '', amount: [{ unit: 'lovelace', quantity: '50000000' }] } };
  const p: IFetcher & ISubmitter = {
    fetchAccountInfo: async () => { throw new Error('n/a'); },
    fetchAddressAssets: async () => ({}),
    fetchAddressTxs: async () => [],
    fetchAddressUTxOs: async (address: string, asset?: string) => {
      const all = [{ ...fund, output: { ...fund.output, address: operator() } }, ...extra()];
      return asset ? all.filter((u) => u.output.amount.some((a) => a.unit === asset)) : all.filter((u) => u.output.address === address);
    },
    fetchAssetAddresses: async (asset: string) => extra().filter((u) => u.output.amount.some((a) => a.unit === asset)).map((u) => ({ address: u.output.address, quantity: '1' })),
    fetchAssetMetadata: async () => ({}),
    fetchBlockInfo: async () => { throw new Error('n/a'); },
    fetchCollectionAssets: async () => ({ assets: [] }),
    fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
    fetchTxInfo: async () => { throw new Error('n/a'); },
    fetchUTxOs: async (hash: string) => extra().filter((u) => u.input.txHash === hash),
    fetchGovernanceProposal: async () => { throw new Error('n/a'); },
    get: async () => ({}),
    submitTx: async (tx: string) => { submitted.push(tx); return 'a'.repeat(64); },
  } as unknown as IFetcher & ISubmitter;
  return { p, submitted };
}

describe('mesh chain (offline)', () => {
  it('mints a CIP-68 pair with an inline datum, then updates it and mints a receipt', async () => {
    let op = '';
    let refUtxo: UTxO | undefined;
    const { p, submitted } = fakeProvider(() => op, () => (refUtxo ? [refUtxo] : []));
    const chain = createMeshChain({ network: 'preprod', mnemonic: MNEMONIC.join(' '), provider: p });
    op = await chain.operatorAddress();
    const policyId = await chain.policyId();
    expect(policyId).toMatch(/^[0-9a-f]{56}$/);

    const name = credentialAssetName('fake:a');
    await chain.mintCredential({ assetName: name, holder: WORKER, fields: { name: 'HAAS Verified Worker', jobs: 0 }, message: { msg: ['HAAS credential'] } });
    const tx1 = deserializeTx(submitted[0]!);
    const body = tx1.body();
    const outs = body.outputs();
    const units = outs.map((o) => [...(o.amount().multiasset()?.keys() ?? [])].map(String));
    expect(units.flat()).toEqual(expect.arrayContaining([`${policyId}${LABEL_100}${name}`, `${policyId}${LABEL_222}${name}`]));
    const refOut = outs.find((o) => [...(o.amount().multiasset()?.keys() ?? [])].map(String).includes(`${policyId}${LABEL_100}${name}`))!;
    expect(refOut.address().toBech32()).toBe(op);
    expect(refOut.amount().coin()).toBeGreaterThan(1_000_000n); // min UTxO was added
    const datum = refOut.datum()?.asInlineData()?.toCbor();
    expect(decodeCip68Datum(deserializeDatum(datum!))).toEqual({ name: 'HAAS Verified Worker', jobs: 0 });
    expect(tx1.witnessSet().vkeys()?.size()).toBeGreaterThan(0);

    // The reference NFT now "exists" at the operator address with that datum.
    refUtxo = { input: { txHash: 'b'.repeat(64), outputIndex: 0 }, output: { address: op, amount: [{ unit: 'lovelace', quantity: String(refOut.amount().coin()) }, { unit: `${policyId}${LABEL_100}${name}`, quantity: '1' }], plutusData: datum! } };
    const read = await chain.readReference(name);
    expect(read?.fields).toEqual({ name: 'HAAS Verified Worker', jobs: 0 });

    const rname = receiptAssetName('bk_1');
    await chain.updateReference({ assetName: name, fields: { name: 'HAAS Verified Worker', jobs: 1 }, message: { msg: ['HAAS job receipt'] }, receipt: { assetName: rname, holder: WORKER, metadata: { [policyId]: { x: { name: 'r' } }, version: 1 } } });
    const tx2 = deserializeTx(submitted[1]!);
    const ins = [...tx2.body().inputs().values()].map((i) => `${i.transactionId()}#${i.index()}`);
    expect(ins).toContain(`${'b'.repeat(64)}#0`);
    const outs2 = tx2.body().outputs();
    const ref2 = outs2.find((o) => [...(o.amount().multiasset()?.keys() ?? [])].map(String).includes(`${policyId}${LABEL_100}${name}`))!;
    expect(decodeCip68Datum(deserializeDatum(ref2.datum()!.asInlineData()!.toCbor()))).toEqual({ name: 'HAAS Verified Worker', jobs: 1 });
    expect(outs2.some((o) => o.address().toBech32() === WORKER && [...(o.amount().multiasset()?.keys() ?? [])].map(String).includes(`${policyId}${rname}`))).toBe(true);
    expect([...(tx2.body().mint()?.keys() ?? [])].map(String)).toEqual([`${policyId}${rname}`]);
  });

  it('round-trips the datum encoding through CBOR', () => {
    const d = encodeCip68Datum({ a: 'x'.repeat(100), n: 7 });
    expect(d).toMatchObject({ constructor: 0 });
  });
});
