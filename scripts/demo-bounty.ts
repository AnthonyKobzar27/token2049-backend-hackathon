// The demo microtask story, locally, end to end:
//
//   "Call Tanjong Pagar Polyclinic and book the earliest physio slot this week"
//     -> MIP-003 start_job -> shortlist of nearby verified teammates -> confirm
//     -> bounty "Phone call, ~5 min, book a physio slot, S$3" offered to nearby workers
//     -> a teammate claims it on their phone page, calls, submits date / time / reference
//     -> checked -> accepted -> worker paid, escrow released
//     -> /status result: "Booked: Thursday 3pm, ref 88213"
//
//   pnpm demo:bounty              a scripted teammate claims and submits through the page
//   pnpm demo:bounty --live       waits for a real teammate: open the printed /w/ link on a phone
//
// Runs on an in-memory database with the memory escrow and a ledger payout; no keys needed.
// PORT (default 8787) and PUBLIC_URL (for links reachable from a phone, e.g. a tunnel) apply.
import { teamFromEnv } from '../src/bounty/seed';
import { createDemoStack } from '../src/bounty/demo';
import { loadConfig } from '../src/config';
import { schemaHash } from '../src/masumi/hash';

const live = process.argv.includes('--live');
const env = loadConfig();
const port = Number(process.env.DEMO_PORT ?? env.PORT);
const config = { ...env, DB_PATH: ':memory:', ESCROW_PROVIDER: 'memory' as const, PUBLIC_URL: process.env.PUBLIC_URL ?? `http://localhost:${port}` };

const TASK = 'Call Tanjong Pagar Polyclinic and book the earliest physio slot this week';
const step = (s: string) => console.log(`\n\x1b[1m▶ ${s}\x1b[0m`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stack = createDemoStack({ config, workers: teamFromEnv() });
const base = await stack.listen(port);

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, body === undefined ? { headers: { accept: 'application/json' } } : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function until<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** The coming Thursday (today if it is Thursday), as YYYY-MM-DD. */
function thursday(): string {
  const d = new Date();
  d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

try {
  step(`Caller (any Masumi agent) -> POST ${base}/start_job`);
  console.log(`  "${TASK}"`);
  const { id: jobId } = await api('/start_job', { input_data: { task: TASK, location: 'Singapore', budget_usd: 5 } });

  step('HAAS routes the brief: nearby verified humans');
  const check = await until('the shortlist', async () => {
    const s = await api(`/status?job_id=${jobId}`);
    return s.status === 'awaiting_input' ? s : undefined;
  });
  for (const c of check.shortlist) console.log(`  ${c.id.padEnd(18)} ${String(c.score).padStart(3)}  ${c.name}: ${c.reason ?? c.headline ?? ''}`);
  const pick = check.shortlist[0].id as string;

  step(`Caller confirms ${pick} -> POST /provide_input`);
  await api('/provide_input', { job_id: jobId, input_schema_hash: schemaHash(check.input_schema), input_data: { choice: pick } });

  const bounty = await until('the bounty', () => stack.bounty.board.list()[0]);
  step(`Bounty posted: "${bounty.spec.title}" [${bounty.code}]`);
  console.log(`  fields: ${bounty.spec.fields.map((f) => `${f.key} (${f.type})`).join(', ')}   spec by ${bounty.spec.derivedBy}`);
  for (const o of bounty.offers) console.log(`  offered to ${stack.bounty.board.getWorker(o.workerId)!.name.padEnd(8)} ${stack.bounty.board.pageUrl(o.token)}`);

  if (live) {
    step('Waiting for a teammate to claim and submit on their phone (Ctrl-C to stop)…');
  } else {
    const worker = stack.bounty.board.getWorker(bounty.offers[0]!.workerId)!;
    const page = `/w/${bounty.offers[0]!.token}`;
    step(`${worker.name} opens ${page} and taps Claim`);
    await api(`${page}/claim`, {});
    await sleep(300);
    step(`${worker.name} calls the polyclinic, then submits the result`);
    const result = { date: thursday(), time: '15:00', reference: '88213', notes: 'Physio, Block 2 level 3. Bring NRIC.' };
    console.log(`  ${JSON.stringify(result)}`);
    await api(`${page}/submit`, result);
  }

  const done = await until(
    'the result',
    async () => {
      const s = await api(`/status?job_id=${jobId}`);
      return s.status === 'completed' || s.status === 'failed' ? s : undefined;
    },
    live ? 3_600_000 : 30_000,
  );
  const result = JSON.parse(done.result);
  const final = stack.bounty.board.get(bounty.id)!;
  const booking = stack.store.getBooking(result.bookingId ?? '');
  step(`GET /status -> ${done.status}`);
  console.log(`  bounty ${final.status}, checked by ${final.qa?.by ?? '-'}, payout ${final.payout ? `${final.reward.amount} ${final.reward.currency} on ${final.payout.chain}` : '-'}, escrow ${booking ? stack.store.getEscrowByBooking(booking.id)?.status : '-'}`);
  console.log(`  work: ${JSON.stringify(result.work?.data ?? {})}`);
  console.log(`\n\x1b[1;32m  ${result.summary}\x1b[0m\n`);
} catch (err) {
  console.error('\ndemo failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await stack.close();
}
