// Builds the Sokosumi worker from config. Off unless SOKOSUMI_COWORKER_ID and SOKOSUMI_COWORKER_API_KEY are set.
import { createIntake } from '../agent/intake';
import type { Config } from '../config';
import type { JobService, Store } from '../domain/ports';
import { createPaymentClient, paymentsConfigured } from '../masumi/payments';
import { createCoreClient } from './core';
import { createHaasRunner, createTaskBriefParser } from './haas';
import { createSokosumiWorker, type Worker } from './worker';

export function sokosumiWorkerFromConfig(deps: { config: Config; store: Store; jobs: JobService }): Worker | undefined {
  const { config, store, jobs } = deps;
  if (!config.SOKOSUMI_COWORKER_ID || !config.SOKOSUMI_COWORKER_API_KEY) return undefined;
  if (config.SOKOSUMI_PAID_TASKS && !paymentsConfigured(config)) {
    console.error('[sokosumi] SOKOSUMI_PAID_TASKS needs MASUMI_API_KEY and MASUMI_AGENT_IDENTIFIER; paid Tasks will fail');
  }
  return createSokosumiWorker({
    core: createCoreClient({ apiUrl: config.SOKOSUMI_API_URL, apiKey: config.SOKOSUMI_COWORKER_API_KEY }),
    store,
    config,
    payments: paymentsConfigured(config) ? createPaymentClient(config) : undefined,
    toBrief: createTaskBriefParser(createIntake({ config })),
    runHaas: createHaasRunner({ jobs, timeoutMs: config.SOKOSUMI_RUN_TIMEOUT_MIN * 60_000 }),
  });
}
