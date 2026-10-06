import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy';
import QRCode from 'qrcode';
import { createIntake, type Intake, type IntakeTurn } from '../agent/intake';
import { newId, now } from '../domain/ids';
import type { CreateTelegram, TelegramDeps } from '../domain/ports';
import type { HaasEvent, Job } from '../domain/types';
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
  escrowLine,
  jobResult,
  parseCallback,
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

const EDIT_INTERVAL_MS = 1500;
const START_TEXT = [
  '<b>HAAS</b>: Human as a Service, an open router for freelancers.',
  'Tell me what you need done. I search several freelancer platforms, rank the best fits with reasons, and check with you before anything is booked.',
  'Your budget is held in escrow, and afterwards I keep you and the freelancer informed.',
].join('\n');

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** All behaviour, independent of grammY. */
export function createController(deps: TelegramDeps, api: TgApi, intakeOverride?: Intake) {
  const { jobs, bookings, gate, policy, store, config } = deps;
  const intake = intakeOverride ?? createIntake({ config });
  const operatorId = config.TELEGRAM_OPERATOR_ID;
  const isOperator = (userId: string | number | undefined) => operatorId !== undefined && String(userId) === operatorId;

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

  async function onText(chat: string, text: string) {
    const state = getState(chat);

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

  async function onCallback(chat: string, userId: string, callbackId: string, data: string, messageId?: number) {
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
        case 'approve':
        case 'deny': {
          if (!isOperator(userId)) return api.answer(callbackId, 'Operator only');
          gate.resolve(cb.approvalId, { approved: cb.kind === 'approve', by: userId });
          if (messageId !== undefined) await api.clearKeyboard(chat, messageId);
          return api.answer(callbackId, cb.kind === 'approve' ? 'Approved' : 'Denied');
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
          await api.send(chat, escrowInstructions(e, config.SOLANA_RPC_URL));
        } else {
          const line = escrowLine(e);
          if (line) await api.send(chat, line);
        }
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
        if (!operatorId) return;
        const a = event.approval;
        await api.send(operatorId, approvalRequest(a), [[{ text: 'Approve', data: callbackData({ kind: 'approve', approvalId: a.id }) }, { text: 'Deny', data: callbackData({ kind: 'deny', approvalId: a.id }) }]]);
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
      for (const cmd of ['bookings', 'accept', 'revise', 'cancelbooking']) {
        b.command(cmd, async (ctx) => {
          const reply = await c.onOperatorCommand(String(ctx.from?.id), cmd, ctx.match);
          await api.send(String(ctx.chat.id), reply);
        });
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
      controller?.dispose();
      try { await bot?.stop(); } catch (err) { console.error('[telegram] stop failed:', errText(err)); }
      bot = undefined;
    },
  };
};
