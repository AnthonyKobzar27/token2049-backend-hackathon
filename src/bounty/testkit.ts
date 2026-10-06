// Shared fixtures for bounty tests (not a test file itself).

import { testConfig } from '../config';
import { createStore } from '../db/db';
import { createEventBus } from '../domain/events';
import type { BountyEvent, HaasEvent } from '../domain/types';
import { createBountyBoard, type WorkerInput } from './board';
import { createConsoleNotifier } from './notifier';
import { rulesSpec } from './spec';

export const SG_WORKERS: WorkerInput[] = [
  { id: 'w_ana', name: 'Ana', contact: {}, wallets: { solana: 'SoLAna111' }, location: { lat: 1.2771, lng: 103.8452, city: 'Singapore', area: 'Tanjong Pagar', country: 'SG' }, skills: ['phone calls'], verified: true, rating: 4.9 },
  { id: 'w_ben', name: 'Ben', contact: {}, wallets: { cardano: 'addr_test1ben' }, location: { lat: 1.3009, lng: 103.8559, city: 'Singapore', area: 'Bugis', country: 'SG' }, skills: ['errands'], verified: true },
  { id: 'w_cat', name: 'Cat', contact: {}, wallets: {}, location: { lat: 1.4360, lng: 103.7865, city: 'Singapore', area: 'Woodlands', country: 'SG' }, skills: ['errands'], verified: true },
  { id: 'w_dan', name: 'Dan', contact: {}, wallets: {}, location: { lat: 1.28, lng: 103.84, city: 'Singapore', country: 'SG' }, skills: [], verified: false },
];

export const PHYSIO = { task: 'Call Tanjong Pagar Polyclinic and book the earliest physio slot this week', skills: [], remoteOk: true, location: 'Singapore' };

export function setupBoard(over: Parameters<typeof testConfig>[0] = {}) {
  let t = 1_000_000;
  const store = createStore(':memory:');
  const bus = createEventBus();
  const events: BountyEvent[] = [];
  bus.on((e: HaasEvent) => {
    if (e.type === 'bounty.updated') events.push(e.bounty);
  });
  const notifier = createConsoleNotifier(() => {});
  const paid: string[] = [];
  const board = createBountyBoard({
    store,
    bus,
    config: testConfig({ PUBLIC_URL: 'https://haas.test', ...over }),
    notifier,
    now: () => t,
    payout: { pay: async (w, b) => (paid.push(`${w.id}:${b.id}`), { chain: 'solana', address: w.wallets.solana, ref: 'tx1' }) },
  });
  for (const w of SG_WORKERS) board.registerWorker(w);
  const post = (extra: Partial<Parameters<typeof board.post>[0]> = {}) =>
    board.post({ task: PHYSIO.task, spec: rulesSpec(PHYSIO), reward: { amount: 3, currency: 'SGD' }, rewardUsd: 2.22, ...extra });
  return { store, bus, board, events, notifier, paid, post, advance: (ms: number) => (t += ms), now: () => t };
}

