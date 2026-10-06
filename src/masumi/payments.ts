// Client for the Masumi Payment Service (0.29.0 OpenAPI). Requests carry ISO-8601 times, responses carry
// epoch-ms strings; JobPayment uses epoch ms numbers.
import { z } from 'zod';
import type { Config } from '../config';
import type { JobPayment, Ms } from '../domain/types';

const MIN = 60_000;

export class MasumiPaymentError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const paymentsConfigured = (c: Config): boolean => Boolean(c.MASUMI_API_KEY && c.MASUMI_AGENT_IDENTIFIER);

export interface PaymentTimes {
  payByTime: Ms;
  submitResultTime: Ms;
  unlockTime: Ms;
  externalDisputeUnlockTime: Ms;
}

/** pay +30m, result +4h, unlock result+20m, dispute unlock +20m. The API needs result >= now+15m, pay <= result-5m, unlock >= result+15m, dispute >= unlock+15m. */
export function defaultTimes(now: Ms): PaymentTimes {
  const submitResultTime = now + 240 * MIN;
  const unlockTime = submitResultTime + 20 * MIN;
  return { payByTime: now + 30 * MIN, submitResultTime, unlockTime, externalDisputeUnlockTime: unlockTime + 20 * MIN };
}

export interface PaymentState {
  onChainState: string | null;
  nextAction: string;
  /** Funds are in the escrow contract: the buyer has paid. */
  fundsLocked: boolean;
  /** A result hash is recorded or on its way on chain. */
  resultSubmitted: boolean;
}

export interface PaymentClient {
  createPayment(input: { inputHash: string; identifierFromPurchaser: string }): Promise<JobPayment>;
  getPayment(blockchainIdentifier: string): Promise<PaymentState>;
  submitResult(blockchainIdentifier: string, submitResultHash: string): Promise<void>;
}

const msString = z.union([z.string(), z.number()]).transform((v) => Number(v));
const payment = z.looseObject({
  blockchainIdentifier: z.string(),
  payByTime: msString.nullish(),
  submitResultTime: msString.nullish(),
  unlockTime: msString.nullish(),
  externalDisputeUnlockTime: msString.nullish(),
  onChainState: z.string().nullish(),
  resultHash: z.string().nullish(),
  NextAction: z.looseObject({ requestedAction: z.string() }).nullish(),
  SmartContractWallet: z.looseObject({ walletVkey: z.string() }).nullish(),
});
const envelope = z.looseObject({ data: payment });

const agentEntry = z.looseObject({
  data: z.looseObject({
    supportedPaymentSources: z
      .array(z.looseObject({ chain: z.string().optional(), network: z.string().optional(), paymentSourceType: z.string().nullish() }))
      .nullish(),
  }),
});

type Fetch = typeof fetch;

export function createPaymentClient(config: Config, opts: { fetch?: Fetch; now?: () => Ms } = {}): PaymentClient {
  const base = config.MASUMI_API_URL.replace(/\/+$/, '');
  const now = opts.now ?? Date.now;
  const doFetch: Fetch = (...a) => (opts.fetch ?? globalThis.fetch)(...a);

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { token: config.MASUMI_API_KEY ?? '', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new MasumiPaymentError(`payment service unreachable: ${(err as Error).message}`);
    }
    const raw = await res.text();
    if (!res.ok) throw new MasumiPaymentError(`${method} ${path} -> ${res.status}: ${raw.slice(0, 300)}`, res.status);
    try {
      return JSON.parse(raw);
    } catch {
      throw new MasumiPaymentError(`${method} ${path}: response is not JSON`, res.status);
    }
  }

  // V2 payment sources need paymentSourceType and the index of our source in the agent's supportedPaymentSources.
  // Read from the registry entry once; on failure send neither (V1 behaviour) and try again next time.
  let source: Promise<{ paymentSourceType: string; supportedPaymentSourceIndex: number } | undefined> | undefined;
  const lookupSource = () =>
    (source ??= (async () => {
      try {
        const q = new URLSearchParams({ agentIdentifier: config.MASUMI_AGENT_IDENTIFIER ?? '', network: config.MASUMI_NETWORK });
        const r = agentEntry.parse(await call('GET', `/registry/agent-identifier?${q}`));
        const list = r.data.supportedPaymentSources ?? [];
        const i = list.findIndex((s) => s.chain === 'Cardano' && s.network === config.MASUMI_NETWORK);
        const t = i >= 0 ? list[i]?.paymentSourceType : undefined;
        return t === 'Web3CardanoV2' ? { paymentSourceType: t, supportedPaymentSourceIndex: i } : undefined;
      } catch (err) {
        source = undefined;
        console.error('[masumi] registry lookup failed, creating payment without source hints:', (err as Error).message);
        return undefined;
      }
    })());

  const toState = (p: z.infer<typeof payment>): PaymentState => {
    const nextAction = p.NextAction?.requestedAction ?? 'None';
    return {
      onChainState: p.onChainState ?? null,
      nextAction,
      fundsLocked: p.onChainState === 'FundsLocked',
      resultSubmitted:
        p.onChainState === 'ResultSubmitted' || Boolean(p.resultHash) || nextAction === 'SubmitResultRequested' || nextAction === 'SubmitResultInitiated',
    };
  };

  return {
    async createPayment({ inputHash, identifierFromPurchaser }) {
      const t = defaultTimes(now());
      const hints = await lookupSource();
      const iso = (ms: Ms) => new Date(ms).toISOString();
      const res = envelope.safeParse(
        await call('POST', '/payment', {
          inputHash,
          network: config.MASUMI_NETWORK,
          agentIdentifier: config.MASUMI_AGENT_IDENTIFIER,
          identifierFromPurchaser,
          payByTime: iso(t.payByTime),
          submitResultTime: iso(t.submitResultTime),
          unlockTime: iso(t.unlockTime),
          externalDisputeUnlockTime: iso(t.externalDisputeUnlockTime),
          ...hints,
        }),
      );
      if (!res.success) throw new MasumiPaymentError('POST /payment: unexpected response shape');
      const p = res.data.data;
      return {
        blockchainIdentifier: p.blockchainIdentifier,
        agentIdentifier: config.MASUMI_AGENT_IDENTIFIER ?? '',
        sellerVKey: config.MASUMI_SELLER_VKEY ?? p.SmartContractWallet?.walletVkey ?? '',
        identifierFromPurchaser,
        inputHash,
        payByTime: p.payByTime ?? t.payByTime,
        submitResultTime: p.submitResultTime ?? t.submitResultTime,
        unlockTime: p.unlockTime ?? t.unlockTime,
        externalDisputeUnlockTime: p.externalDisputeUnlockTime ?? t.externalDisputeUnlockTime,
      };
    },

    async getPayment(blockchainIdentifier) {
      const res = envelope.safeParse(
        await call('POST', '/payment/resolve-blockchain-identifier', { blockchainIdentifier, network: config.MASUMI_NETWORK }),
      );
      if (!res.success) throw new MasumiPaymentError('resolve-blockchain-identifier: unexpected response shape');
      return toState(res.data.data);
    },

    async submitResult(blockchainIdentifier, submitResultHash) {
      await call('POST', '/payment/submit-result', { network: config.MASUMI_NETWORK, blockchainIdentifier, submitResultHash });
    },
  };
}
