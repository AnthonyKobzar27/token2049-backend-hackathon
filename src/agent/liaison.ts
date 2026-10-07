import { z } from 'zod';
import { newId, now } from '../domain/ids';
import type { CreateLiaison, LiaisonDeps } from '../domain/ports';
import type { Booking, BookingStatus, Brief, ConversationMessage } from '../domain/types';
import { hasLlm } from '../llm/client';
import { structuredCall } from './intake';
import { freelancerSafe } from './outreach';

export interface LiaisonInput {
  brief: Brief;
  hirerThread: ConversationMessage[];
  freelancerThread: ConversationMessage[];
  /** New inbound freelancer messages, oldest first. */
  inbound: string[];
}
export interface LiaisonDecision {
  action: 'reply' | 'ask_hirer' | 'none';
  text?: string;
}
export type Decide = (input: LiaisonInput) => Promise<LiaisonDecision>;

export interface Liaison extends ReturnType<CreateLiaison> {
  /** Forwards the hirer's answer to the freelancer, through the approval gate. False when nothing was sent. */
  relayHirerAnswer(bookingId: string, text: string): Promise<boolean>;
}

const OPEN: BookingStatus[] = ['placed', 'in_progress', 'delivered', 'in_revision'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'text'],
  properties: { action: { type: 'string', enum: ['reply', 'ask_hirer', 'none'] }, text: { type: 'string' } },
};
const Out = z.object({ action: z.enum(['reply', 'ask_hirer', 'none']), text: z.string().default('') });

const SYSTEM = `You are the liaison of HAAS between a person who hired a freelancer ("hirer") and the freelancer. You read the freelancer's new messages and decide:
- "reply": the answer is in the brief or in either thread's history. Put a short, polite reply to the freelancer in "text". Never invent facts, prices, deadlines or commitments; never accept or reject delivery, never agree to extra cost.
- "ask_hirer": the freelancer needs information only the hirer has. Put one short question for the hirer in "text" (addressed to the hirer, not the freelancer).
- "none": nothing needs an answer (thanks, status notes) or it is something only a person can decide. "text" is "".
Write in the language the freelancer used.
Style for replies to the freelancer: write like a regular person texting someone they hired. Casual, friendly, one to three short sentences, no corporate phrasing, no lists. Never mention HAAS, AI, agents, bots, escrow, crypto, blockchain, wallets, Solana, Cardano, USDC or Masumi: payment goes through the platform as usual.`;

export function llmDecide(config: LiaisonDeps['config']): Decide {
  return async (input) => {
    const fmt = (m: ConversationMessage) => `${m.from}: ${m.text}`;
    const content = [
      `Brief:\n${JSON.stringify(input.brief)}`,
      `Thread with the hirer:\n${input.hirerThread.map(fmt).join('\n') || '(empty)'}`,
      `Thread with the freelancer:\n${input.freelancerThread.map(fmt).join('\n') || '(empty)'}`,
      `New messages from the freelancer:\n${input.inbound.map((t) => `- ${t}`).join('\n')}`,
    ].join('\n\n');
    return structuredCall(config, { system: SYSTEM, messages: [{ role: 'user', content }], schema: SCHEMA, maxTokens: 1000 }, (raw) => Out.parse(raw));
  };
}

const relayKey = (id: string) => `relay:${id}`;
const cursorKey = (id: string) => `liaison:cursor:${id}`;

/** `decide` is injectable for tests; by default the model decides (and nothing is decided without an API key). */
export function createLiaisonWith(deps: LiaisonDeps, decide?: Decide): Liaison {
  const { store, bus, registry, gate, config } = deps;
  const decider = decide ?? (hasLlm(config) ? llmDecide(config) : undefined);

  function record(b: Booking, m: Pick<ConversationMessage, 'thread' | 'from' | 'text' | 'externalId'>): ConversationMessage | null {
    const message: ConversationMessage = { id: newId('msg'), jobId: b.jobId, bookingId: b.id, createdAt: now(), ...m };
    if (!store.addMessage(message)) return null;
    bus.emit({ type: 'conversation.message', message });
    return message;
  }

  async function sendThroughGate(b: Booking, draft: string, summary: string): Promise<boolean> {
    // The model's reply or the hirer's answer may still mention HAAS, agents or crypto; the freelancer never reads that.
    const text = freelancerSafe(draft);
    if (!text) return false;
    const source = registry.get(b.source);
    if (!source?.sendMessage || !b.platformRef) return false;
    const { approved } = await gate.request({ action: 'routine_message', jobId: b.jobId, bookingId: b.id, summary, detail: text });
    if (!approved) return false;
    await source.sendMessage(b.platformRef, text);
    record(b, { thread: 'freelancer', from: 'agent', text });
    return true;
  }

  async function relayHirerAnswer(bookingId: string, text: string): Promise<boolean> {
    const b = store.getBooking(bookingId);
    if (!b) return false;
    // Never first contact: the freelancer must have written to us.
    const wrote = store.listMessages({ bookingId, thread: 'freelancer' }).some((m) => m.from === 'freelancer');
    if (!wrote) return false;
    const ok = await sendThroughGate(b, text, `Relay your answer to the freelancer: ${text}`);
    if (ok) store.setKv(relayKey(bookingId), '');
    return ok;
  }

  async function handleBooking(b: Booking): Promise<void> {
    const source = registry.get(b.source);
    if (!source?.readMessages || !b.platformRef) return;

    const cursor = Number(store.getKv(cursorKey(b.id)) ?? 0) || 0;
    const fetched = (await source.readMessages(b.platformRef, cursor)).filter((m) => m.fromFreelancer).sort((x, y) => x.at - y.at);
    const fresh: string[] = [];
    for (const m of fetched) {
      const stored = record(b, { thread: 'freelancer', from: 'freelancer', text: m.text, externalId: m.externalId });
      if (stored) fresh.push(m.text);
    }
    if (fetched.length) store.setKv(cursorKey(b.id), String(Math.max(cursor, ...fetched.map((m) => m.at))));

    // At most one automatic message per booking per tick.
    const pending = store.getKv(relayKey(b.id));
    if (pending) {
      const since = Number((JSON.parse(pending) as { at?: number }).at ?? 0);
      const answer = store.listMessages({ bookingId: b.id, thread: 'hirer' }).filter((m) => m.from === 'hirer' && m.createdAt > since).at(-1);
      if (answer && (await relayHirerAnswer(b.id, answer.text))) return;
    }
    if (!fresh.length || !decider) return;

    const decision = await decider({
      brief: store.getJob(b.jobId)?.brief ?? { task: '', skills: [], remoteOk: true },
      hirerThread: store.listMessages({ jobId: b.jobId, thread: 'hirer' }),
      freelancerThread: store.listMessages({ bookingId: b.id, thread: 'freelancer' }),
      inbound: fresh,
    });
    const text = decision.text?.trim();
    if (decision.action === 'reply' && text) {
      await sendThroughGate(b, text, `Reply to the freelancer: ${text}`);
    } else if (decision.action === 'ask_hirer' && text && !store.getKv(relayKey(b.id))) {
      store.setKv(relayKey(b.id), JSON.stringify({ at: now() }));
      record(b, { thread: 'hirer', from: 'agent', text });
    }
  }

  return {
    relayHirerAnswer,
    async tick() {
      for (const b of store.listBookings({ status: OPEN })) {
        if (!b.platformRef || b.paused) continue;
        try {
          await handleBooking(b);
        } catch (err) {
          console.error(`[liaison] booking ${b.id} failed:`, err);
        }
      }
    },
  };
}

export const createLiaison = ((deps: LiaisonDeps) => createLiaisonWith(deps)) satisfies CreateLiaison as (deps: LiaisonDeps) => Liaison;
