// Issues a "HAAS Verified Worker" credential (CIP-68 reference + user NFT) on Cardano Preprod.
//
//   pnpm identity:wallet                         new operator mnemonic + address to fund
//   pnpm identity:mint <workerId> <addr_test1…>  bind the wallet and mint the credential
//   pnpm identity:mint <workerId> <addr> --memory  same, against the in-memory chain (no network)
//
// Needs BLOCKFROST_PROJECT_ID (preprod project at blockfrost.io) and CARDANO_MINT_MNEMONIC, with the
// operator address funded from https://dispenser.masumi.network or the Cardano testnet faucet.
// State goes to DB_PATH, so a running HAAS server serves it at GET /workers/:id/reputation.
import { MeshWallet } from '@meshsdk/core';
import { loadConfig } from '../src/config';
import { createStore } from '../src/db/db';
import { createEventBus } from '../src/domain/events';
import { createMemoryChain } from '../src/identity/chain';
import { explorer } from '../src/identity/cip68';
import { createIdentity, identityConfigured } from '../src/identity';
import { workerView } from '../src/identity/registry';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [workerId, address] = args.filter((a) => !a.startsWith('--'));

async function newWallet() {
  const words = MeshWallet.brew() as string[];
  const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words } });
  await wallet.init();
  const addr = await wallet.getChangeAddress();
  console.log(`CARDANO_MINT_MNEMONIC="${words.join(' ')}"`);
  console.log(`# operator address (preprod): ${addr}`);
  console.log('# fund it with test ADA: https://dispenser.masumi.network  or  https://docs.cardano.org/cardano-testnets/tools/faucet');
}

async function main() {
  if (flags.has('--new-wallet')) return newWallet();
  if (!workerId || !address) {
    console.error('usage: pnpm identity:mint <workerId> <worker address> [--memory]\n       pnpm identity:wallet');
    process.exit(2);
  }
  const config = loadConfig();
  const memory = flags.has('--memory');
  if (!memory && !identityConfigured(config)) {
    console.error('Set BLOCKFROST_PROJECT_ID and CARDANO_MINT_MNEMONIC in ~/.haas/.env (or pass --memory). Run `pnpm identity:wallet` for a new operator wallet.');
    process.exit(2);
  }
  const store = createStore(memory ? ':memory:' : config.DB_PATH);
  const identity = createIdentity({ store, bus: createEventBus(), config, ...(memory ? { chain: createMemoryChain() } : {}) })!;
  const { registry } = identity;
  const ex = explorer(registry.network);
  const operator = await registry.chain.operatorAddress();
  console.log(`network ${registry.network}, chain ${registry.chain.kind}`);
  console.log(`operator ${operator}\n  ${ex.address(operator)}`);
  console.log(`policy   ${await registry.chain.policyId()}`);

  console.log(`\nissuing credential for ${workerId} -> ${address} (waits for confirmation, up to 4 min)…`);
  const cred = await registry.issueCredential(workerId, address);
  console.log(`tx       ${cred.txHash}\n  ${ex.tx(cred.txHash)}`);
  console.log(`ref NFT  ${cred.refUnit}\n  ${ex.token(cred.refUnit)}`);
  console.log(`user NFT ${cred.userUnit}\n  ${ex.token(cred.userUnit)}`);

  await registry.refresh(workerId, 30_000);
  console.log('\n' + JSON.stringify(workerView(registry, workerId), null, 2));
  store.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
