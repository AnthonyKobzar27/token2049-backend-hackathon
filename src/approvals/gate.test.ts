import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import { createEventBus } from '../domain/events';
import type { AutonomyPolicy, Store } from '../domain/ports';
import type { Approval, HaasEvent } from '../domain/types';
import { createApprovalGate } from './gate';

function fakeStore(seed: Approval[] = []) {
  const map = new Map(seed.map((a) => [a.id, a]));
  const store = {
    insertApproval: (a: Approval) => void map.set(a.id, a),
    updateApproval: (id: string, patch: Partial<Approval>) => {
      const next = { ...map.get(id)!, ...patch };
      map.set(id, next);
      return next;
    },
    getApproval: (id: string) => map.get(id) ?? null,
    listApprovals: (f?: { status?: Approval['status'] }) => [...map.values()].filter((a) => !f?.status || a.status === f.status),
  } as unknown as Store;
  return { store, map };
}

const policy = (auto: boolean): AutonomyPolicy => ({ requiresApproval: () => !auto, pause() {}, resume() {} });
const operatorConfig = (o = {}) => testConfig({ TELEGRAM_OPERATOR_ID: '42', ...o });

function setup(opts: { auto?: boolean; config?: ReturnType<typeof testConfig>; seed?: Approval[] } = {}) {
  const { store, map } = fakeStore(opts.seed);
  const bus = createEventBus();
  const events: HaasEvent[] = [];
  bus.on((e) => events.push(e));
  const gate = createApprovalGate({ store, bus, policy: policy(opts.auto ?? false), config: opts.config ?? operatorConfig() });
  return { gate, map, events };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('approval gate', () => {
  it('resolves automatic actions at once without storing anything', async () => {
    const { gate, map, events } = setup({ auto: true });
    expect(await gate.request({ action: 'routine_message', summary: 's' })).toEqual({ approved: true });
    expect(map.size).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('waits for approval, then resolves approved', async () => {
    const { gate, map, events } = setup();
    const p = gate.request({ action: 'book', summary: 'book it' });
    const approval = (events[0] as { approval: Approval }).approval;
    expect(events[0]?.type).toBe('approval.requested');
    expect(map.get(approval.id)?.status).toBe('pending');
    gate.resolve(approval.id, { approved: true, by: '42' });
    const out = await p;
    expect(out.approved).toBe(true);
    expect(out.approval).toMatchObject({ status: 'approved', decidedBy: '42' });
    expect(events.map((e) => e.type)).toEqual(['approval.requested', 'approval.resolved']);
  });

  it('resolves denied', async () => {
    const { gate, events } = setup();
    const p = gate.request({ action: 'pay', summary: 's' });
    gate.resolve((events[0] as { approval: Approval }).approval.id, { approved: false, by: '42', note: 'no' });
    expect(await p).toMatchObject({ approved: false, approval: { status: 'denied', note: 'no' } });
  });

  it('expires after the timeout', async () => {
    const { gate, events } = setup();
    const p = gate.request({ action: 'book', summary: 's', timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toMatchObject({ approved: false, approval: { status: 'expired' } });
    expect(events.at(-1)?.type).toBe('approval.resolved');
  });

  it('uses APPROVAL_TIMEOUT_MIN by default', async () => {
    const { gate } = setup({ config: operatorConfig({ APPROVAL_TIMEOUT_MIN: 2 }) });
    let done = false;
    void gate.request({ action: 'book', summary: 's' }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(119_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(done).toBe(true);
  });

  it('ignores a second resolve and unknown ids', async () => {
    const { gate, events } = setup();
    const p = gate.request({ action: 'book', summary: 's' });
    const id = (events[0] as { approval: Approval }).approval.id;
    gate.resolve(id, { approved: true, by: 'a' });
    gate.resolve(id, { approved: false, by: 'b' });
    gate.resolve('nope', { approved: true, by: 'a' });
    expect((await p).approval?.decidedBy).toBe('a');
    expect(events.filter((e) => e.type === 'approval.resolved')).toHaveLength(1);
  });

  it('expires approvals left pending by a previous process', () => {
    const old: Approval = { id: 'apr_old', action: 'book', summary: 's', status: 'pending', createdAt: 1 };
    const { map } = setup({ seed: [old] });
    expect(map.get('apr_old')?.status).toBe('expired');
  });

  it('auto-approves when headless (no operator, no bot token)', async () => {
    const { gate, events } = setup({ config: testConfig({ TELEGRAM_OPERATOR_ID: undefined, TELEGRAM_BOT_TOKEN: undefined }) });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await gate.request({ action: 'book', summary: 's' });
    expect(out).toMatchObject({ approved: true, approval: { status: 'approved', decidedBy: 'headless' } });
    expect(events.map((e) => e.type)).toEqual(['approval.requested', 'approval.resolved']);
  });
});
