// Plays a purchaser against the local HAAS API with a real Preprod payment:
// start_job, POST /purchase on the payment service, poll /status, provide_input, completed.
// Usage: pnpm spike:masumi [haas-url]   (HAAS running with MASUMI_API_KEY + MASUMI_AGENT_IDENTIFIER set)
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config';

const config = loadConfig();
const haas = (process.argv[2] ?? `http://localhost:${config.PORT}`).replace(/\/+$/, '');
const pay = config.MASUMI_API_URL.replace(/\/+$/, '');
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;
const log = (msg: string, extra?: unknown) => console.log(`${stamp()} ${msg}`, ...(extra === undefined ? [] : [extra]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http<T>(method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

type Status = { status: string; result?: string; input_schema?: { input_data: { data?: { values?: string[] } }[] } };
const status = (id: string) => http<Status>('GET', `${haas}/status?job_id=${id}`);

async function waitFor(id: string, want: string[], timeoutMs: number): Promise<Status> {
  const end = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < end) {
    const s = await status(id);
    if (s.status !== last) log(`status: ${s.status}`);
    last = s.status;
    if (want.includes(s.status)) return s;
    if (s.status === 'failed') throw new Error(`job failed: ${s.result ?? ''}`);
    await sleep(5_000);
  }
  throw new Error(`timed out waiting for ${want.join('/')} (last: ${last})`);
}

async function main() {
  if (!config.MASUMI_API_KEY) throw new Error('MASUMI_API_KEY is not set');
  const auth = { token: config.MASUMI_API_KEY };
  log(`HAAS ${haas}, payment service ${pay}`);
  log('availability', await http('GET', `${haas}/availability`));

  const ifp = randomBytes(10).toString('hex');
  const input_data = { task: 'Design a logo for a small bakery', skills: 'logo design, branding', budget_usd: 200, deadline_days: 7, remote_ok: true };
  const job = await http<Record<string, any>>('POST', `${haas}/start_job`, { identifier_from_purchaser: ifp, input_data });
  log(`start_job -> job ${job.id}, payment_required=${job.payment_required}`);
  if (job.payment_required === false) {
    log('HAAS has no payment configured; skipping the purchase');
  } else {
    // Seller-signed terms go back verbatim; times are epoch-ms strings here.
    const purchase = await http<{ data: { id: string; onChainState?: string | null } }>(
      'POST',
      `${pay}/purchase`,
      {
        identifierFromPurchaser: ifp,
        network: config.MASUMI_NETWORK,
        sellerVkey: job.sellerVKey,
        blockchainIdentifier: job.blockchainIdentifier,
        payByTime: String(job.payByTime),
        submitResultTime: String(job.submitResultTime),
        unlockTime: String(job.unlockTime),
        externalDisputeUnlockTime: String(job.externalDisputeUnlockTime),
        agentIdentifier: job.agentIdentifier,
        inputHash: job.input_hash,
      },
      auth,
    );
    log(`purchase created ${purchase.data.id}; waiting for the funds to lock on chain (a few minutes)`);
  }

  const awaiting = await waitFor(job.id, ['awaiting_input', 'completed'], 15 * 60_000);
  if (awaiting.status === 'awaiting_input') {
    const values = awaiting.input_schema?.input_data[0]?.data?.values ?? [];
    const shortlist = awaiting.result ? JSON.parse(awaiting.result).candidates : [];
    log(`check-in with ${shortlist.length} candidates:`);
    for (const c of shortlist) console.log(`          ${c.score} ${c.name} (${c.platform}) $${c.quote_usd ?? '?'}: ${c.reason}`);
    const choice = values[0];
    if (!choice) throw new Error('no candidate to confirm');
    log(`provide_input: ${choice}`);
    log('provide_input ->', await http('POST', `${haas}/provide_input`, { job_id: job.id, input_data: { choice } }));
  }

  const done = await waitFor(job.id, ['completed'], 10 * 60_000);
  log('completed, result:', done.result);
  log('done. The result hash is submitted by the HAAS watcher within ~15 s; check the payment in the admin UI.');
}

main().catch((err) => {
  console.error(`${stamp()} masumi-spike: ${(err as Error).message}`);
  process.exit(1);
});
