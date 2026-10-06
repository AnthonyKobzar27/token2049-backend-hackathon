// Worker-facing web page, no app needed: /w/:token shows the task, a Claim button and the
// result form. Forms post back and redirect; the same routes answer JSON for scripts.

import express, { type Express, type Request, type Response } from 'express';
import type { BountyBoard, Outcome } from './board';
import { workerDistanceKm } from '../sources/bounty';
import { rewardLabel } from './spec';
import type { Bounty, ResultField, Worker } from './types';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const INPUT_TYPE: Record<ResultField['type'], string> = { text: 'text', date: 'date', time: 'time', number: 'number', url: 'url', phone: 'tel' };

function clock(ms: number, worker: Worker): string {
  const timeZone = worker.location.country === 'SG' ? 'Asia/Singapore' : 'UTC';
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short' }).format(ms) + (timeZone === 'UTC' ? ' UTC' : '');
}

const STATUS_LINE: Record<Bounty['status'], string> = {
  posted: 'Open: first to claim gets it',
  claimed: 'Claimed',
  submitted: 'Submitted: being checked',
  verified: 'Accepted: payout on its way',
  paid: 'Paid',
  rejected: 'Not accepted',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export function renderWorkerPage(bounty: Bounty, worker: Worker, token: string, opts: { flash?: string; error?: string; km?: number } = {}): string {
  const mine = bounty.workerId === worker.id;
  const taken = bounty.workerId !== undefined && !mine;
  const base = `/w/${encodeURIComponent(token)}`;
  const parts: string[] = [];

  parts.push(`<header><span class="pill s-${esc(bounty.status)}">${esc(taken && bounty.status !== 'expired' && bounty.status !== 'cancelled' ? 'Taken by someone else' : STATUS_LINE[bounty.status])}</span><span class="reward">${esc(rewardLabel(bounty.reward))}</span></header>`);
  parts.push(`<h1>${esc(bounty.spec.title)}</h1>`);
  const facts = [
    `~${bounty.spec.estMinutes} min`,
    bounty.spec.place ? `${bounty.spec.place.name}${opts.km !== undefined ? ` (${opts.km < 1 ? opts.km.toFixed(1) : Math.round(opts.km)} km away)` : ''}` : undefined,
    bounty.status === 'posted' ? `claim by ${clock(bounty.claimBy, worker)}` : undefined,
    mine && bounty.status === 'claimed' && bounty.submitBy ? `submit by ${clock(bounty.submitBy, worker)}` : undefined,
    `code ${bounty.code}`,
  ].filter(Boolean);
  parts.push(`<p class="facts">${facts.map(esc).join(' · ')}</p>`);
  if (opts.flash) parts.push(`<p class="flash">${esc(opts.flash)}</p>`);
  if (opts.error) parts.push(`<p class="error">${esc(opts.error)}</p>`);
  if (mine && bounty.feedback && bounty.status === 'claimed') parts.push(`<p class="error"><b>Please fix:</b> ${esc(bounty.feedback)}</p>`);

  if (!taken) parts.push(`<section><h2>What to do</h2><p class="pre">${esc(bounty.spec.instructions)}</p></section>`);

  if (bounty.status === 'posted' && !taken) {
    parts.push(`<form method="post" action="${base}/claim"><button class="primary" type="submit">Claim this task</button></form>`);
  }

  if (mine && bounty.status === 'claimed') {
    const fields = bounty.spec.fields
      .map(
        (f) =>
          `<label>${esc(f.label)}${f.required ? ' <i>*</i>' : ''}<input name="${esc(f.key)}" type="${INPUT_TYPE[f.type]}"${f.required ? ' required' : ''}${f.hint ? ` placeholder="${esc(f.hint)}"` : ''} value="${esc(bounty.result?.data[f.key] ?? '')}"></label>`,
      )
      .join('');
    parts.push(
      `<section><h2>Your result</h2><form method="post" action="${base}/submit">${fields}` +
        `<label>Notes<textarea name="notes" rows="3" placeholder="Anything the client should know"></textarea></label>` +
        `<label>Photo link (optional)<input name="photoUrl" type="url" placeholder="https://"></label>` +
        `<button class="primary" type="submit">Submit result</button></form></section>`,
    );
  }

  if (mine && bounty.result && bounty.status !== 'claimed') {
    const rows = bounty.spec.fields.filter((f) => bounty.result!.data[f.key]).map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(bounty.result!.data[f.key])}</dd>`).join('');
    parts.push(`<section><h2>You submitted</h2><p><b>${esc(bounty.result.summary)}</b></p><dl>${rows}</dl>${bounty.result.notes ? `<p class="pre">${esc(bounty.result.notes)}</p>` : ''}</section>`);
  }
  if (mine && bounty.status === 'paid' && bounty.payout) {
    parts.push(`<p class="flash">Paid ${esc(rewardLabel(bounty.reward))}${bounty.payout.address ? ` to ${esc(bounty.payout.address)}` : ''} on ${esc(bounty.payout.chain)}.</p>`);
  }

  if (mine && ['claimed', 'submitted'].includes(bounty.status)) {
    const thread = bounty.messages.map((m) => `<li class="${m.from}"><b>${m.from === 'worker' ? 'You' : 'HAAS'}:</b> ${esc(m.text)}</li>`).join('');
    parts.push(`<section><h2>Questions</h2>${thread ? `<ul class="thread">${thread}</ul>` : ''}<form method="post" action="${base}/message"><label>Ask the client<textarea name="text" rows="2" required></textarea></label><button type="submit">Send</button></form></section>`);
  }

  const refresh = bounty.status === 'posted' || bounty.status === 'submitted' || bounty.status === 'verified' ? '<meta http-equiv="refresh" content="15">' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh}<title>${esc(bounty.spec.title)}</title><style>${CSS}</style></head><body><main><p class="who">HAAS task for ${esc(worker.name)}</p>${parts.join('')}</main></body></html>`;
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--ink:#1b1b1b;--muted:#666;--accent:#0b6e4f;--err:#b3261e;--line:#e3e1dc}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1e;--ink:#eee;--muted:#aaa;--accent:#3ccf91;--err:#ff8a80;--line:#333}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:34rem;margin:0 auto;padding:1rem 1rem 3rem}
.who{color:var(--muted);font-size:.85rem;margin:0 0 .5rem}
header{display:flex;justify-content:space-between;align-items:center;gap:.5rem}
.pill{font-size:.8rem;padding:.2rem .6rem;border-radius:1rem;background:var(--line)}
.s-posted{background:#ffe9a8;color:#1b1b1b}.s-paid,.s-verified{background:#c9f2dc;color:#1b1b1b}
.reward{font-weight:700;font-size:1.3rem;color:var(--accent)}
h1{font-size:1.3rem;margin:.6rem 0 .3rem}h2{font-size:1rem;margin:0 0 .5rem}
.facts{color:var(--muted);margin:0 0 1rem}
section{background:var(--card);border:1px solid var(--line);border-radius:.8rem;padding:1rem;margin:0 0 1rem}
.pre{white-space:pre-wrap;margin:0}
label{display:block;margin:0 0 .8rem;font-weight:600;font-size:.9rem}
label i{color:var(--err);font-style:normal}
input,textarea{display:block;width:100%;margin-top:.3rem;padding:.7rem;font:inherit;border:1px solid var(--line);border-radius:.5rem;background:var(--bg);color:var(--ink)}
button{font:inherit;padding:.7rem 1rem;border-radius:.6rem;border:1px solid var(--line);background:var(--card);color:var(--ink)}
button.primary{width:100%;padding:1rem;border:0;background:var(--accent);color:#fff;font-weight:700;font-size:1.05rem;margin-bottom:1rem}
.flash{background:#c9f2dc;color:#1b1b1b;padding:.7rem;border-radius:.5rem}
.error{background:#fde2df;color:#5c0f0a;padding:.7rem;border-radius:.5rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.2rem .8rem;margin:.5rem 0}dt{color:var(--muted)}dd{margin:0}
.thread{list-style:none;padding:0;margin:0 0 .8rem}.thread li{margin:0 0 .3rem}
`;

const wantsJson = (req: Request) => req.is('application/json') === 'application/json' || (req.get('accept') ?? '').includes('application/json');

/** Public, secret-free view of a bounty. */
export function publicBounty(b: Bounty) {
  return {
    id: b.id,
    code: b.code,
    status: b.status,
    title: b.spec.title,
    reward: b.reward,
    rewardUsd: b.rewardUsd,
    claimBy: b.claimBy,
    submitBy: b.submitBy,
    fields: b.spec.fields,
    ...(b.result && { result: { summary: b.result.summary, data: b.result.data, ...(b.result.notes && { notes: b.result.notes }), ...(b.result.photoUrl && { photoUrl: b.result.photoUrl }) } }),
    ...(b.reason && { reason: b.reason }),
  };
}

export function mountWorkerPages(app: Express, deps: { board: BountyBoard; onChange?: (bounty: Bounty) => void }): void {
  const { board } = deps;
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '64kb' }));
  router.use(express.json({ limit: '64kb' }));

  const resolve = (req: Request, res: Response) => {
    const found = board.byToken(String(req.params.token ?? ''));
    if (!found) {
      res.status(404).type('text/plain').send('This link is not valid.');
      return null;
    }
    return found;
  };

  const page = (res: Response, token: string, opts: { flash?: string; error?: string; status?: number } = {}) => {
    const found = board.byToken(token)!;
    res
      .status(opts.status ?? 200)
      .type('html')
      .set('Cache-Control', 'no-store')
      .set('Referrer-Policy', 'no-referrer')
      .send(renderWorkerPage(found.bounty, found.worker, token, { ...opts, km: workerDistanceKm(board, found.worker.id, found.bounty) }));
  };

  const reply = (req: Request, res: Response, token: string, out: Outcome, flash: string) => {
    if (out.ok) deps.onChange?.(out.bounty);
    if (wantsJson(req)) {
      res.status(out.ok ? 200 : 409).json(out.ok ? { ok: true, bounty: publicBounty(out.bounty) } : { ok: false, error: out.error });
      return;
    }
    if (out.ok) res.redirect(303, `/w/${encodeURIComponent(token)}?m=${encodeURIComponent(flash)}`);
    else page(res, token, { error: out.error, status: 409 });
  };

  router.get('/w/:token', (req, res) => {
    if (!resolve(req, res)) return;
    const token = String(req.params.token);
    if (wantsJson(req)) {
      const { bounty } = board.byToken(token)!;
      res.json(publicBounty(bounty));
      return;
    }
    const m = typeof req.query.m === 'string' ? req.query.m.slice(0, 200) : undefined;
    page(res, token, { flash: m });
  });

  router.post('/w/:token/claim', (req, res) => {
    const found = resolve(req, res);
    if (!found) return;
    reply(req, res, String(req.params.token), board.claim(found.bounty.id, found.worker.id), 'Claimed. It is yours: do the task, then submit the result below.');
  });

  router.post('/w/:token/submit', (req, res) => {
    const found = resolve(req, res);
    if (!found) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields = (typeof body.fields === 'object' && body.fields !== null ? body.fields : body) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    reply(req, res, String(req.params.token), board.submit(found.bounty.id, found.worker.id, { fields, notes: str(body.notes), photoUrl: str(body.photoUrl) }), 'Submitted. Thanks! You are paid once it is checked.');
  });

  router.post('/w/:token/message', (req, res) => {
    const found = resolve(req, res);
    if (!found) return;
    const text = String((req.body as Record<string, unknown> | undefined)?.text ?? '').trim();
    const out: Outcome =
      found.bounty.workerId !== found.worker.id
        ? { ok: false, error: 'Claim the task first' }
        : !text
          ? { ok: false, error: 'Write a message first' }
          : { ok: true, bounty: board.addMessage(found.bounty.id, 'worker', text)! };
    reply(req, res, String(req.params.token), out, 'Sent. The answer will show up here.');
  });

  router.get('/bounty/:id', (req, res) => {
    const b = board.get(String(req.params.id));
    if (!b) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(publicBounty(b));
  });

  router.get('/bounty/workers/:id', (req, res) => {
    const w = board.getWorker(String(req.params.id));
    if (!w) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ id: w.id, name: w.name, handle: w.handle, city: w.location.city, area: w.location.area, skills: w.skills, rating: w.rating, completed: w.completed, verified: w.verified });
  });

  app.use(router);
}
