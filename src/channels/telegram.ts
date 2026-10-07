import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy';
import QRCode from 'qrcode';
import { createIntake, type Intake, type IntakeTurn } from '../agent/intake';
import { newId, now } from '../domain/ids';
import type { CreateTelegram, TelegramDeps } from '../domain/ports';
import type { HaasEvent, Job } from '../domain/types';
import { explorer } from '../identity/cip68';
import {
  approvalRequest,
  bookingsList,
  bookingStatusLine,
  callbackData,
  candidateCard,
  chunk,
  emptyShortlistText,
  esc,
  escrowInstructions,
  escrowTimeoutLine,
  escrowLine,
  hirerApprovalRequest,
  jobResult,
  jobsStatus,
  parseCallback,
  reputationLine,
  shortlistHeader,
  verificationLine,
} from './format';

export interface Button {
  text: string;
  data: string;
}

/** The slice of Telegram the controller needs; implemented with grammY below, faked in tests. */
export interface TgApi {
  send(chatId: string, text: string, buttons?: Button[][]): Promise<number | undefined>;
  edit(chatId: string, messageId: number, text: string): Promise<void>;
  photo(chatId: string, png: Buffer): Promise<void>;
  answer(callbackId: string, text?: string): Promise<void>;
  clearKeyboard(chatId: string, messageId: number): Promise<void>;
}

export type ExtensionSend = (chatId: string, html: string, buttons?: Button[][]) => Promise<unknown>;

/**
 * Extra command sets (e.g. the bounty board's worker commands) that share this bot but stay
 * out of the hirer flow. Handlers return an HTML reply, or undefined for no reply.
 */
export interface TelegramExtension {
  commands: Record<string, (ctx: { chatId: string; userId: string; args: string }) => Promise<string | undefined>>;
  /**
   * Inline-button handlers by callback-data prefix (the part before the first ':'), e.g. `k` for
   * "k:<bountyCode>". Prefixes used by the hirer flow (c r x a d s p) are taken. Returns the HTML reply.
   */
  callbacks?: Record<string, (ctx: { chatId: string; userId: string; data: string }) => Promise<string | undefined>>;
  /** Called once the bot runs, with a sender for proactive messages (HTML, optional buttons). */
  onStart?(send: ExtensionSend): void;
  onStop?(): void;
}
const extensions: TelegramExtension[] = [];
export function registerTelegramExtension(ext: TelegramExtension): void {
  extensions.push(ext);
}

const EDIT_INTERVAL_MS = 1500;
const START_TEXT = [
  '<b>HAAS</b>: Human as a Service, an open router for freelancers.',
  'Tell me what you need done. I search Fiverr and similar platforms, rank the best fits with reasons, and check with you before anything is booked.',
  'Nobody is paid until the work passes a quality check, and I keep you and the freelancer informed.',
  '',
  'Commands: /status for your jobs, /cancel to stop the current one, /help for this text.',
].join('\n');
/** Commands shown in Telegram's menu for everyone; the operator and worker sets stay out of it. */
export const HIRER_COMMANDS = [
  { command: 'start', description: 'What HAAS does' },
  { command: 'status', description: 'Your current jobs' },
  { command: 'cancel', description: 'Stop the current search' },
  { command: 'help', description: 'Help' },
];
export const OPERATOR_COMMANDS = [
  { command: 'bookings', description: 'Open bookings' },
  { command: 'accept', description: '/accept <bookingId>: accept a delivery' },
  { command: 'revise', description: '/revise <bookingId> <text>: ask for a revision' },
  { command: 'cancelbooking', description: '/cancelbooking <bookingId> <reason>' },
];

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** All behaviour, independent of grammY. */
export function createController(deps: TelegramDeps, api: TgApi, intakeOverride?: Intake) {
  const { jobs, bookings, gate, policy, store, config } = deps;
  const intake = intakeOverride ?? createIntake({ config });
  const operatorId = config.TELEGRAM_OPERATOR_ID;
  const isOperator = (userId: string | number | undefined) => operatorId !== undefined && String(userId) === operatorId;
  const publicUrl = config.PUBLIC_URL.replace(/\/$/, '');
  const cardano = explorer(config.CARDANO_NETWORK);

  const stateKey = (chat: string) => `tg:state:${chat}`;
  const getState = (chat: string) => store.getKv(stateKey(chat)) || 'idle';
  const setState = (chat: string, s: string) => store.setKv(stateKey(chat), s);

  // ---- intake history: kept in kv (reliable) and mirrored with addMessage under a pseudo job id
  const histKey = (chat: string) => `tg:intake:${chat}`;
  const readHistory = (chat: string): IntakeTurn[] => {
    try { return JSON.parse(store.getKv(histKey(chat)) ?? '[]') as IntakeTurn[]; } catch { return []; }
  };
  const writeHistory = (chat: string, h: IntakeTurn[]) => store.setKv(histKey(chat), JSON.stringify(h));
  const mirror = (chat: string, from: 'hirer' | 'agent', text: string, jobId = `intake:${chat}`, bookingId?: string) => {
    try {
      store.addMessage({ id: newId('msg'), jobId, bookingId, thread: 'hirer', from, text, createdAt: now() });
    } catch (err) {
      console.error('[telegram] could not store message:', errText(err));
    }
  };

  const safe = async (what: string, fn: () => Promise<unknown> | unknown) => {
    try { await fn(); } catch (err) { console.error(`[telegram] ${what} failed:`, errText(err)); }
  };

  const chatOf = (job: Job | null | undefined): string | undefined => (job && job.client === 'telegram' ? job.clientRef : undefined);
  const chatOfJob = (jobId: string) => chatOf(store.getJob(jobId));
  const chatOfBooking = (bookingId: string) => {
    const b = store.getBooking(bookingId);
    return b ? chatOfJob(b.jobId) : undefined;
  };

  // ------------------------------------------------------------ hirer input

  async function onStart(chat: string) {
    setState(chat, 'idle');
    await api.send(chat, START_TEXT);
  }

  const OPEN: Job['status'][] = ['awaiting_payment', 'awaiting_input', 'running'];
  const myJobs = (chat: string) => store.listJobs({ client: 'telegram', clientRef: chat }).sort((a, b) => b.createdAt - a.createdAt);

  /** Hirer commands. Returns the HTML reply. */
  async function onHirerCommand(chat: string, command: string): Promise<string> {
    switch (command) {
      case 'help':
        return START_TEXT;
      case 'status': {
        const open = myJobs(chat).filter((j) => OPEN.includes(j.status));
        const recent = open.length ? open : myJobs(chat).slice(0, 3);
        return jobsStatus(recent);
      }
      case 'cancel': {
        const state = getState(chat);
        setState(chat, 'idle');
        writeHistory(chat, []);
        const job = myJobs(chat).find((j) => j.status === 'awaiting_input');
        if (job) {
          try {
            jobs.provideInput(job.id, { action: 'cancel' });
            return 'Cancelled. Tell me when you need something else.';
          } catch (err) {
            return `Could not cancel: ${esc(errText(err))}`;
          }
        }
        if (state !== 'idle') return 'Okay, forget that. What do you need done?';
        const running = myJobs(chat).find((j) => j.status === 'running');
        return running ? 'A search or booking is in progress; it cannot be stopped from here yet. Ask the operator if a booking must be cancelled.' : 'Nothing to cancel.';
      }
      default:
        return 'Unknown command. /help lists what I can do.';
    }
  }

  /** Resolves a denial, with the note the person typed (or none). */
  function denyWithNote(chat: string, approvalId: string, note: string | undefined, by: string) {
    setState(chat, 'idle');
    const a = store.getApproval(approvalId);
    if (!a || a.status !== 'pending') return 'That approval is already settled.';
    gate.resolve(approvalId, { approved: false, by, ...(note && { note }) });
    return a.action === 'accept' ? `Noted. I will ask the freelancer for a fix${note ? ' and pass your note on' : ''}.` : 'Denied.';
  }

  async function onText(chat: string, text: string) {
    const state = getState(chat);

    if (state.startsWith('deny_note:')) {
      const [approvalId, by] = state.slice('deny_note:'.length).split('|');
      await api.send(chat, denyWithNote(chat, approvalId!, text.trim() || undefined, by || chat));
      return;
    }

    if (state === 'awaiting_refine_feedback') {
      const job = store.listJobs({ client: 'telegram', clientRef: chat }).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!job) { setState(chat, 'idle'); return onText(chat, text); }
      try {
        jobs.provideInput(job.id, { action: 'refine', feedback: text });
        setState(chat, 'idle');
        await api.send(chat, 'Searching again with that in mind.');
      } catch (err) {
        setState(chat, 'idle');
        await api.send(chat, `Could not change the search: ${esc(errText(err))}`);
      }
      return;
    }

    if (state.startsWith('relay_pending:')) {
      const bookingId = state.slice('relay_pending:'.length);
      const b = store.getBooking(bookingId);
      if (b) {
        const message = { id: newId('msg'), jobId: b.jobId, bookingId, thread: 'hirer' as const, from: 'hirer' as const, text, createdAt: now() };
        store.addMessage(message);
        deps.bus.emit({ type: 'conversation.message', message });
        setState(chat, 'idle');
        await api.send(chat, 'Thanks, I will pass that on to the freelancer.');
        return;
      }
      setState(chat, 'idle');
    }

    // intake
    if (state === 'idle') writeHistory(chat, []);
    const history = [...readHistory(chat), { from: 'hirer' as const, text }];
    mirror(chat, 'hirer', text);
    let result;
    try {
      result = await intake.next(history);
    } catch (err) {
      console.error('[telegram] intake failed:', errText(err));
      await api.send(chat, 'Sorry, something went wrong on my side. Please try again.');
      return;
    }
    if (result.kind === 'ask') {
      writeHistory(chat, [...history, { from: 'agent', text: result.text }]);
      mirror(chat, 'agent', result.text);
      setState(chat, 'intake');
      await api.send(chat, esc(result.text));
      return;
    }
    writeHistory(chat, []);
    setState(chat, 'idle');
    await api.send(chat, `<b>Got it.</b>\n${esc(result.summary)}\n\nSearching now.`);
    try {
      jobs.startJob({ brief: result.brief, client: 'telegram', clientRef: chat });
    } catch (err) {
      await api.send(chat, `Could not start the search: ${esc(errText(err))}`);
    }
  }

  // --------------------------------------------------------------- buttons

  /** The hirer may answer release and revision approvals for their own job; the operator may answer any. */
  const mayDecide = (chat: string, userId: string, approvalId: string): boolean => {
    if (isOperator(userId)) return true;
    const a = store.getApproval(approvalId);
    if (!a || (a.action !== 'accept' && a.action !== 'revise') || !a.jobId) return false;
    return chatOf(store.getJob(a.jobId)) === chat;
  };

  async function onCallback(chat: string, userId: string, callbackId: string, data: string, messageId?: number) {
    // Extension buttons first (e.g. the worker's "Claim" button, prefix k).
    const prefix = data.split(':')[0] ?? '';
    const ext = extensions.find((e) => e.callbacks?.[prefix]);
    if (ext) {
      try {
        const reply = await ext.callbacks![prefix]!({ chatId: chat, userId, data });
        await api.answer(callbackId);
        if (reply) await api.send(chat, reply);
      } catch (err) {
        await api.answer(callbackId, errText(err).slice(0, 180));
      }
      return;
    }
    const cb = parseCallback(data);
    if (!cb) return api.answer(callbackId, 'Unknown action');
    try {
      switch (cb.kind) {
        case 'choose': {
          const sl = store.getShortlist(cb.shortlistId);
          const job = sl && store.getJob(sl.jobId);
          const candidate = sl?.candidates[cb.index];
          if (!sl || !job || !candidate) return api.answer(callbackId, 'That list is no longer available');
          if (chatOf(job) !== chat) return api.answer(callbackId, 'Not your job');
          jobs.provideInput(job.id, { action: 'confirm', profileId: candidate.profile.id });
          return api.answer(callbackId, `Chosen: ${candidate.profile.name}`);
        }
        case 'refine': {
          const job = store.getJob(cb.jobId);
          if (!job || chatOf(job) !== chat) return api.answer(callbackId, 'Not your job');
          if (job.status !== 'awaiting_input') return api.answer(callbackId, 'Not waiting for an answer right now');
          setState(chat, 'awaiting_refine_feedback');
          await api.answer(callbackId);
          await api.send(chat, 'What should be different? For example budget, deadline, skills, or location.');
          return;
        }
        case 'cancel': {
          const job = store.getJob(cb.jobId);
          if (!job || chatOf(job) !== chat) return api.answer(callbackId, 'Not your job');
          jobs.provideInput(job.id, { action: 'cancel' });
          return api.answer(callbackId, 'Cancelled');
        }
        case 'approve': {
          if (!mayDecide(chat, userId, cb.approvalId)) return api.answer(callbackId, isOperator(userId) ? 'Not available' : 'Not your job');
          const a = store.getApproval(cb.approvalId);
          if (!a || a.status !== 'pending') return api.answer(callbackId, 'Already settled');
          gate.resolve(cb.approvalId, { approved: true, by: isOperator(userId) ? userId : `hirer:${chat}` });
          if (messageId !== undefined) await api.clearKeyboard(chat, messageId);
          return api.answer(callbackId, a.action === 'accept' ? 'Releasing the payment' : 'Approved');
        }
        case 'deny': {
          if (!mayDecide(chat, userId, cb.approvalId)) return api.answer(callbackId, isOperator(userId) ? 'Not available' : 'Not your job');
          const a = store.getApproval(cb.approvalId);
          if (!a || a.status !== 'pending') return api.answer(callbackId, 'Already settled');
          if (messageId !== undefined) await api.clearKeyboard(chat, messageId);
          // The reason becomes the revision request (accept) or the cancellation note (book): ask for it.
          const by = isOperator(userId) ? userId : `hirer:${chat}`;
          setState(chat, `deny_note:${cb.approvalId}|${by}`);
          await api.answer(callbackId);
          const prompt = a.action === 'accept' ? 'What should the freelancer fix? Reply with a short note for them, or skip.' : 'Why? Reply with a short note, or skip.';
          await api.send(chat, prompt, [[{ text: 'Skip', data: callbackData({ kind: 'skip_note', approvalId: cb.approvalId }) }]]);
          return;
        }
        case 'skip_note': {
          if (!mayDecide(chat, userId, cb.approvalId)) return api.answer(callbackId, 'Not your job');
          if (messageId !== undefined) await api.clearKeyboard(chat, messageId);
          const state = getState(chat);
          const by = state.startsWith(`deny_note:${cb.approvalId}|`) ? state.split('|')[1] : isOperator(userId) ? userId : `hirer:${chat}`;
          await api.answer(callbackId);
          await api.send(chat, denyWithNote(chat, cb.approvalId, undefined, by || chat));
          return;
        }
        case 'pause': {
          if (!isOperator(userId)) return api.answer(callbackId, 'Operator only');
          policy.pause(cb.bookingId);
          if (messageId !== undefined) await api.clearKeyboard(chat, messageId);
          return api.answer(callbackId, 'Auto-replies paused');
        }
      }
    } catch (err) {
      // e.g. provideInput in the wrong state
      return api.answer(callbackId, errText(err).slice(0, 180));
    }
  }

  // ------------------------------------------------------ operator commands

  /** Returns the reply text (HTML). */
  async function onOperatorCommand(userId: string, command: string, args: string): Promise<string> {
    if (!isOperator(userId)) return 'Operator only.';
    const [id, ...rest] = args.trim().split(/\s+/);
    const text = rest.join(' ');
    try {
      switch (command) {
        case 'bookings':
          return bookingsList(store.listBookings({ status: ['pending_escrow', 'escrowed', 'awaiting_approval', 'placed', 'handoff', 'in_progress', 'delivered', 'in_revision'] }));
        case 'accept':
          if (!id) return 'Usage: /accept &lt;bookingId&gt;';
          return `Booking ${esc(id)}: ${esc((await bookings.accept(id)).status)}`;
        case 'revise':
          if (!id || !text) return 'Usage: /revise &lt;bookingId&gt; &lt;text&gt;';
          return `Booking ${esc(id)}: ${esc((await bookings.requestRevision(id, text)).status)}`;
        case 'cancelbooking':
          if (!id || !text) return 'Usage: /cancelbooking &lt;bookingId&gt; &lt;reason&gt;';
          return `Booking ${esc(id)}: ${esc((await bookings.cancel(id, text)).status)}`;
        default:
          return 'Unknown command.';
      }
    } catch (err) {
      return `Failed: ${esc(errText(err))}`;
    }
  }

  // ------------------------------------------------------------- bus events

  const status = new Map<string, { chat: string; messageId?: number; lastEdit: number; text: string; timer?: ReturnType<typeof setTimeout>; sending?: Promise<void> }>();
  const lastBookingStatus = new Map<string, string>();
  const lastEscrowStatus = new Map<string, string>();
  /** Where each open approval was asked, so the buttons can be removed once it is settled. */
  const approvalMessages = new Map<string, { chat: string; messageId: number }[]>();

  function progress(jobId: string, chat: string, message: string) {
    const text = `⏳ ${esc(message)}`;
    let s = status.get(jobId);
    if (!s) {
      s = { chat, lastEdit: now(), text };
      status.set(jobId, s);
      const entry = s;
      entry.sending = api.send(chat, text).then((id) => { entry.messageId = id; });
      return;
    }
    s.text = text;
    if (s.timer) return; // a trailing edit is already scheduled with the latest text
    const entry = s;
    const flush = async () => {
      entry.timer = undefined;
      await entry.sending;
      if (entry.messageId === undefined) return;
      entry.lastEdit = now();
      await api.edit(chat, entry.messageId, entry.text);
    };
    const wait = Math.max(0, EDIT_INTERVAL_MS - (now() - entry.lastEdit));
    entry.timer = setTimeout(() => void safe('status edit', flush), wait);
  }

  async function onShortlist(job: Job, shortlistId: string) {
    const chat = chatOf(job);
    if (!chat) return;
    const sl = store.getShortlist(shortlistId);
    if (!sl) return;
    const s = status.get(job.id);
    if (s?.timer) { clearTimeout(s.timer); s.timer = undefined; }
    status.delete(job.id);
    if (!sl.candidates.length) {
      setState(chat, 'idle');
      await api.send(chat, emptyShortlistText(sl), [[{ text: 'Different options', data: callbackData({ kind: 'refine', jobId: job.id }) }, { text: 'Cancel', data: callbackData({ kind: 'cancel', jobId: job.id }) }]]);
      return;
    }
    await api.send(chat, shortlistHeader(sl));
    for (const [i, c] of sl.candidates.entries()) {
      await api.send(chat, candidateCard(c, i), [[{ text: `Choose ${c.profile.name}`.slice(0, 40), data: callbackData({ kind: 'choose', shortlistId: sl.id, index: i }) }]]);
    }
    await api.send(chat, 'Not convinced?', [[{ text: 'Different options', data: callbackData({ kind: 'refine', jobId: job.id }) }, { text: 'Cancel', data: callbackData({ kind: 'cancel', jobId: job.id }) }]]);
  }

  async function onEvent(event: HaasEvent) {
    switch (event.type) {
      case 'job.progress': {
        const chat = chatOfJob(event.jobId);
        if (chat) progress(event.jobId, chat, event.message);
        return;
      }
      case 'shortlist.ready':
        return onShortlist(event.job, event.shortlist.id);
      case 'job.updated': {
        const chat = chatOf(event.job);
        if (chat && (event.job.status === 'completed' || event.job.status === 'failed')) {
          const s = status.get(event.job.id);
          if (s?.timer) clearTimeout(s.timer);
          status.delete(event.job.id);
          await api.send(chat, jobResult(event.job));
        }
        return;
      }
      case 'booking.updated': {
        const b = event.booking;
        if (lastBookingStatus.get(b.id) === b.status) return;
        lastBookingStatus.set(b.id, b.status);
        const chat = chatOfJob(b.jobId);
        const line = bookingStatusLine(b);
        if (chat && line) await api.send(chat, line);
        return;
      }
      case 'escrow.updated': {
        // HAAS funds and settles the escrow itself: the chat never sees it.
        if (config.ESCROW_AUTO_FUND) return;
        const e = event.escrow;
        if (lastEscrowStatus.get(e.id) === e.status) return;
        lastEscrowStatus.set(e.id, e.status);
        const chat = chatOfBooking(e.bookingId);
        if (!chat) return;
        if (e.status === 'awaiting_deposit') {
          if (e.payUrl) {
            try {
              await api.photo(chat, await QRCode.toBuffer(e.payUrl, { width: 480, margin: 2 }));
            } catch (err) {
              console.error('[telegram] QR failed:', errText(err));
            }
          }
          await api.send(chat, escrowInstructions(e, config.SOLANA_RPC_URL, e.payUrl ? `${publicUrl}/pay/${e.bookingId}` : undefined));
        } else {
          const line = escrowLine(e);
          if (line) await api.send(chat, line);
        }
        return;
      }
      case 'escrow.timeout': {
        if (config.ESCROW_AUTO_FUND) return;
        const chat = chatOfBooking(event.booking.id);
        if (chat) await api.send(chat, escrowTimeoutLine(event.kind, event.escrow));
        return;
      }
      case 'conversation.message': {
        const m = event.message;
        if (m.thread === 'hirer' && m.from === 'agent') {
          const chat = chatOfJob(m.jobId);
          if (!chat) return;
          if (m.bookingId) setState(chat, `relay_pending:${m.bookingId}`);
          mirror(chat, 'agent', m.text, m.jobId, m.bookingId);
          await api.send(chat, esc(m.text));
          return;
        }
        // mirror the freelancer conversation to the operator
        if (operatorId && m.thread === 'freelancer' && m.bookingId) {
          if (m.from === 'agent') {
            const paused = store.getBooking(m.bookingId)?.paused;
            await api.send(operatorId, `Auto-reply sent (${esc(m.bookingId)}):\n${esc(m.text)}`, paused ? undefined : [[{ text: 'Pause auto-replies', data: callbackData({ kind: 'pause', bookingId: m.bookingId }) }]]);
          } else if (m.from === 'freelancer') {
            await api.send(operatorId, `Freelancer wrote (${esc(m.bookingId)}):\n${esc(m.text)}`);
          }
        }
        return;
      }
      case 'approval.requested': {
        const a = event.approval;
        const job = a.jobId ? store.getJob(a.jobId) : null;
        const hirerChat = chatOf(job);
        const buttons = (approve: string, deny: string) => [[{ text: approve, data: callbackData({ kind: 'approve', approvalId: a.id }) }, { text: deny, data: callbackData({ kind: 'deny', approvalId: a.id }) }]];
        const sentTo: { chat: string; messageId: number }[] = [];
        // The hirer answers release and revision questions about their own job ("confirm before release").
        const hirer = hirerChat ? hirerApprovalRequest(a, a.bookingId ? store.getBooking(a.bookingId) : null) : null;
        if (hirerChat && hirer) {
          const id = await api.send(hirerChat, hirer.text, buttons(hirer.approve, hirer.deny));
          if (id !== undefined) sentTo.push({ chat: hirerChat, messageId: id });
        }
        // The operator sees every approval, once (an operator testing as the hirer gets the hirer's version).
        if (operatorId && !(hirer && hirerChat === operatorId)) {
          const id = await api.send(operatorId, approvalRequest(a, job), buttons('Approve', 'Deny'));
          if (id !== undefined) sentTo.push({ chat: operatorId, messageId: id });
        }
        if (sentTo.length) approvalMessages.set(a.id, sentTo);
        return;
      }
      case 'approval.resolved': {
        // First answer wins: take the buttons off every copy of the question.
        const copies = approvalMessages.get(event.approval.id) ?? [];
        approvalMessages.delete(event.approval.id);
        for (const c of copies) await api.clearKeyboard(c.chat, c.messageId);
        return;
      }
      case 'reputation.recorded': {
        const chat = chatOfJob(event.jobId);
        const line = reputationLine(event, cardano, event.workerId.split(':').pop());
        if (chat) await api.send(chat, line);
        if (operatorId && operatorId !== chat) await api.send(operatorId, `${line}\nBooking: <code>${esc(event.bookingId)}</code>`);
        return;
      }
      case 'verification.completed': {
        const chat = chatOfJob(event.booking.jobId);
        if (chat) await api.send(chat, verificationLine(event.booking, event.report));
        return;
      }
      case 'operator.attention': {
        if (!operatorId) return;
        await api.send(operatorId, `Needs you (${esc(event.source)}): ${esc(event.message)}${event.url ? `\n${esc(event.url)}` : ''}`);
        return;
      }
      default:
        return;
    }
  }

  return {
    onStart,
    onText,
    onCallback,
    onHirerCommand,
    onOperatorCommand,
    /** Subscribed to the bus: never throws. */
    onEvent: (event: HaasEvent) => { void safe(`event ${event.type}`, () => onEvent(event)); },
    dispose() {
      for (const s of status.values()) if (s.timer) clearTimeout(s.timer);
      status.clear();
    },
  };
}

function keyboard(buttons?: Button[][]): InlineKeyboard | undefined {
  if (!buttons?.length) return undefined;
  const kb = new InlineKeyboard();
  buttons.forEach((row, i) => {
    row.forEach((b) => kb.text(b.text, b.data));
    if (i < buttons.length - 1) kb.row();
  });
  return kb;
}

export const createTelegram: CreateTelegram = (deps) => {
  const { config, bus } = deps;
  let bot: Bot | undefined;
  let unsubscribe: (() => void) | undefined;
  let controller: ReturnType<typeof createController> | undefined;

  return {
    async start() {
      if (!config.TELEGRAM_BOT_TOKEN) {
        console.log('[telegram] Telegram disabled (TELEGRAM_BOT_TOKEN not set)');
        return;
      }
      const b = new Bot(config.TELEGRAM_BOT_TOKEN);
      bot = b;
      const log = (what: string, err: unknown) => console.error(`[telegram] ${what} failed:`, errText(err));

      const api: TgApi = {
        async send(chatId, text, buttons) {
          let last: number | undefined;
          const parts = chunk(text);
          for (const [i, part] of parts.entries()) {
            try {
              const msg = await b.api.sendMessage(chatId, part, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
                reply_markup: i === parts.length - 1 ? keyboard(buttons) : undefined,
              });
              last = msg.message_id;
            } catch (err) {
              log('send', err);
            }
          }
          return last;
        },
        async edit(chatId, messageId, text) {
          try {
            await b.api.editMessageText(chatId, messageId, chunk(text)[0] ?? text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          } catch (err) {
            if (!(err instanceof GrammyError && /not modified/i.test(err.description))) log('edit', err);
          }
        },
        async photo(chatId, png) {
          try { await b.api.sendPhoto(chatId, new InputFile(png, 'pay.png')); } catch (err) { log('photo', err); }
        },
        async answer(callbackId, text) {
          try { await b.api.answerCallbackQuery(callbackId, text ? { text } : undefined); } catch (err) { log('answerCallbackQuery', err); }
        },
        async clearKeyboard(chatId, messageId) {
          try { await b.api.editMessageReplyMarkup(chatId, messageId); } catch (err) { log('clear keyboard', err); }
        },
      };
      const c = createController(deps, api);
      controller = c;
      unsubscribe = bus.on(c.onEvent);

      b.command('start', (ctx) => c.onStart(String(ctx.chat.id)));
      for (const cmd of ['status', 'cancel', 'help']) {
        b.command(cmd, async (ctx) => api.send(String(ctx.chat.id), await c.onHirerCommand(String(ctx.chat.id), cmd)));
      }
      for (const { command: cmd } of OPERATOR_COMMANDS) {
        b.command(cmd, async (ctx) => {
          const reply = await c.onOperatorCommand(String(ctx.from?.id), cmd, ctx.match);
          await api.send(String(ctx.chat.id), reply);
        });
      }
      for (const ext of extensions) {
        for (const [cmd, handler] of Object.entries(ext.commands)) {
          b.command(cmd, async (ctx) => {
            const reply = await handler({ chatId: String(ctx.chat.id), userId: String(ctx.from?.id), args: ctx.match });
            if (reply) await api.send(String(ctx.chat.id), reply);
          });
        }
        ext.onStart?.((chatId, html, buttons) => api.send(chatId, html, buttons));
      }
      // The command menu: hirer commands for everyone, the operator's in their own chat.
      b.api.setMyCommands(HIRER_COMMANDS).catch((err) => log('setMyCommands', err));
      if (config.TELEGRAM_OPERATOR_ID) {
        b.api
          .setMyCommands([...HIRER_COMMANDS, ...OPERATOR_COMMANDS], { scope: { type: 'chat', chat_id: Number(config.TELEGRAM_OPERATOR_ID) } })
          .catch((err) => log('setMyCommands (operator)', err));
      }
      b.on('message:text', async (ctx) => {
        if (ctx.message.text.startsWith('/')) return;
        await c.onText(String(ctx.chat.id), ctx.message.text);
      });
      b.on('callback_query:data', async (ctx) => {
        const chat = ctx.chat?.id ?? ctx.from.id;
        await c.onCallback(String(chat), String(ctx.from.id), ctx.callbackQuery.id, ctx.callbackQuery.data, ctx.callbackQuery.message?.message_id);
      });
      b.catch((err) => console.error('[telegram] handler error:', errText(err.error)));

      // Long polling runs until stop(); start() returns once it is launched.
      void b
        .start({ onStart: (me) => console.log(`[telegram] polling as @${me.username}`) })
        .catch((err) => {
          if (err instanceof GrammyError && err.error_code === 409) {
            console.error('[telegram] 409: another process is polling this bot token (terminated by other getUpdates). Stop the other instance, or use a different token for development.');
          } else {
            console.error('[telegram] polling stopped:', errText(err));
          }
        });
    },

    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      for (const ext of extensions) ext.onStop?.();
      controller?.dispose();
      try { await bot?.stop(); } catch (err) { console.error('[telegram] stop failed:', errText(err)); }
      bot = undefined;
    },
  };
};
