// Demo worker pool: the team, placed around Singapore. Contact details and wallets come from
// the environment so nothing personal lives in the repository:
//   WORKER_<ID>_TELEGRAM   Telegram chat id (or link later with /link <code>)
//   WORKER_<ID>_CARDANO    Cardano address for payouts
//   WORKER_<ID>_SOLANA     Solana address for payouts
// <ID> is the upper-case worker id without the "w_" prefix, e.g. WORKER_NITHYA_TELEGRAM.

import type { WorkerInput } from './board';

const DEMO_SOLANA = 'DemoSo1anaWa11et1111111111111111111111111111';
const DEMO_CARDANO = 'addr_test1_demo_wallet';

export const TEAM: WorkerInput[] = [
  {
    id: 'w_nithya',
    name: 'Nithya',
    contact: {},
    wallets: { solana: DEMO_SOLANA, cardano: DEMO_CARDANO },
    location: { lat: 1.2764, lng: 103.8458, city: 'Singapore', area: 'Tanjong Pagar', country: 'SG' },
    skills: ['phone calls', 'bookings', 'errands'],
    rating: 4.9,
    verified: true,
    languages: ['en'],
  },
  {
    id: 'w_oliver',
    name: 'Oliver',
    contact: {},
    wallets: { cardano: DEMO_CARDANO },
    location: { lat: 1.284, lng: 103.8515, city: 'Singapore', area: 'Raffles Place', country: 'SG' },
    skills: ['phone calls', 'errands', 'photos'],
    rating: 4.8,
    verified: true,
    languages: ['en', 'de'],
  },
  {
    id: 'w_sam',
    name: 'Sam',
    contact: {},
    wallets: { solana: DEMO_SOLANA },
    location: { lat: 1.3009, lng: 103.8559, city: 'Singapore', area: 'Bugis', country: 'SG' },
    skills: ['errands', 'deliveries', 'queueing'],
    rating: 4.7,
    verified: true,
    languages: ['en', 'zh'],
  },
  {
    id: 'w_priya',
    name: 'Priya',
    contact: {},
    wallets: {},
    location: { lat: 1.436, lng: 103.7865, city: 'Singapore', area: 'Woodlands', country: 'SG' },
    skills: ['photos', 'errands'],
    rating: 4.6,
    // Not yet checked by the operator: never offered a bounty.
    verified: false,
    languages: ['en', 'ta'],
  },
];

/** TEAM with contact details and wallets filled in from the environment. */
export function teamFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerInput[] {
  return TEAM.map((w) => {
    const key = w.id.replace(/^w_/, '').toUpperCase();
    const tg = env[`WORKER_${key}_TELEGRAM`];
    const cardano = env[`WORKER_${key}_CARDANO`];
    const solana = env[`WORKER_${key}_SOLANA`];
    return {
      ...w,
      contact: { ...w.contact, ...(tg && { telegramId: tg }) },
      wallets: { ...w.wallets, ...(cardano && { cardano }), ...(solana && { solana }) },
    };
  });
}
