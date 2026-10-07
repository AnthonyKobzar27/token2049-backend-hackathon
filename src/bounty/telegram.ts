// Worker commands in the existing Telegram bot, separate from the hirer flow:
//   /link <code>      connect this chat to a registered worker
//   /tasks            list tasks offered to me
//   /claim <code>     claim a task (first claim wins)
//   /submit <code> key=value key=value … | notes
//   /ask <code> <text>  ask the client a question

import { esc } from '../channels/format';
import type { ExtensionSend, TelegramExtension } from '../channels/telegram';
import type { BountyBoard } from './board';
import { submitExample } from './notifier';
import { rewardLabel } from './spec';
import type { Bounty, Worker } from './types';

export interface WorkerCommandContext {
  chatId: string;
  args: string;
}

/** Parses "date=2026-10-08 time=15:00 reference=88 213 | called at 2pm" into fields and notes. */
export function parseSubmitArgs(text: string): { fields: Record<string, string>; notes?: string; photoUrl?: string } {
  const [head = '', ...rest] = text.split('|');
  const fields: Record<string, string> = {};
  for (const m of head.matchAll(/([a-z][a-z0-9_]*)=(.*?)(?=\s+[a-z][a-z0-9_]*=|$)/gi)) fields[m[1]!.toLowerCase()] = m[2]!.trim();
  const notes = rest.join('|').trim() || fields.notes;
  const photoUrl = fields.photo;
  delete fields.notes;
  delete fields.photo;
  return { fields, ...(notes && { notes }), ...(photoUrl && { photoUrl }) };
}

export function createWorkerCommands(board: BountyBoard) {
  const offered = (w: Worker) => board.list({ status: ['posted', 'claimed', 'submitted'] }).filter((b) => b.offers.some((o) => o.workerId === w.id) && (b.status === 'posted' || b.workerId === w.id));
  const line = (b: Bounty) => `<b>${esc(b.code)}</b> ${esc(b.spec.title)} (${esc(b.status)})`;

  function find(w: Worker, code: string): Bounty | string {
    const b = board.byCode(code.trim());
    if (!b || !b.offers.some((o) => o.workerId === w.id)) return `No task ${esc(code)} for you. Send /tasks to see yours.`;
    return b;
  }

  /** Returns the HTML reply, or undefined when the command is not for workers. */
  async function handle(command: string, ctx: WorkerCommandContext): Promise<string | undefined> {
    const args = ctx.args.trim();
    if (command === 'link') {
      if (!args) return 'Usage: /link &lt;code&gt; (your code is in your welcome message)';
      const w = board.linkTelegram(args, ctx.chatId);
      return w ? `Hi ${esc(w.name)}, you will get tasks here. Send /tasks any time.` : 'That code is not known.';
    }
    const w = board.workerByTelegram(ctx.chatId);
    if (!w) return 'This chat is not linked to a worker. Send /link &lt;code&gt; first.';
    const [code = '', ...restWords] = args.split(/\s+/);
    const rest = args.slice(code.length).trim();

    switch (command) {
      case 'tasks': {
        const list = offered(w);
        return list.length ? list.map(line).join('\n') : 'No open tasks for you right now.';
      }
      case 'claim': {
        if (!code) return 'Usage: /claim &lt;code&gt;';
        const b = find(w, code);
        if (typeof b === 'string') return b;
        const res = board.claim(b.id, w.id);
        if (!res.ok) return esc(res.error);
        const token = res.bounty.offers.find((o) => o.workerId === w.id)!.token;
        return [
          `<b>It's yours:</b> ${esc(res.bounty.spec.title)}`,
          esc(res.bounty.spec.instructions),
          `Submit here: ${esc(board.pageUrl(token))}`,
          `or: <code>/submit ${esc(res.bounty.code)} ${esc(submitExample(res.bounty))}</code>`,
        ].join('\n\n');
      }
      case 'submit': {
        if (!code || !restWords.length) return 'Usage: /submit &lt;code&gt; key=value … | notes';
        const b = find(w, code);
        if (typeof b === 'string') return b;
        const parsed = parseSubmitArgs(rest);
        const res = board.submit(b.id, w.id, parsed);
        if (!res.ok) return `Not submitted: ${esc(res.error)}\nExpected: <code>/submit ${esc(b.code)} ${esc(submitExample(b))}</code>`;
        return `Submitted: <b>${esc(res.bounty.result!.summary)}</b>\nYou get ${esc(rewardLabel(res.bounty.reward))} once it is checked.`;
      }
      case 'ask': {
        if (!code || !rest) return 'Usage: /ask &lt;code&gt; &lt;question&gt;';
        const b = find(w, code);
        if (typeof b === 'string') return b;
        if (b.workerId !== w.id) return 'Claim the task first.';
        board.addMessage(b.id, 'worker', rest);
        return 'Sent to the client. The answer comes back here.';
      }
      default:
        return undefined;
    }
  }

  return { handle, commands: ['link', 'tasks', 'claim', 'submit', 'ask'] as const };
}

/** Plugs the worker commands (and the worker notifier's sender) into the running Telegram bot. */
export function workerTelegramExtension(board: BountyBoard, bindSend?: (send: ExtensionSend | undefined) => void): TelegramExtension {
  const cmds = createWorkerCommands(board);
  return {
    commands: Object.fromEntries(cmds.commands.map((c) => [c, (ctx: WorkerCommandContext) => cmds.handle(c, ctx)])),
    // The "Claim <code>" button on an offer: k:<code>.
    callbacks: { k: (ctx) => cmds.handle('claim', { chatId: ctx.chatId, args: ctx.data.slice(2) }) },
    onStart: (send) => bindSend?.(send),
    onStop: () => bindSend?.(undefined),
  };
}
