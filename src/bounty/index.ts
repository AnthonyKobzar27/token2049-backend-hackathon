// Wires the bounty board: board + source + worker notifiers + web pages + Telegram commands.

import type { Express } from 'express';
import type { Config } from '../config';
import type { EventBus, FreelancerSource, Store } from '../domain/ports';
import type { Brief } from '../domain/types';
import { createBountySource, watchBountyBookings } from '../sources/bounty';
import { createBountyBoard, type BountyBoard, type WorkerPayout } from './board';
import { createCompositeNotifier, createConsoleNotifier, createTelegramWorkerNotifier, type WorkerNotifier } from './notifier';
import { workerTelegramExtension } from './telegram';
import type { BountySpec } from './types';
import { mountWorkerPages } from './web';

export interface BountyModule {
  board: BountyBoard;
  source: FreelancerSource;
  /** Register with registerTelegramExtension() to add the worker commands to the bot. */
  telegram: ReturnType<typeof workerTelegramExtension>;
  /** Mounts /w/:token and /bounty/* on the express app. */
  mount(app: Express): void;
  /** Expires overdue bounties. For the poller. */
  tick(): Promise<void>;
  stop(): void;
}

export function createBountyModule(deps: {
  store: Store;
  bus: EventBus;
  config: Config;
  /** Extra channels, e.g. an iMessage notifier. Console and Telegram are always included. */
  notifiers?: WorkerNotifier[];
  payout?: WorkerPayout;
  spec?: (brief: Brief) => Promise<BountySpec>;
  log?: (line: string) => void;
}): BountyModule {
  const { store, bus, config } = deps;
  const tg = createTelegramWorkerNotifier();
  const notifier = createCompositeNotifier([createConsoleNotifier(deps.log), tg, ...(deps.notifiers ?? [])]);
  const board = createBountyBoard({ store, bus, config, notifier, payout: deps.payout });
  const source = createBountySource({ board, store, config, spec: deps.spec });
  const unwatch = watchBountyBookings({ bus, board });
  return {
    board,
    source,
    telegram: workerTelegramExtension(board, (send) => tg.bind(send)),
    mount: (app) => mountWorkerPages(app, { board }),
    tick: async () => {
      board.tick();
    },
    stop: unwatch,
  };
}
