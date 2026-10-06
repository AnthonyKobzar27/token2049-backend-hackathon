// Sokosumi Core API, as a Coworker runtime sees it (Bearer coworker_* key).
// Paths and payloads follow Sokosumi's own runtime (apps/cli/src/coworker/runtime-task.ts) and Core's
// POST /v1/tasks/{id}/events schema (apps/core/src/routes/v1/tasks/[id]/events/schema.ts):
//   GET  /v1/coworkers/me                      identity: { id, capabilities[], archivedAt }
//   GET  /v1/tasks?assigneeId=&status=READY     Tasks this Coworker may run
//   GET  /v1/tasks/{id}                         one Task
//   POST /v1/tasks/{id}/events                  { status?, comment?, masumiPayment? }
//   GET  /v1/tasks/{id}/receipt                 seller receipt: { settled, onChainState, txHash, ... }
// Responses are wrapped as { data }.

export const COWORKER_KEY_PREFIX = 'coworker_';

export type TaskStatus =
  | 'QUEUED'
  | 'READY'
  | 'GRANT_PENDING'
  | 'INPUT_REQUIRED'
  | 'APPROVAL_REQUIRED'
  | 'AUTHENTICATION_REQUIRED'
  | 'OUT_OF_CREDITS'
  | 'CREDITS_TOPPED_UP'
  | 'RUNNING'
  | 'AWAITING_EXTERNAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELED';

export interface SokosumiTask {
  id: string;
  name: string;
  description: string | null;
  status: TaskStatus;
  assigneeId?: string | null;
  organizationId?: string | null;
  ownerId?: string | null;
}

/** Core's MasumiPayment: the seller's signed terms, echoed into the buyer's POST /purchase. Times are ms strings. */
export interface MasumiPaymentPayload {
  blockchainIdentifier: string;
  identifierFromPurchaser: string;
  agentIdentifier: string;
  sellerVkey: string;
  submitResultTime: string;
  payByTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  inputHash: string;
  paymentSourceType?: 'Web3CardanoV1' | 'Web3CardanoV2';
  supportedPaymentSourceIndex?: number;
  Amounts: { amount: string; unit: string }[];
  PaymentSource?: { network: 'Preprod' | 'Mainnet'; smartContractAddress: string; policyId: string };
}

export interface TaskEventInput {
  status?: TaskStatus;
  comment?: string;
  masumiPayment?: MasumiPaymentPayload;
}

export interface TaskEvent {
  id: string;
  taskId?: string;
  status?: TaskStatus | null;
}

export interface TaskReceipt {
  settled: boolean;
  onChainState: string | null;
  txHash: string | null;
  blockchainIdentifier?: string | null;
}

export class CoreError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind?: string,
  ) {
    super(message);
  }
}

export interface CoreClient {
  me(): Promise<{ id: string; capabilities: string[]; archivedAt: string | null }>;
  listReadyTasks(coworkerId: string): Promise<SokosumiTask[]>;
  getTask(taskId: string): Promise<SokosumiTask>;
  postEvent(taskId: string, event: TaskEventInput): Promise<TaskEvent>;
  receipt(taskId: string): Promise<TaskReceipt>;
}

export interface CoreClientOptions {
  apiUrl: string;
  apiKey: string;
  /** X-Organization-Slug: lists the Tasks of that organization Workspace. */
  organizationSlug?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Never let the key reach a log line. */
const redact = (s: string, key: string) => (key ? s.split(key).join('[redacted]') : s);

export function createCoreClient(opts: CoreClientOptions): CoreClient {
  if (!opts.apiKey.startsWith(COWORKER_KEY_PREFIX) || /\s/.test(opts.apiKey)) {
    throw new Error('SOKOSUMI_COWORKER_API_KEY must be a coworker_* runtime key');
  }
  const base = opts.apiUrl.replace(/\/+$/, '');
  const doFetch: typeof fetch = (...a) => (opts.fetch ?? globalThis.fetch)(...a);

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${opts.apiKey}` };
    if (opts.organizationSlug) headers['x-organization-slug'] = opts.organizationSlug;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new CoreError(redact(`Sokosumi unreachable: ${(err as Error).message}`, opts.apiKey));
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.trim() ? JSON.parse(text) : undefined;
    } catch {
      throw new CoreError(`${method} ${path}: response is not JSON (${res.status})`, res.status);
    }
    if (!res.ok) {
      const b = record(parsed);
      const kind = typeof b?.kind === 'string' ? b.kind : undefined;
      const msg = typeof b?.message === 'string' ? b.message : typeof b?.error === 'string' ? b.error : text.slice(0, 300);
      throw new CoreError(redact(`${method} ${path} -> ${res.status}${kind ? ` ${kind}` : ''}: ${msg}`, opts.apiKey), res.status, kind);
    }
    return record(parsed)?.data;
  }

  const toTask = (v: unknown): SokosumiTask => {
    const t = record(v);
    if (!t || typeof t.id !== 'string' || typeof t.status !== 'string') throw new CoreError('unexpected Task shape');
    return {
      id: t.id,
      name: typeof t.name === 'string' ? t.name : '',
      description: typeof t.description === 'string' ? t.description : null,
      status: t.status as TaskStatus,
      assigneeId: typeof t.assigneeId === 'string' ? t.assigneeId : null,
      organizationId: typeof t.organizationId === 'string' ? t.organizationId : null,
      ownerId: typeof t.ownerId === 'string' ? t.ownerId : null,
    };
  };

  return {
    async me() {
      const d = record(await call('GET', '/v1/coworkers/me'));
      if (!d || typeof d.id !== 'string') throw new CoreError('unexpected Coworker shape');
      const caps = Array.isArray(d.capabilities) ? d.capabilities.filter((c): c is string => typeof c === 'string') : [];
      return { id: d.id, capabilities: caps, archivedAt: typeof d.archivedAt === 'string' ? d.archivedAt : null };
    },
    async listReadyTasks(coworkerId) {
      const q = new URLSearchParams({ assigneeId: coworkerId, status: 'READY', take: '20' });
      const d = await call('GET', `/v1/tasks?${q}`);
      return (Array.isArray(d) ? d : []).map(toTask);
    },
    async getTask(taskId) {
      return toTask(await call('GET', `/v1/tasks/${encodeURIComponent(taskId)}`));
    },
    async postEvent(taskId, event) {
      const d = record(await call('POST', `/v1/tasks/${encodeURIComponent(taskId)}/events`, event));
      if (!d || typeof d.id !== 'string') throw new CoreError('Task event could not be confirmed');
      return { id: d.id, taskId: typeof d.taskId === 'string' ? d.taskId : undefined, status: (d.status as TaskStatus | null) ?? null };
    },
    async receipt(taskId) {
      const d = record(await call('GET', `/v1/tasks/${encodeURIComponent(taskId)}/receipt`)) ?? {};
      return {
        settled: d.settled === true,
        onChainState: typeof d.onChainState === 'string' ? d.onChainState : null,
        txHash: typeof d.txHash === 'string' ? d.txHash : null,
        blockchainIdentifier: typeof d.blockchainIdentifier === 'string' ? d.blockchainIdentifier : null,
      };
    },
  };
}
