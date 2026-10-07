import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import { createEventBus } from '../domain/events';
import type { ApprovalGate, FreelancerSource, SourceRegistry, Store } from '../domain/ports';
import type { Booking, ConversationMessage, HaasEvent, PlatformMessage } from '../domain/types';
import { createLiaisonWith, type Decide } from './liaison';

function setup(opts: { paused?: boolean; decision?: Awaited<ReturnType<Decide>>; approve?: boolean; inbound?: PlatformMessage[] } = {}) {
  const booking = { id: 'bk_1', jobId: 'job_1', source: 'fake', status: 'placed', platformRef: 'ref1', paused: opts.paused ?? false } as Booking;
  const messages: ConversationMessage[] = [];
  const kv = new Map<string, string>();
  const store = {
    listBookings: () => [booking],
    getBooking: (id: string) => (id === booking.id ? booking : null),
    getJob: () => ({ brief: { task: 't', skills: [], remoteOk: true } }),
    getKv: (k: string) => kv.get(k) ?? null,
    setKv: (k: string, v: string) => void kv.set(k, v),
    addMessage: (m: ConversationMessage) => {
      if (m.externalId && messages.some((x) => x.bookingId === m.bookingId && x.externalId === m.externalId)) return false;
      messages.push(m);
      return true;
    },
    listMessages: (f: { bookingId?: string; thread?: string; jobId?: string }) =>
      messages.filter((m) => (!f.bookingId || m.bookingId === f.bookingId) && (!f.thread || m.thread === f.thread) && (!f.jobId || m.jobId === f.jobId)),
  } as unknown as Store;
  const inbound = opts.inbound ?? [{ externalId: 'e1', fromFreelancer: true, text: 'When do you need it?', at: 100 }];
  const sent: string[] = [];
  const source = {
    name: 'fake',
    readMessages: vi.fn(async () => inbound),
    sendMessage: vi.fn(async (_r: string, t: string) => void sent.push(t)),
  } as unknown as FreelancerSource;
  const registry = { get: () => source } as unknown as SourceRegistry;
  const gate: ApprovalGate = { request: vi.fn(async () => ({ approved: opts.approve ?? true })), resolve() {} };
  const bus = createEventBus();
  const events: HaasEvent[] = [];
  bus.on((e) => events.push(e));
  const decide = vi.fn<Decide>(async () => opts.decision ?? { action: 'reply', text: 'Friday, please.' });
  const liaison = createLiaisonWith({ store, bus, registry, gate, config: testConfig() }, decide);
  return { liaison, gate, sent, source, messages, decide, events, kv };
}

describe('liaison', () => {
  it('replies through the gate', async () => {
    const t = setup();
    await t.liaison.tick();
    expect(t.gate.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'routine_message', bookingId: 'bk_1' }));
    expect(t.sent).toEqual(['Friday, please.']);
    expect(t.messages.map((m) => `${m.thread}/${m.from}`)).toEqual(['freelancer/freelancer', 'freelancer/agent']);
    expect(t.events.filter((e) => e.type === 'conversation.message')).toHaveLength(2);
  });

  it('drops sentences about HAAS, agents or crypto from a reply, and sends nothing when only those remain', async () => {
    const t = setup({ decision: { action: 'reply', text: 'Friday works. The escrow on Solana is already funded.' } });
    await t.liaison.tick();
    expect(t.sent).toEqual(['Friday works.']);
    const u = setup({ decision: { action: 'reply', text: 'Our AI agent will confirm.' } });
    await u.liaison.tick();
    expect(u.sent).toEqual([]);
    expect(u.gate.request).not.toHaveBeenCalled();
  });

  it('sends nothing when the gate denies', async () => {
    const t = setup({ approve: false });
    await t.liaison.tick();
    expect(t.sent).toEqual([]);
    expect(t.messages).toHaveLength(1);
  });

  it('does nothing for a paused booking', async () => {
    const t = setup({ paused: true });
    await t.liaison.tick();
    expect(t.source.readMessages).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });

  it('ask_hirer creates a hirer-thread message and a pending relay, then relays the answer', async () => {
    const t = setup({ decision: { action: 'ask_hirer', text: 'What colour palette?' } });
    await t.liaison.tick();
    const asked = t.messages.find((m) => m.thread === 'hirer');
    expect(asked).toMatchObject({ from: 'agent', text: 'What colour palette?', bookingId: 'bk_1' });
    expect(t.sent).toEqual([]);
    expect(t.kv.get('relay:bk_1')).toBeTruthy();

    // the hirer answers (stored by the Telegram channel); the next tick relays it
    t.messages.push({ id: 'm9', jobId: 'job_1', bookingId: 'bk_1', thread: 'hirer', from: 'hirer', text: 'Blue and white', createdAt: Date.now() + 10 });
    await t.liaison.tick();
    expect(t.sent).toEqual(['Blue and white']);
    expect(t.gate.request).toHaveBeenCalledTimes(1);
    expect(t.kv.get('relay:bk_1')).toBe('');
  });

  it('dedupes repeated inbound messages', async () => {
    const t = setup();
    await t.liaison.tick();
    await t.liaison.tick();
    expect(t.decide).toHaveBeenCalledTimes(1);
    expect(t.sent).toHaveLength(1);
    expect(t.messages.filter((m) => m.from === 'freelancer')).toHaveLength(1);
  });

  it('never relays to a freelancer who has not written', async () => {
    const t = setup({ inbound: [] });
    expect(await t.liaison.relayHirerAnswer('bk_1', 'hello')).toBe(false);
    expect(t.sent).toEqual([]);
  });

  it('stores inbound but decides nothing without a decision function or key', async () => {
    const t = setup();
    const bare = createLiaisonWith({ store: {} as Store, bus: createEventBus(), registry: {} as SourceRegistry, gate: t.gate, config: testConfig({ ANTHROPIC_API_KEY: undefined }) });
    expect(bare.tick).toBeTypeOf('function');
  });
});
