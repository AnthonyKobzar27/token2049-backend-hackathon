// Wires the bounty board: board + source + worker notifiers + web pages + Telegram commands.

import type { Express } from 'express';
import type { Config } from '../config';
import type { EventBus, FreelancerSource, Store } from '../domain/ports';
import type { Brief } from '../domain/types';
import { createBountySource, watchBountyBookings } from '../sources/bounty';
import { createBountyBoard, type BountyBoard, type WorkerPayout } from './board';
import { createCompositeNotifier, createConsoleNotifier, createTelegramWorkerNotifier, type WorkerNotifier } from './notifier';
import { checkSubmission } from './qa';
import { workerTelegramExtension } from './telegram';
import type { Bounty, BountySpec, QaVerdict } from './types';
import { mountWorkerPages } from './web';

export interface BountyModule {
  board: BountyBoard;
  source: FreelancerSource;
  /** Register with registerTelegramExtension() to add the worker commands to the bot. */
  telegram: ReturnType<typeof workerTelegramExtension>;
  /** Mounts /w/:token and /bounty/* on the express app. */
  mount(app: Express): void;
  /**
   * Hands bounties that passed the check to the booking service for acceptance (which asks the
   * 'accept' approval, then pays the worker and releases escrow). Call once the service exists.
   */
  attach(deps: { accept(bookingId: string): Promise<unknown> }): void;
  /** Checks a submitted bounty now: verified, sent back for a revision, or rejected. */
  review(bountyId: string): Promise<void>;
  /** Resolves when every check and acceptance started so far has finished. For tests and scripts. */
  idle(): Promise<void>;
  /** Expires overdue bounties. For the poller. */
  tick(): Promise<void>;
  stop(): void;
}

/** Submissions sent back this many times are rejected on the next failed check. */
export const MAX_REVISIONS = 2;

export function createBountyModule(deps: {
  store: Store;
  bus: EventBus;
  config: Config;
  /** Extra channels, e.g. an iMessage notifier. Console and Telegram are always included. */
  notifiers?: WorkerNotifier[];
  payout?: WorkerPayout;
  spec?: (brief: Brief) => Promise<BountySpec>;
  /** Injectable for tests; defaults to rules plus a model read when a key is set. */
  qa?: (bounty: Bounty) => Promise<QaVerdict>;
  log?: (line: string) => void;
}): BountyModule {
  const { store, bus, config } = deps;
  const tg = createTelegramWorkerNotifier();
  const notifier = createCompositeNotifier([createConsoleNotifier(deps.log), tg, ...(deps.notifiers ?? [])]);
  const board = createBountyBoard({ store, bus, config, notifier, payout: deps.payout });
  const source = createBountySource({ board, store, config, spec: deps.spec });
  const unwatch = watchBountyBookings({ bus, board });
  const qa = deps.qa ?? ((b) => checkSubmission(b, config));
  const log = deps.log ?? ((l: string) => console.log(l));
  const inflight = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    const q = p.catch((err) => console.error('[bounty]', err instanceof Error ? err.message : err)).finally(() => inflight.delete(q));
    inflight.add(q);
  };
  let accept: ((bookingId: string) => Promise<unknown>) | undefined;
  const accepting = new Set<string>();

  const reviewing = new Set<string>();

  async function review(bountyId: string): Promise<void> {
    const b = board.get(bountyId);
    if (!b || b.status !== 'submitted' || reviewing.has(bountyId)) return;
    reviewing.add(bountyId);
    try {
      decide(b, await qa(b));
    } finally {
      reviewing.delete(bountyId);
    }
  }

  function decide(b: Bounty, verdict: QaVerdict): void {
    const bountyId = b.id;
    if (verdict.ok) {
      const res = board.verify(bountyId, verdict);
      if (res.ok) log(`[bounty] ${b.code} passed the check (${verdict.by}): ${res.bounty.result?.summary}`);
      return;
    }
    const feedback = verdict.issues.join(' ');
    const rejected = (b.revisions ?? 0) >= MAX_REVISIONS;
    if (rejected) board.reject(bountyId, `failed the check: ${feedback}`, verdict);
    else board.requestRevision(bountyId, feedback, verdict);
    log(`[bounty] ${b.code} ${rejected ? 'rejected' : 'sent back'} (${verdict.by}): ${feedback}`);
  }

  const offBus = bus.on((e) => {
    if (e.type === 'bounty.updated' && e.bounty.status === 'submitted') track(review(e.bounty.bountyId));
    if (e.type === 'booking.updated' && e.booking.platform === 'bounty' && e.booking.status === 'delivered' && accept && !accepting.has(e.booking.id)) {
      const id = e.booking.id;
      const run = accept;
      accepting.add(id);
      track(run(id).finally(() => accepting.delete(id)));
    }
  });

  return {
    board,
    source,
    telegram: workerTelegramExtension(board, (send) => tg.bind(send)),
    mount: (app) => mountWorkerPages(app, { board }),
    attach: (d) => {
      accept = d.accept;
    },
    review,
    idle: async () => {
      while (inflight.size) await Promise.all([...inflight]);
    },
    tick: async () => {
      board.tick();
      // Submissions whose check was lost (e.g. a restart) are checked again.
      for (const b of board.list({ status: ['submitted'] })) track(review(b.id));
    },
    stop: () => {
      unwatch();
      offBus();
    },
  };
}
