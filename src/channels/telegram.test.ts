import { describe, expect, it, vi } from 'vitest';
import type { Intake } from '../agent/intake';
import { testConfig } from '../config';
import { createEventBus } from '../domain/events';
import type { Store, TelegramDeps } from '../domain/ports';
import type { Job, Shortlist } from '../domain/types';
import { createController, type Button, type TgApi } from './telegram';

function setup(intakeResults: Awaited<ReturnType<Intake['next']>>[] = []) {
  const kv = new Map<string, string>();
  const job = { id: 'job_1', client: 'telegram', clientRef: '7', status: 'awaiting_input', createdAt: 1 } as Job;
  const shortlist = { id: 'sl_1', jobId: 'job_1', round: 1, sources: [], candidates: [{ profile: { id: 'p:1', name: 'Ann', platform: 'p', headline: '', url: '', skills: [], pricing: [] }, score: 50, reason: 'r', unknowns: [] }] } as unknown as Shortlist;
  const store = {
    getKv: (k: string) => kv.get(k) ?? null,
    setKv: (k: string, v: string) => void kv.set(k, v),
    addMessage: () => true,
    getJob: (id: string) => (id === 'job_1' ? job : null),
    listJobs: () => [job],
    getShortlist: (id: string) => (id === 'sl_1' ? shortlist : null),
  } as unknown as Store;
  const jobs = { startJob: vi.fn(() => job), provideInput: vi.fn(() => job) };
  const gate = { request: vi.fn(), resolve: vi.fn() };
  const policy = { requiresApproval: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  const sent: { chat: string; text: string; buttons?: Button[][] }[] = [];
  const answers: (string | undefined)[] = [];
  const api: TgApi = {
    send: async (chat, text, buttons) => (sent.push({ chat, text, buttons }), sent.length),
    edit: async () => {},
    photo: async () => {},
    answer: async (_id, text) => void answers.push(text),
    clearKeyboard: async () => {},
  };
  const queue = [...intakeResults];
  const intake: Intake = { next: async () => queue.shift()! };
  const deps = { jobs, bookings: {}, gate, policy, store, bus: createEventBus(), config: testConfig({ TELEGRAM_OPERATOR_ID: '99' }) } as unknown as TelegramDeps;
  return { c: createController(deps, api, intake), jobs, gate, policy, sent, answers, kv };
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

  it('only the operator can approve or pause', async () => {
    const t = setup();
    await t.c.onCallback('5', '5', 'cb', 'a:apr_1');
    expect(t.gate.resolve).not.toHaveBeenCalled();
    await t.c.onCallback('99', '99', 'cb', 'a:apr_1');
    expect(t.gate.resolve).toHaveBeenCalledWith('apr_1', { approved: true, by: '99' });
    await t.c.onCallback('99', '99', 'cb', 'p:bk_1');
    expect(t.policy.pause).toHaveBeenCalledWith('bk_1');
    expect(await t.c.onOperatorCommand('5', 'bookings', '')).toBe('Operator only.');
  });

  it('sends approval requests to the operator with buttons', async () => {
    const t = setup();
    t.c.onEvent({ type: 'approval.requested', approval: { id: 'apr_1', action: 'book', summary: 's', status: 'pending', createdAt: 1 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.sent[0]?.chat).toBe('99');
    expect(t.sent[0]?.buttons?.[0]?.map((b) => b.data)).toEqual(['a:apr_1', 'd:apr_1']);
  });
});
