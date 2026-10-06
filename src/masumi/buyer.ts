// Buyer side of Masumi: find another agent, hire it over MIP-003, lock funds through the buyer payment
// service, poll for the result and check its MIP-004 hash. Shapes follow masumi-mcp-server's tools.py.
//
// Free/demo mode: when the agent answers start_job with payment_required=false or a "free_" blockchain
// identifier (pip-masumi's free agent, and our own unpaid mode), or AI_AGENT_FREE is set, no purchase is made.
import { randomBytes } from 'node:crypto';
import type { Config } from '../config';
import type { AiAgentWork, Ms } from '../domain/types';
import { inputHash, resultHash } from './hash';
import type { InputField } from './schema';

export class BuyerError extends Error {}

export interface AgentRef {
  name: string;
  apiBaseUrl: string;
  agentIdentifier?: string;
  source: 'pinned' | 'registry';
}

export interface HireResult {
  output: string;
  work: AiAgentWork;
}

export interface Buyer {
  /** Pinned agent first, then registry matches (filtered by the allowlist). Never rejects. */
  findAgents(opts?: { signal?: AbortSignal }): Promise<AgentRef[]>;
  /** Runs one job on `agent` end to end. Rejects on failure, timeout (via signal) or hash mismatch. */
  hire(agent: AgentRef, text: string, opts?: { signal?: AbortSignal; onProgress?: (message: string) => void }): Promise<HireResult>;
}

type Fetch = typeof fetch;

const list = (s?: string) =>
  (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined);
const trimSlash = (u: string) => u.replace(/\/+$/, '');

/** A fresh identifier_from_purchaser: 20 hex chars (the payment service wants 14 to 26). */
export const newPurchaserId = (): string => randomBytes(10).toString('hex');

/** Fields of an input_schema, flattening input_groups. */
export function schemaFields(raw: unknown): InputField[] {
  const r = asRecord(raw);
  const direct = Array.isArray(raw) ? raw : r.input_data;
  if (Array.isArray(direct)) return direct as InputField[];
  if (Array.isArray(r.input_groups)) return (r.input_groups as unknown[]).flatMap((g) => (Array.isArray(asRecord(g).input_data) ? (asRecord(g).input_data as InputField[]) : []));
  return [];
}

const TEXT_KEY = /^(text|prompt|task|query|input|question|topic|content|description|request|message|instructions?|brief)$/i;
const isOptional = (f: InputField) => (f.validations ?? []).some((v) => v.validation === 'optional' && String(v.value) === 'true');

/** Puts the task text into the agent's main text field and fills other required fields with safe defaults. */
export function buildInputData(fields: InputField[], text: string, inputKey?: string): Record<string, unknown> {
  if (inputKey) return { [inputKey]: text };
  const textual = fields.filter((f) => f.type === 'string' || (f.type as string) === 'text' || (f.type as string) === 'textarea');
  const target = textual.find((f) => TEXT_KEY.test(f.id)) ?? textual.find((f) => !isOptional(f)) ?? textual[0];
  if (!target) return { text };
  const out: Record<string, unknown> = { [target.id]: text };
  for (const f of fields) {
    if (f.id === target.id || isOptional(f) || f.type === 'none') continue;
    if (f.type === 'option') out[f.id] = [0];
    else if (f.type === 'boolean') out[f.id] = false;
    else if (f.type === 'number') {
      const min = (f.validations ?? []).find((v) => v.validation === 'min');
      out[f.id] = min ? Number(min.value) : 1;
    } else out[f.id] = text;
  }
  return out;
}

/** Abortable sleep. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export function createBuyer(config: Config, opts: { fetch?: Fetch; now?: () => Ms; pollMs?: number; maxPollMs?: number } = {}): Buyer {
  const now = opts.now ?? Date.now;
  const doFetch: Fetch = (...a) => (opts.fetch ?? globalThis.fetch)(...a);
  const pollMs = opts.pollMs ?? 500;
  const maxPollMs = opts.maxPollMs ?? 4_000;
  const paymentBase = trimSlash(config.MASUMI_API_URL);
  const buyerKey = config.MASUMI_BUYER_API_KEY ?? config.MASUMI_API_KEY;

  async function call(url: string, init: { method?: 'GET' | 'POST'; body?: unknown; token?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    const signals = [AbortSignal.timeout(init.timeoutMs ?? 15_000), ...(init.signal ? [init.signal] : [])];
    let res: Response;
    try {
      res = await doFetch(url, {
        method: init.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(init.token ? { token: init.token } : {}),
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      throw new BuyerError(`${init.method ?? 'GET'} ${url} unreachable: ${(err as Error).message}`);
    }
    const raw = await res.text();
    if (!res.ok) throw new BuyerError(`${init.method ?? 'GET'} ${url} -> ${res.status}: ${raw.slice(0, 200)}`);
    try {
      return JSON.parse(raw);
    } catch {
      throw new BuyerError(`${url}: response is not JSON`);
    }
  }

  const allow = new Set(list(config.AI_AGENT_ALLOWLIST));
  const wantTags = list(config.AI_AGENT_TAGS).map((t) => t.toLowerCase());

  function toAgent(e: Record<string, unknown>): AgentRef | null {
    const apiBaseUrl = str(e.apiBaseUrl) ?? str(e.api_base_url) ?? str(e.apiUrl) ?? str(e.api_url);
    if (!apiBaseUrl) return null;
    const agentIdentifier = str(e.agentIdentifier) ?? str(e.agent_identifier);
    return { name: str(e.name) ?? agentIdentifier ?? apiBaseUrl, apiBaseUrl: trimSlash(apiBaseUrl), agentIdentifier, source: 'registry' };
  }

  const tagsOf = (e: Record<string, unknown>): string[] => {
    const t = e.tags ?? e.Tags ?? e.AgentTags;
    return Array.isArray(t) ? t.map((x) => (typeof x === 'string' ? x : (str(asRecord(x).tag) ?? str(asRecord(x).name) ?? ''))).map((x) => x.toLowerCase()) : [];
  };

  async function searchRegistry(signal?: AbortSignal): Promise<AgentRef[]> {
    if (!config.MASUMI_REGISTRY_URL) return [];
    const base = trimSlash(config.MASUMI_REGISTRY_URL);
    const filter: Record<string, unknown> = {};
    if (wantTags.length) filter.tags = wantTags;
    if (config.AI_AGENT_CAPABILITY) filter.capability = { name: config.AI_AGENT_CAPABILITY };
    const body = { network: config.MASUMI_NETWORK, limit: 25, ...(Object.keys(filter).length ? { filter } : {}), ...(wantTags.length ? { query: wantTags.join(' ') } : {}) };
    const req = { method: 'POST' as const, body, token: config.MASUMI_REGISTRY_TOKEN, signal, timeoutMs: 8_000 };
    let raw: unknown;
    try {
      raw = await call(`${base}/registry-entry-search/`, req);
    } catch {
      raw = await call(`${base}/registry-entry/`, req);
    }
    const r = asRecord(raw);
    const entries = asRecord(r.data).entries ?? r.entries ?? r.data;
    if (!Array.isArray(entries)) return [];
    return entries
      .map(asRecord)
      .filter((e) => !wantTags.length || tagsOf(e).length === 0 || wantTags.some((t) => tagsOf(e).includes(t)))
      .map(toAgent)
      .filter((a): a is AgentRef => a !== null)
      .filter((a) => allow.size === 0 || allow.has(a.agentIdentifier ?? '') || allow.has(a.apiBaseUrl));
  }

  async function purchase(p: { ifp: string; start: Record<string, unknown>; agentIdentifier?: string; inputHash: string; signal?: AbortSignal }) {
    if (!buyerKey) throw new BuyerError('agent requires payment but MASUMI_BUYER_API_KEY / MASUMI_API_KEY is not set');
    const s = p.start;
    const time = (k: string) => str(s[k]) ?? '';
    await call(`${paymentBase}/purchase/`, {
      method: 'POST',
      token: buyerKey,
      signal: p.signal,
      timeoutMs: 20_000,
      body: {
        identifierFromPurchaser: p.ifp,
        blockchainIdentifier: str(s.blockchainIdentifier),
        network: config.MASUMI_NETWORK,
        sellerVkey: str(s.sellerVKey) ?? str(s.sellerVkey) ?? str(s.seller_vkey),
        paymentType: 'Web3CardanoV1',
        submitResultTime: time('submitResultTime'),
        unlockTime: time('unlockTime'),
        externalDisputeUnlockTime: time('externalDisputeUnlockTime'),
        agentIdentifier: str(s.agentIdentifier) ?? p.agentIdentifier,
        inputHash: p.inputHash,
      },
    });
  }

  async function requestRefund(blockchainIdentifier: string): Promise<void> {
    if (!buyerKey) return;
    try {
      await call(`${paymentBase}/purchase/request-refund`, { method: 'POST', token: buyerKey, body: { blockchainIdentifier, network: config.MASUMI_NETWORK } });
    } catch (err) {
      console.error(`[buyer] refund request for ${blockchainIdentifier} failed:`, (err as Error).message);
    }
  }

  /** The result hash recorded for our purchase, when the payment service has one. */
  async function onChainResultHash(blockchainIdentifier: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const r = asRecord(
        await call(`${paymentBase}/purchase/resolve-blockchain-identifier`, {
          method: 'POST',
          token: buyerKey,
          signal,
          timeoutMs: 5_000,
          body: { blockchainIdentifier, network: config.MASUMI_NETWORK },
        }),
      );
      return str(asRecord(r.data).resultHash) ?? str(r.resultHash);
    } catch {
      return undefined;
    }
  }

  return {
    async findAgents({ signal } = {}) {
      const pinned: AgentRef[] = config.AI_AGENT_URL
        ? [{ name: config.AI_AGENT_NAME ?? config.AI_AGENT_IDENTIFIER ?? 'pinned agent', apiBaseUrl: trimSlash(config.AI_AGENT_URL), agentIdentifier: config.AI_AGENT_IDENTIFIER, source: 'pinned' }]
        : [];
      let found: AgentRef[] = [];
      try {
        found = await searchRegistry(signal);
      } catch (err) {
        console.error('[buyer] registry search failed:', (err as Error).message);
      }
      const seen = new Set(pinned.map((a) => a.apiBaseUrl));
      return [...pinned, ...found.filter((a) => !seen.has(a.apiBaseUrl) && seen.add(a.apiBaseUrl))];
    },

    async hire(agent, text, { signal, onProgress } = {}) {
      const started = now();
      const base = agent.apiBaseUrl;

      let fields: InputField[] = [];
      try {
        fields = schemaFields(await call(`${base}/input_schema`, { signal, timeoutMs: 5_000 }));
      } catch (err) {
        if (!config.AI_AGENT_INPUT_KEY) throw err;
      }
      const inputData = buildInputData(fields, text, config.AI_AGENT_INPUT_KEY);
      const ifp = newPurchaserId();
      const hash = inputHash(inputData, ifp);

      const start = asRecord(await call(`${base}/start_job`, { method: 'POST', body: { identifier_from_purchaser: ifp, input_data: inputData }, signal, timeoutMs: 15_000 }));
      const jobId = str(start.id) ?? str(start.job_id);
      if (!jobId) throw new BuyerError('start_job returned no job id');
      const theirHash = str(start.input_hash) ?? str(start.inputHash);
      // Never pay for input the agent did not receive as we sent it.
      if (theirHash && theirHash !== hash) {
        throw new BuyerError(`input hash mismatch from ${agent.name}`);
      }
      const blockchainIdentifier = str(start.blockchainIdentifier);
      const free = config.AI_AGENT_FREE || start.payment_required === false || !blockchainIdentifier || blockchainIdentifier.startsWith('free');
      let paid = false;
      if (!free) {
        onProgress?.(`Locking payment for ${agent.name} on Cardano…`);
        await purchase({ ifp, start, agentIdentifier: agent.agentIdentifier, inputHash: hash, signal });
        paid = true;
      }

      const refundIfPaid = () => (paid && blockchainIdentifier ? requestRefund(blockchainIdentifier) : Promise.resolve());
      onProgress?.(`${agent.name} is working on it (job ${jobId})…`);

      let status: Record<string, unknown>;
      let wait = pollMs;
      try {
        for (;;) {
          status = asRecord(await call(`${base}/status?job_id=${encodeURIComponent(jobId)}`, { signal, timeoutMs: 8_000 }));
          const s = str(status.status);
          if (s === 'completed') break;
          if (s === 'failed') throw new BuyerError(`${agent.name} failed: ${str(status.result) ?? str(status.message) ?? 'no reason given'}`);
          if (s === 'awaiting_input') throw new BuyerError(`${agent.name} asked for more input, which the AI path does not support`);
          await sleep(wait, signal);
          wait = Math.min(maxPollMs, Math.round(wait * 1.5));
        }
      } catch (err) {
        void refundIfPaid();
        throw err;
      }

      const result = status.result;
      const output = typeof result === 'string' ? result : result === undefined || result === null ? '' : JSON.stringify(result);
      if (!output.trim()) {
        void refundIfPaid();
        throw new BuyerError(`${agent.name} completed with an empty result`);
      }

      // MIP-004: the seller commits sha256(ifp + ";" + output). Check it wherever we can see it.
      const claimed = str(status.result_hash) ?? str(status.resultHash) ?? (paid && blockchainIdentifier ? await onChainResultHash(blockchainIdentifier, signal) : undefined);
      let verified: boolean | undefined;
      if (claimed) {
        verified = claimed === resultHash(output, ifp) || claimed === resultHash(output, ifp, { raw: true });
        if (!verified) {
          await refundIfPaid();
          throw new BuyerError(`result hash mismatch from ${agent.name}${paid ? '; refund requested' : ''}`);
        }
      }

      return {
        output,
        work: {
          name: agent.name,
          agentIdentifier: str(start.agentIdentifier) ?? agent.agentIdentifier,
          apiBaseUrl: base,
          jobId,
          identifierFromPurchaser: ifp,
          blockchainIdentifier,
          paid,
          verified,
          ms: now() - started,
        },
      };
    },
  };
}
