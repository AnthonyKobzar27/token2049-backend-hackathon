// An in-process HAAS with only the bounty board as a source: MIP-003 API, worker pages, the job
// and booking engines and an operator who approves everything. Used by scripts/demo-bounty.ts
// and the end-to-end test, so the demo story runs locally with no keys or chain.

import express from 'express';
import type { Server } from 'node:http';
import { createApprovalGate } from '../approvals/gate';
import { createPolicy } from '../approvals/policy';
import type { Config } from '../config';
import { createStore } from '../db/db';
import { createEventBus } from '../domain/events';
import { createBookingService } from '../engine/bookings';
import { createJobService } from '../engine/jobs';
import { mountMasumi } from '../masumi/api';
import { createEscrowProvider } from '../payments';
import { createRouter } from '../router/router';
import { createSuitabilityScorer } from '../router/suitability';
import { createRegistry } from '../sources/registry';
import type { WorkerPayout } from './board';
import { createBountyModule } from './index';
import type { WorkerInput } from './board';

export function createDemoStack(opts: { config: Config; workers: WorkerInput[]; log?: (line: string) => void; payout?: WorkerPayout; autoApprove?: boolean }) {
  const { config } = opts;
  const log = opts.log ?? ((l: string) => console.log(l));
  const store = createStore(config.DB_PATH);
  const bus = createEventBus();
  const bounty = createBountyModule({ store, bus, config, log, payout: opts.payout });
  for (const w of opts.workers) bounty.board.registerWorker(w);

  const registry = createRegistry({ sources: [bounty.source], store, bus, config });
  const suitability = createSuitabilityScorer({ store, config });
  const router = createRouter({ registry, suitability, bus, config });
  const policy = createPolicy({ store, config });
  const gate = createApprovalGate({ store, bus, policy, config });
  const escrow = createEscrowProvider({ store, config });
  const bookings = createBookingService({ store, bus, registry, escrow, gate, config });
  const jobs = createJobService({ store, bus, router, bookings, config });

  // The operator: approves every binding action (in production this is a tap in Telegram).
  const offApprove =
    opts.autoApprove === false
      ? () => {}
      : bus.on((e) => {
          if (e.type !== 'approval.requested') return;
          log(`[operator] approve: ${e.approval.summary}`);
          setTimeout(() => {
            try {
              if (store.getApproval(e.approval.id)?.status !== 'pending') return;
              gate.resolve(e.approval.id, { approved: true, by: 'demo-operator' });
            } catch (err) {
              console.error('[demo] approve failed:', err instanceof Error ? err.message : err);
            }
          }, 0);
        });

  // Bounty changes reach the booking at once instead of on the next poll (as in src/index.ts).
  let kick: ReturnType<typeof setTimeout> | undefined;
  const offKick = bus.on((e) => {
    if (e.type !== 'bounty.updated' || kick) return;
    kick = setTimeout(() => {
      kick = undefined;
      bookings.tick().catch((err) => console.error('[demo] booking refresh failed:', err));
    }, 20);
  });

  const app = express();
  bounty.mount(app);
  const masumi = mountMasumi(app, { jobs, store, bus, config });
  const timer = setInterval(() => {
    void bounty.tick();
    void bookings.tick();
    void jobs.tick();
  }, 2000);

  let server: Server | undefined;
  return {
    app,
    store,
    bus,
    jobs,
    bookings,
    gate,
    bounty,
    listen: (port: number) =>
      new Promise<string>((resolve, reject) => {
        // Express 5 reports a failed bind (e.g. EADDRINUSE: a dev server already on this port)
        // through the callback; ignoring it would leave every request going to that other server.
        const start = (p: number, mayRetry: boolean): void => {
          const s = app.listen(p, (err?: Error) => {
            const addr = s.address();
            if (err || addr === null) {
              if (!mayRetry) return reject(err ?? new Error(`could not listen on port ${p}`));
              console.error(`[demo] port ${p} is in use (another HAAS running?); using a free port instead`);
              return start(0, false);
            }
            server = s;
            resolve(`http://localhost:${typeof addr === 'object' ? addr.port : p}`);
          });
        };
        start(port, true);
      }),
    async close() {
      clearInterval(timer);
      if (kick) clearTimeout(kick);
      offApprove();
      offKick();
      bounty.stop();
      masumi.stop();
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      store.close();
    },
  };
}

export type DemoStack = ReturnType<typeof createDemoStack>;
