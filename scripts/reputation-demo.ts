// End-to-end reputation demo: a worker gets a credential, completes three verified, paid jobs, and
// each one updates the on-chain datum and mints a job receipt NFT. Then the router ranks that worker
// above an otherwise identical one, with the reason "on-chain verified, 3 jobs completed on HAAS".
//
//   pnpm identity:demo            in-memory chain, instant, no credentials
//   pnpm identity:demo --live     Cardano Preprod via Blockfrost (needs a funded CARDANO_MINT_MNEMONIC;
//                                  every update waits for a block, so expect a few minutes)
//   WORKER_ADDRESS=addr_test1…    where the user NFT and receipts go (default: the operator address)
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config';
import { createStore } from '../src/db/db';
import { createEventBus } from '../src/domain/events';
import type { Booking, Brief, FreelancerProfile, Job } from '../src/domain/types';
import { createMemoryChain } from '../src/identity/chain';
import { explorer } from '../src/identity/cip68';
import { createIdentity, identityConfigured } from '../src/identity';
import { workerView } from '../src/identity/registry';
import { rank } from '../src/router/match';

const live = process.argv.includes('--live');
const config = loadConfig();
if (live && !identityConfigured(config)) {
  console.error('--live needs BLOCKFROST_PROJECT_ID and CARDANO_MINT_MNEMONIC (see docs/IDENTITY.md)');
  process.exit(2);
}

const store = createStore(live ? config.DB_PATH : ':memory:');
const bus = createEventBus();
const identity = createIdentity({ store, bus, config: { ...config, IDENTITY_VERIFY_GRACE_MIN: 0 }, ...(live ? {} : { chain: createMemoryChain() }) })!;
const { registry, minter } = identity;
const ex = explorer(registry.network);
const run = Date.now().toString(36);
const workerId = `demo:${live ? run : 'ana'}`;

async function main() {
  const wallet = process.env.WORKER_ADDRESS ?? (await registry.chain.operatorAddress());
  console.log(`[demo] ${registry.chain.kind} chain on ${registry.network}; worker ${workerId} -> ${wallet}`);
  registry.bindWallet(workerId, wallet);
  const cred = await registry.issueCredential(workerId);
  console.log(`[demo] credential minted: ${ex.tx(cred.txHash)}`);

  minter.start();
  const jobs = [
    { task: 'Pick up a parcel in Marina Bay', price: 35, rating: 5 },
    { task: 'Photograph a storefront for a listing', price: 80, rating: 4.5 },
    { task: 'Attend a property viewing and report back', price: 60, rating: 5 },
  ];
  for (const [i, j] of jobs.entries()) {
    const id = `demo_${run}_${i + 1}`;
    const job: Job = { id: `job_${id}`, status: 'completed', client: 'masumi', brief: { task: j.task, skills: [], remoteOk: false }, round: 1, createdAt: Date.now(), updatedAt: Date.now() };
    const booking: Booking = { id: `bk_${id}`, jobId: job.id, profileId: workerId, platform: 'fake', source: 'demo', status: 'completed', priceUsd: j.price, paused: false, createdAt: Date.now(), updatedAt: Date.now() };
    store.insertJob(job);
    store.insertBooking(booking);
    // What the QA agent and the Masumi payment watcher would emit.
    bus.emit({ type: 'verification.completed', bookingId: booking.id, jobId: job.id, passed: true, resultHash: sha(`${j.task}:delivered`), rating: j.rating } as never);
    bus.emit({ type: 'payment.collected', jobId: job.id, txHash: sha(`collect:${id}`) } as never);
    bus.emit({ type: 'booking.updated', booking });
    await minter.tick();
    const t = minter.task(booking.id)!;
    console.log(`[demo] job ${i + 1} "${j.task}": ${t.status}${t.txHash ? ` ${ex.tx(t.txHash)}` : ''}${t.error ? ` (${t.error})` : ''}`);
  }
  minter.stop();

  await registry.refresh(workerId, 30_000);
  const view = workerView(registry, workerId);
  console.log('\n[demo] GET /workers/:id/reputation ->');
  console.log(JSON.stringify({ credential: view.credential, onChain: view.onChain, reputation: view.reputation, receipts: view.receipts.map((r) => ({ jobId: r.jobId, resultHash: r.resultHash, paymentTx: r.paymentTx, receiptUnit: r.receiptUnit, links: r.links })) }, null, 2));

  const brief: Brief = { task: 'Errand in Singapore', skills: ['errands'], remoteOk: true };
  const twin = (id: string): FreelancerProfile => ({ id, platform: 'fake', platformId: id, url: 'https://example.test', name: id, headline: 'Local helper', skills: ['errands'], pricing: [{ kind: 'fixed', amountUsd: 50, deliveryDays: 1 }], rating: 4.8, reviewCount: 40, fetchedAt: Date.now() });
  const ranked = rank(brief, [twin('demo:other'), twin(workerId)], new Map([[workerId, { score: 0.8, reason: 'Good fit' }], ['demo:other', { score: 0.8, reason: 'Good fit' }]]), { limit: 5, onchain: registry.signals([workerId, 'demo:other']) });
  console.log('\n[demo] ranking two otherwise identical workers:');
  for (const c of ranked) console.log(`  ${c.score.toFixed(1).padStart(5)}  ${c.profile.id}  ${c.reason}`);
  store.close();
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
