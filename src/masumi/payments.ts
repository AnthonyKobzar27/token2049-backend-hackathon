// Client for the Masumi Payment Service (0.29.0 / main OpenAPI). Requests carry ISO-8601 times, responses carry
// epoch-ms strings; JobPayment uses epoch ms numbers.
// Dynamic pricing (the TOKEN2049 default): every POST /payment carries RequestedFunds; the registry entry only
// says {"pricingType":"Dynamic"}. Collection: with AUTO_WITHDRAW_PAYMENTS=true (the service default) the payment
// service withdraws the escrow to the seller by itself after unlockTime; it has no seller "collect" endpoint.
// We watch for onChainState Withdrawn and record the confirmed withdrawal transaction.
import { z } from 'zod';
import type { Config } from '../config';
import type { JobPayment, Ms } from '../domain/types';
import { normalizeUnit, type Amount } from './pricing';

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

export interface Windows {
  payMin: number;
  resultMin: number;
  unlockDelayMin: number;
  disputeDelayMin: number;
}

export const windowsFromConfig = (
  c: Pick<Config, 'MASUMI_PAY_WINDOW_MIN' | 'MASUMI_RESULT_WINDOW_MIN' | 'MASUMI_UNLOCK_DELAY_MIN' | 'MASUMI_DISPUTE_DELAY_MIN'>,
): Windows => ({
  payMin: c.MASUMI_PAY_WINDOW_MIN,
  resultMin: c.MASUMI_RESULT_WINDOW_MIN,
  unlockDelayMin: c.MASUMI_UNLOCK_DELAY_MIN,
  disputeDelayMin: c.MASUMI_DISPUTE_DELAY_MIN,
});

export const DEFAULT_WINDOWS: Windows = { payMin: 20, resultMin: 60, unlockDelayMin: 16, disputeDelayMin: 16 };

/**
 * Deadlines for a new payment, clamped to what the payment service accepts (result >= now+15m, pay <= result-5m,
 * unlock >= result+15m, dispute >= unlock+15m). The result window has to cover routing, the human check-in (the
 * clock does not pause during awaiting_input) and the booking: 60 minutes by default (MASUMI_RESULT_WINDOW_MIN).
 */
export function defaultTimes(now: Ms, w: Windows = DEFAULT_WINDOWS): PaymentTimes {
  const submitResultTime = now + Math.max(w.resultMin, 20) * MIN;
  const payByTime = Math.min(now + Math.max(w.payMin, 5) * MIN, submitResultTime - 5 * MIN);
  const unlockTime = submitResultTime + Math.max(w.unlockDelayMin, 16) * MIN;
  return { payByTime, submitResultTime, unlockTime, externalDisputeUnlockTime: unlockTime + Math.max(w.disputeDelayMin, 16) * MIN };
}

export interface PaymentState {
  onChainState: string | null;
  nextAction: string;
  /** Funds are in the escrow contract: the buyer has paid. */
  fundsLocked: boolean;
  /** A result hash is recorded or on its way on chain. */
  resultSubmitted: boolean;
  resultHash: string | null;
  /** The escrow was paid out to the seller (Withdrawn or DisputedWithdrawn). */
  withdrawn: boolean;
  /** Confirmed withdrawal transaction, when known. */
  collectionTxHash: string | null;
  errorType: string | null;
}

export interface CreatePaymentInput {
  inputHash: string;
  identifierFromPurchaser: string;
  /** Required for Dynamic pricing, ignored for Fixed. */
  amounts?: Amount[];
  metadata?: string;
  /** Deadlines for this payment; default: the MASUMI_* windows. */
  windows?: Windows;
}

export interface PaymentClient {
  createPayment(input: CreatePaymentInput): Promise<JobPayment>;
  getPayment(blockchainIdentifier: string): Promise<PaymentState>;
  submitResult(blockchainIdentifier: string, submitResultHash: string): Promise<void>;
}

const msString = z.union([z.string(), z.number()]).transform((v) => Number(v));
const tx = z.looseObject({
  txHash: z.string().nullish(),
  status: z.string().nullish(),
  newOnChainState: z.string().nullish(),
});
const payment = z.looseObject({
  blockchainIdentifier: z.string(),
  payByTime: msString.nullish(),
  submitResultTime: msString.nullish(),
  unlockTime: msString.nullish(),
  externalDisputeUnlockTime: msString.nullish(),
  onChainState: z.string().nullish(),
  resultHash: z.string().nullish(),
  NextAction: z.looseObject({ requestedAction: z.string(), errorType: z.string().nullish(), resultHash: z.string().nullish() }).nullish(),
  SmartContractWallet: z.looseObject({ walletVkey: z.string() }).nullish(),
  PaymentSource: z.looseObject({ paymentSourceType: z.string().nullish(), smartContractAddress: z.string().nullish() }).nullish(),
  RequestedFunds: z.array(z.looseObject({ amount: z.string(), unit: z.string() })).nullish(),
  CurrentTransaction: tx.nullish(),
  TransactionHistory: z.array(tx).nullish(),
});
type PaymentDto = z.infer<typeof payment>;
const envelope = z.looseObject({ data: payment });

const agentEntry = z.looseObject({
  data: z.looseObject({
    supportedPaymentSources: z
      .array(
        z.looseObject({
          chain: z.string().optional(),
          network: z.string().optional(),
          paymentSourceType: z.string().nullish(),
          pricing: z.looseObject({ pricingType: z.string() }).nullish(),
        }),
      )
      .nullish(),
  }),
});

const WITHDRAWN = new Set(['Withdrawn', 'DisputedWithdrawn']);

/** The confirmed transaction that moved the escrow to the seller, from the current one or the history. */
export function collectionTx(p: PaymentDto): string | null {
  if (!p.onChainState || !WITHDRAWN.has(p.onChainState)) return null;
  const all = [p.CurrentTransaction, ...(p.TransactionHistory ?? [])].filter((t): t is NonNullable<typeof t> => Boolean(t));
  const hit = all.find((t) => t.status === 'Confirmed' && t.newOnChainState && WITHDRAWN.has(t.newOnChainState) && t.txHash);
  return hit?.txHash ?? null;
}

type Fetch = typeof fetch;
type Hints = { paymentSourceType?: string; supportedPaymentSourceIndex?: number; pricingType?: string };

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

  // V2 payment sources need paymentSourceType and the index of our source in the agent's supportedPaymentSources;
  // that source's pricing decides whether RequestedFunds is sent. Read from the registry entry once; on failure
  // fall back to the config and try again next time.
  let source: Promise<Hints | undefined> | undefined;
  const lookupSource = () =>
    (source ??= (async (): Promise<Hints | undefined> => {
      try {
        const q = new URLSearchParams({ agentIdentifier: config.MASUMI_AGENT_IDENTIFIER ?? '', network: config.MASUMI_NETWORK });
        const r = agentEntry.parse(await call('GET', `/registry/agent-identifier?${q}`));
        const list = r.data.supportedPaymentSources ?? [];
        const i = config.MASUMI_SUPPORTED_PAYMENT_SOURCE_INDEX ?? list.findIndex((s) => s.chain === 'Cardano' && s.network === config.MASUMI_NETWORK);
        const s = i >= 0 ? list[i] : undefined;
        if (!s) return {};
        const pricingType = s.pricing?.pricingType;
        return s.paymentSourceType === 'Web3CardanoV2' ? { paymentSourceType: s.paymentSourceType, supportedPaymentSourceIndex: i, pricingType } : { pricingType };
      } catch (err) {
        source = undefined;
        console.error('[masumi] registry lookup failed, using the configured source hints:', (err as Error).message);
        return undefined;
      }
    })());

  const toState = (p: PaymentDto): PaymentState => {
    const nextAction = p.NextAction?.requestedAction ?? 'None';
    const resultHash = p.resultHash || p.NextAction?.resultHash || null;
    const withdrawn = WITHDRAWN.has(p.onChainState ?? '');
    return {
      onChainState: p.onChainState ?? null,
      nextAction,
      fundsLocked: p.onChainState === 'FundsLocked',
      resultSubmitted:
        p.onChainState === 'ResultSubmitted' ||
        withdrawn ||
        Boolean(resultHash) ||
        nextAction === 'SubmitResultRequested' ||
        nextAction === 'SubmitResultInitiated',
      resultHash,
      withdrawn,
      collectionTxHash: collectionTx(p),
      errorType: p.NextAction?.errorType ?? null,
    };
  };

  return {
    async createPayment({ inputHash, identifierFromPurchaser, amounts, metadata, windows }) {
      const t = defaultTimes(now(), windows ?? windowsFromConfig(config));
      const fallback: Hints =
        config.MASUMI_SUPPORTED_PAYMENT_SOURCE_INDEX !== undefined
          ? { paymentSourceType: 'Web3CardanoV2', supportedPaymentSourceIndex: config.MASUMI_SUPPORTED_PAYMENT_SOURCE_INDEX }
          : {};
      const hints = (await lookupSource()) ?? fallback;
      const dynamic = (hints.pricingType ?? config.MASUMI_PRICING_TYPE) === 'Dynamic';
      if (dynamic && !amounts?.length) throw new MasumiPaymentError('Dynamic pricing needs an amount for every payment request');
      const requested = dynamic ? amounts!.map((a) => ({ amount: a.amount, unit: normalizeUnit(a.unit) })) : undefined;
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
          ...(hints.paymentSourceType ? { paymentSourceType: hints.paymentSourceType } : {}),
          ...(hints.supportedPaymentSourceIndex !== undefined ? { supportedPaymentSourceIndex: hints.supportedPaymentSourceIndex } : {}),
          ...(requested ? { RequestedFunds: requested } : {}),
          ...(metadata ? { metadata } : {}),
        }),
      );
      if (!res.success) throw new MasumiPaymentError('POST /payment: unexpected response shape');
      const p = res.data.data;
      const funds = p.RequestedFunds?.map((f) => ({ amount: f.amount, unit: f.unit })) ?? requested;
      const sourceType = p.PaymentSource?.paymentSourceType ?? hints.paymentSourceType;
      const out: JobPayment = {
        blockchainIdentifier: p.blockchainIdentifier,
        agentIdentifier: config.MASUMI_AGENT_IDENTIFIER ?? '',
        // The signed terms bind the selling wallet the service used; prefer it over the configured value.
        sellerVKey: p.SmartContractWallet?.walletVkey ?? config.MASUMI_SELLER_VKEY ?? '',
        identifierFromPurchaser,
        inputHash,
        payByTime: p.payByTime ?? t.payByTime,
        submitResultTime: p.submitResultTime ?? t.submitResultTime,
        unlockTime: p.unlockTime ?? t.unlockTime,
        externalDisputeUnlockTime: p.externalDisputeUnlockTime ?? t.externalDisputeUnlockTime,
      };
      if (funds?.length) out.amounts = funds;
      if (sourceType) out.paymentSourceType = sourceType;
      if (hints.supportedPaymentSourceIndex !== undefined) out.supportedPaymentSourceIndex = hints.supportedPaymentSourceIndex;
      if (p.PaymentSource?.smartContractAddress) out.smartContractAddress = p.PaymentSource.smartContractAddress;
      return out;
    },

    async getPayment(blockchainIdentifier) {
      const res = envelope.safeParse(
        await call('POST', '/payment/resolve-blockchain-identifier', { blockchainIdentifier, network: config.MASUMI_NETWORK, includeHistory: 'true' }),
      );
      if (!res.success) throw new MasumiPaymentError('resolve-blockchain-identifier: unexpected response shape');
      return toState(res.data.data);
    },

    async submitResult(blockchainIdentifier, submitResultHash) {
      await call('POST', '/payment/submit-result', { network: config.MASUMI_NETWORK, blockchainIdentifier, submitResultHash });
    },
  };
}
