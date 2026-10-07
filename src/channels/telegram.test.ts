import { describe, expect, it, vi } from 'vitest';
import type { Intake } from '../agent/intake';
import { testConfig } from '../config';
import { createEventBus } from '../domain/events';
import type { Store, TelegramDeps } from '../domain/ports';
import type { Approval, Booking, Job, Shortlist } from '../domain/types';
import { createController, registerTelegramExtension, type Button, type TgApi } from './telegram';

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(intakeResults: Awaited<ReturnType<Intake['next']>>[] = []) {
  const kv = new Map<string, string>();
  const job = { id: 'job_1', client: 'telegram', clientRef: '7', status: 'awaiting_input', brief: { task: 'Design a logo', skills: [], remoteOk: true }, createdAt: 1 } as unknown as Job;
  const shortlist = { id: 'sl_1', jobId: 'job_1', round: 1, sources: [], candidates: [{ profile: { id: 'p:1', name: 'Ann', platform: 'p', headline: '', url: '', skills: [], pricing: [] }, score: 50, reason: 'r', unknowns: [] }] } as unknown as Shortlist;
  const booking = { id: 'bk_1', jobId: 'job_1', platform: 'fiverr', status: 'verified', priceUsd: 25, verification: { verdict: 'pass', score: 0.92, summary: 'All fields present', checks: [] } } as unknown as Booking;
  const approvals = new Map<string, Approval>([
    ['apr_1', { id: 'apr_1', action: 'book', jobId: 'job_1', bookingId: 'bk_1', summary: 'Book Ann', status: 'pending', createdAt: 1 }],
    ['apr_acc', { id: 'apr_acc', action: 'accept', jobId: 'job_1', bookingId: 'bk_1', summary: 'QA passed: release $25', status: 'pending', createdAt: 1 }],
    ['apr_other', { id: 'apr_other', action: 'accept', jobId: 'job_other', bookingId: 'bk_x', summary: 'release', status: 'pending', createdAt: 1 }],
  ]);
  const store = {
    getKv: (k: string) => kv.get(k) ?? null,
    setKv: (k: string, v: string) => void kv.set(k, v),
    addMessage: () => true,
    getJob: (id: string) => (id === 'job_1' ? job : id === 'job_other' ? ({ ...job, id, clientRef: '8' } as Job) : null),
    listJobs: (f?: { clientRef?: string }) => (!f?.clientRef || f.clientRef === '7' ? [job] : []),
    getShortlist: (id: string) => (id === 'sl_1' ? shortlist : null),
    getBooking: (id: string) => (id === 'bk_1' ? booking : null),
    getApproval: (id: string) => approvals.get(id) ?? null,
  } as unknown as Store;
  const jobs = { startJob: vi.fn(() => job), provideInput: vi.fn(() => job) };
  const gate = { request: vi.fn(), resolve: vi.fn() };
  const policy = { requiresApproval: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  const sent: { chat: string; text: string; buttons?: Button[][] }[] = [];
  const answers: (string | undefined)[] = [];
  const cleared: { chat: string; messageId: number }[] = [];
  const api: TgApi = {
    send: async (chat, text, buttons) => (sent.push({ chat, text, buttons }), sent.length),
    edit: async () => {},
    photo: async () => {},
    answer: async (_id, text) => void answers.push(text),
    clearKeyboard: async (chat, messageId) => void cleared.push({ chat, messageId }),
  };
  const queue = [...intakeResults];
  const intake: Intake = { next: async () => queue.shift()! };
  const bus = createEventBus();
  const deps = { jobs, bookings: {}, gate, policy, store, bus, config: testConfig({ TELEGRAM_OPERATOR_ID: '99', PUBLIC_URL: 'https://haas.test' }) } as unknown as TelegramDeps;
  return { c: createController(deps, api, intake), jobs, gate, policy, sent, answers, cleared, kv, job, approvals, bus };
}

describe('telegram controller', () => {
  it('asks, then starts a job when intake yields a brief', async () => {
    const t = setup([{ kind: 'ask', text: 'Budget?' }, { kind: 'brief', brief: { task: 'x', skills: [], remoteOk: true }, summary: 'x' }]);
    await t.c.onText('7', 'logo');
    expect(t.sent.at(-1)?.text).toBe('Budget?');
    await t.c.onText('7', '$100');
    expect(t.jobs.startJob).toHaveBeenCalledWith({ brief: { task: 'x', skills: [], remoteOk: true }, client: 'telegram', clientRef: '7' });
  });

  it('different options asks for feedback, then refines', async () => {
    const t = setup();
    await t.c.onCallback('7', '7', 'cb1', 'r:job_1');
    expect(t.kv.get('tg:state:7')).toBe('awaiting_refine_feedback');
    await t.c.onText('7', 'cheaper please');
    expect(t.jobs.provideInput).toHaveBeenCalledWith('job_1', { action: 'refine', feedback: 'cheaper please' });
  });

  it('choose confirms, and provideInput errors become a toast', async () => {
    const t = setup();
    await t.c.onCallback('7', '7', 'cb', 'c:sl_1:0');
    expect(t.jobs.provideInput).toHaveBeenCalledWith('job_1', { action: 'confirm', profileId: 'p:1' });
    t.jobs.provideInput.mockImplementation(() => { throw new Error('job is not awaiting input'); });
    await t.c.onCallback('7', '7', 'cb', 'x:job_1');
    expect(t.answers.at(-1)).toBe('job is not awaiting input');
  });

  it('only the operator can approve a booking or pause', async () => {
    const t = setup();
    await t.c.onCallback('5', '5', 'cb', 'a:apr_1');
    expect(t.gate.resolve).not.toHaveBeenCalled();
    // The hirer may not approve the 'book' step of their own job either.
    await t.c.onCallback('7', '7', 'cb', 'a:apr_1');
    expect(t.gate.resolve).not.toHaveBeenCalled();
    expect(t.answers.at(-1)).toBe('Not your job');
    await t.c.onCallback('99', '99', 'cb', 'a:apr_1');
    expect(t.gate.resolve).toHaveBeenCalledWith('apr_1', { approved: true, by: '99' });
    await t.c.onCallback('99', '99', 'cb', 'p:bk_1');
    expect(t.policy.pause).toHaveBeenCalledWith('bk_1');
    expect(await t.c.onOperatorCommand('5', 'bookings', '')).toBe('Operator only.');
  });

  it('sends approval requests to the operator with buttons and the job context', async () => {
    const t = setup();
    t.c.onEvent({ type: 'approval.requested', approval: t.approvals.get('apr_1')! });
    await tick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.chat).toBe('99');
    expect(t.sent[0]?.text).toContain('Job from telegram: Design a logo');
    expect(t.sent[0]?.buttons?.[0]?.map((b) => b.data)).toEqual(['a:apr_1', 'd:apr_1']);
  });

  it('asks the hirer to release the payment, and the hirer can', async () => {
    const t = setup();
    t.c.onEvent({ type: 'approval.requested', approval: t.approvals.get('apr_acc')! });
    await tick();
    const hirer = t.sent.find((m) => m.chat === '7')!;
    const operator = t.sent.find((m) => m.chat === '99')!;
    expect(hirer.text).toContain('Quality check passed (score 92/100)');
    expect(hirer.text).toContain('Pay $25');
    expect(hirer.buttons?.[0]?.map((b) => b.text)).toEqual(['Pay $25', 'Ask for a fix']);
    expect(operator.buttons?.[0]?.map((b) => b.data)).toEqual(['a:apr_acc', 'd:apr_acc']);
    await t.c.onCallback('7', '7', 'cb', 'a:apr_acc', 1);
    expect(t.gate.resolve).toHaveBeenCalledWith('apr_acc', { approved: true, by: 'hirer:7' });
    // Settled: the buttons come off both copies of the question.
    t.c.onEvent({ type: 'approval.resolved', approval: { ...t.approvals.get('apr_acc')!, status: 'approved' } });
    await tick();
    expect(t.cleared.map((c) => c.chat).sort()).toEqual(['7', '7', '99']);
  });

  it('a hirer cannot answer another chat\'s release approval', async () => {
    const t = setup();
    await t.c.onCallback('7', '7', 'cb', 'a:apr_other');
    expect(t.gate.resolve).not.toHaveBeenCalled();
    expect(t.answers.at(-1)).toBe('Not your job');
  });

  it('deny asks why, and the next text becomes the note', async () => {
    const t = setup();
    await t.c.onCallback('7', '7', 'cb', 'd:apr_acc', 3);
    expect(t.gate.resolve).not.toHaveBeenCalled();
    expect(t.sent.at(-1)?.text).toMatch(/What should the freelancer fix/);
    expect(t.sent.at(-1)?.buttons?.[0]?.[0]?.data).toBe('s:apr_acc');
    expect(t.kv.get('tg:state:7')).toBe('deny_note:apr_acc|hirer:7');
    await t.c.onText('7', 'The logo is missing the tagline');
    expect(t.gate.resolve).toHaveBeenCalledWith('apr_acc', { approved: false, by: 'hirer:7', note: 'The logo is missing the tagline' });
    expect(t.kv.get('tg:state:7')).toBe('idle');
    expect(t.sent.at(-1)?.text).toMatch(/ask the freelancer for a fix and pass your note on/);
  });

  it('skip denies without a note', async () => {
    const t = setup();
    await t.c.onCallback('99', '99', 'cb', 'd:apr_1', 3);
    await t.c.onCallback('99', '99', 'cb', 's:apr_1', 4);
    expect(t.gate.resolve).toHaveBeenCalledWith('apr_1', { approved: false, by: '99' });
    expect(t.kv.get('tg:state:99')).toBe('idle');
  });

  it('/status lists this chat\'s jobs and /cancel drops the open check-in', async () => {
    const t = setup();
    expect(await t.c.onHirerCommand('7', 'status')).toContain('Design a logo');
    expect(await t.c.onHirerCommand('7', 'status')).toContain('waiting for you to pick');
    expect(await t.c.onHirerCommand('8', 'status')).toMatch(/Nothing is running/);
    expect(await t.c.onHirerCommand('7', 'cancel')).toMatch(/Cancelled/);
    expect(t.jobs.provideInput).toHaveBeenCalledWith('job_1', { action: 'cancel' });
  });

  it('escrow instructions link the /pay page', async () => {
    const t = setup();
    const bookingEscrow = { id: 'esc_1', bookingId: 'bk_1', status: 'awaiting_deposit', amount: 25, currency: 'USDC', payUrl: 'solana:https://haas.test/solana-pay/escrow/bk_1', createdAt: 1, updatedAt: 1 } as const;
    t.c.onEvent({ type: 'escrow.updated', escrow: bookingEscrow as never });
    // The QR image is rendered first; wait for the instructions to follow it.
    for (let i = 0; i < 200 && !t.sent.length; i++) await new Promise((r) => setTimeout(r, 10));
    const msg = t.sent.find((m) => m.chat === '7')!;
    expect(msg.text).toContain('href="https://haas.test/pay/bk_1"');
    expect(msg.text).toContain('<code>solana:https://haas.test/solana-pay/escrow/bk_1</code>');
  });

  it('tells the hirer when a job is recorded on Cardano', async () => {
    const t = setup();
    t.c.onEvent({ type: 'reputation.recorded', workerId: 'bounty:w_ann', bookingId: 'bk_1', jobId: 'job_1', txHash: 'ab'.repeat(32), receiptUnit: 'policy' + 'cd'.repeat(10), jobsCompleted: 3, avgRating: 4.5 });
    await tick();
    const msg = t.sent.find((m) => m.chat === '7')!;
    expect(msg.text).toContain('w_ann now has 3 verified jobs, rating 4.5');
    expect(msg.text).toContain(`https://preprod.cardanoscan.io/transaction/${'ab'.repeat(32)}`);
    expect(t.sent.find((m) => m.chat === '99')?.text).toContain('Booking: <code>bk_1</code>');
  });

  it('routes extension buttons by prefix', async () => {
    const t = setup();
    const claim = vi.fn(async (ctx: { data: string }) => `Claimed ${ctx.data.slice(2)}`);
    registerTelegramExtension({ commands: {}, callbacks: { k: claim } });
    await t.c.onCallback('12', '12', 'cb', 'k:UH8X');
    expect(claim).toHaveBeenCalledWith({ chatId: '12', userId: '12', data: 'k:UH8X' });
    expect(t.sent.at(-1)).toMatchObject({ chat: '12', text: 'Claimed UH8X' });
  });
});
