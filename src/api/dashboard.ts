// REST + SSE API for the web dashboard (frontend/) and the iMessage bridge
// (messages/). Read endpoints serve the store; writes go through the same
// services the channels use, so state transitions and approvals stay uniform.

import { enrichBrief, looksOnSite } from '../agent/extract';
import { createIntake, type IntakeTurn } from '../agent/intake';
import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { newId, now } from '../domain/ids';
import type { DashboardApiDeps } from '../domain/ports';
import type { Brief, HaasEvent, UserInput } from '../domain/types';

// --------------------------------------------------------------- api tokens
// Bearer tokens so an external agent (e.g. Claude over MCP or plain HTTP) can
// use this API. Only a SHA-256 hash is stored; the secret is shown once.

interface ApiToken {
  id: string;
  name: string;
  hash: string;
  /** First characters of the secret, for recognising it in the list. */
  prefix: string;
  createdAt: number;
  lastUsedAt?: number;
  revoked?: boolean;
}

const TOKENS_KEY = 'api:tokens';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Last events kept for replay so the activity feed is not empty on page load. */
const BUFFER_SIZE = 200;
const HEARTBEAT_MS = 25_000;

export function mountDashboard(app: Express, deps: DashboardApiDeps): { stop(): void } {
  const { jobs, bookings, gate, registry, store, bus, config } = deps;

  let seq = 0;
  const buffer: { seq: number; at: number; event: HaasEvent }[] = [];
  const unsubscribe = bus.on((event) => {
    buffer.push({ seq: ++seq, at: now(), event });
    if (buffer.length > BUFFER_SIZE) buffer.shift();
  });

  const readTokens = (): ApiToken[] => {
    try {
      return JSON.parse(store.getKv(TOKENS_KEY) ?? '[]') as ApiToken[];
    } catch {
      return [];
    }
  };
  const writeTokens = (tokens: ApiToken[]) => store.setKv(TOKENS_KEY, JSON.stringify(tokens));

  // The dashboard runs on another origin (Next dev server). Browsers may call /api only from
  // localhost or DASHBOARD_ORIGINS, so a page the operator happens to visit cannot drive it.
  // A Bearer token, when sent, must be a live one. Without a token only this machine is trusted
  // (the dashboard, the iMessage bridge, curl); anything else needs a token.
  const extraOrigins = new Set((config.DASHBOARD_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean));
  const allowedOrigin = (origin: string): boolean => {
    if (extraOrigins.has(origin)) return true;
    try {
      const host = new URL(origin).hostname;
      return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    } catch {
      return false;
    }
  };
  const isLoopback = (addr: string | undefined): boolean => !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');

  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      if (!allowedOrigin(origin)) return res.status(403).json({ error: `origin ${origin} is not allowed (set DASHBOARD_ORIGINS)` });
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ') && !isLoopback(req.socket.remoteAddress)) {
      return res.status(401).json({ error: 'a Bearer token is required from other machines (POST /api/tokens on the HAAS host)' });
    }
    if (auth?.startsWith('Bearer ')) {
      const hash = sha256(auth.slice('Bearer '.length).trim());
      const tokens = readTokens();
      const token = tokens.find((t) => t.hash === hash && !t.revoked);
      if (!token) return res.status(401).json({ error: 'invalid or revoked token' });
      token.lastUsedAt = now();
      writeTokens(tokens);
    }
    next();
  });

  const fail = (res: Response, err: unknown, status = 400) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(status === 400 && /not found/i.test(message) ? 404 : status).json({ error: message });
  };

  const jobsNewestFirst = () => store.listJobs().slice().reverse();

  app.get('/api/overview', (_req, res) => {
    const all = store.listJobs();
    const open = (s: string) => all.filter((j) => j.status === s).length;
    res.json({
      jobs: {
        total: all.length,
        running: open('running'),
        awaitingInput: open('awaiting_input'),
        awaitingPayment: open('awaiting_payment'),
        completed: open('completed'),
        failed: open('failed'),
      },
      pendingApprovals: store.listApprovals({ status: 'pending' }).length,
      openBookings: store.listBookings().filter((b) => !['completed', 'cancelled', 'refunded'].includes(b.status)).length,
      sources: (() => {
        const active = new Set(registry.enabled().map((src) => src.name));
        return registry.all().map((src) => ({ name: src.name, kind: src.kind, enabled: active.has(src.name) }));
      })(),
    });
  });

  app.get('/api/jobs', (_req, res) => {
    res.json(jobsNewestFirst());
  });

  app.post('/api/jobs', (req, res) => {
    const partial = req.body?.brief as Partial<Brief> | undefined;
    if (!partial || typeof partial.task !== 'string' || !partial.task.trim()) return fail(res, 'brief.task is required');
    // Read pay, hours, deadline, place, day and time from the text (an iMessage is just a sentence).
    const task = partial.task.trim();
    const brief: Brief = enrichBrief({ ...partial, task, skills: partial.skills ?? [], remoteOk: partial.remoteOk ?? !looksOnSite(task) });
    const clientRef = typeof req.body?.clientRef === 'string' && req.body.clientRef.trim() ? req.body.clientRef.trim() : 'dashboard';
    const job = jobs.startJob({ brief, client: 'local', clientRef });
    res.status(201).json(job);
  });

  // Conversation in, search out: the iMessage bridge sends every text here. The intake model reads the
  // whole conversation (task, skills, budget, place, day/time, hours), asks a short question when
  // something important is missing, and starts the search once it understands the request.
  const intake = createIntake({ config });
  const convKey = (ref: string) => `dash:intake:${ref}`;
  app.post('/api/converse', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return fail(res, 'text is required');
    const ref = typeof req.body?.ref === 'string' && req.body.ref.trim() ? req.body.ref.trim() : 'imessage';
    let history: IntakeTurn[] = [];
    try {
      history = JSON.parse(store.getKv(convKey(ref)) ?? '[]') as IntakeTurn[];
    } catch {
      history = [];
    }
    history.push({ from: 'hirer', text });
    try {
      const result = await intake.next(history);
      if (result.kind === 'ask') {
        history.push({ from: 'agent', text: result.text });
        store.setKv(convKey(ref), JSON.stringify(history.slice(-12)));
        return res.json({ reply: result.text });
      }
      store.setKv(convKey(ref), '[]');
      const brief = enrichBrief(result.brief);
      const job = jobs.startJob({ brief, client: 'local', clientRef: ref });
      return res.status(201).json({ reply: result.summary, job });
    } catch (err) {
      return fail(res, err, 500);
    }
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) return fail(res, `Job not found: ${req.params.id}`, 404);
    const shortlist = (job.shortlistId && store.getShortlist(job.shortlistId)) || store.latestShortlist(job.id);
    const jobBookings = store.listBookings({ jobId: job.id });
    res.json({
      job,
      shortlist,
      bookings: jobBookings,
      escrows: jobBookings.map((b) => store.getEscrowByBooking(b.id)).filter(Boolean),
      messages: store.listMessages({ jobId: job.id }),
    });
  });

  app.post('/api/jobs/:id/input', (req, res) => {
    const input = req.body as UserInput;
    if (!input || !['confirm', 'refine', 'cancel'].includes(input.action)) return fail(res, 'action must be confirm, refine or cancel');
    if (input.action === 'confirm' && (typeof input.profileId !== 'string' || !input.profileId.trim()))
      return fail(res, 'profileId is required to confirm a candidate');
    if (input.action === 'refine' && (typeof input.feedback !== 'string' || !input.feedback.trim()))
      return fail(res, 'feedback is required to refine the search');
    try {
      res.json(jobs.provideInput(req.params.id, input));
    } catch (err) {
      fail(res, err);
    }
  });

  // Records a hirer message; when the job is at a check-in the text doubles as
  // refine feedback, which is what a person typing at that point means.
  app.post('/api/jobs/:id/message', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return fail(res, 'text is required');
    const job = store.getJob(req.params.id);
    if (!job) return fail(res, `Job not found: ${req.params.id}`, 404);
    const message = { id: newId('msg'), jobId: job.id, thread: 'hirer' as const, from: 'hirer' as const, text, createdAt: now() };
    store.addMessage(message);
    bus.emit({ type: 'conversation.message', message });
    if (job.status === 'awaiting_input') {
      try {
        return res.json({ message, job: jobs.provideInput(job.id, { action: 'refine', feedback: text }) });
      } catch (err) {
        return fail(res, err);
      }
    }
    res.json({ message, job });
  });

  app.get('/api/candidates', (_req, res) => {
    const out = [];
    for (const job of jobsNewestFirst()) {
      const sl = (job.shortlistId && store.getShortlist(job.shortlistId)) || store.latestShortlist(job.id);
      if (!sl) continue;
      for (const candidate of sl.candidates) {
        out.push({ jobId: job.id, jobStatus: job.status, task: job.brief.task, round: sl.round, selected: job.selectedProfileId === candidate.profile.id, candidate });
      }
    }
    res.json(out);
  });

  app.get('/api/approvals', (req, res) => {
    const status = req.query.status as 'pending' | 'approved' | 'denied' | 'expired' | undefined;
    const list = store.listApprovals(status ? { status } : {});
    res.json(list.slice().reverse());
  });

  app.post('/api/approvals/:id/decide', (req, res) => {
    const approved = req.body?.approved;
    if (typeof approved !== 'boolean') return fail(res, 'approved must be a boolean');
    const approval = store.getApproval(req.params.id);
    if (!approval) return fail(res, `Approval not found: ${req.params.id}`, 404);
    if (approval.status !== 'pending') return fail(res, `Approval is already ${approval.status}`, 409);
    gate.resolve(approval.id, { approved, by: typeof req.body?.by === 'string' ? req.body.by : 'dashboard', note: req.body?.note });
    res.json(store.getApproval(approval.id));
  });

  app.get('/api/bookings', (_req, res) => {
    res.json(store.listBookings().slice().reverse());
  });

  app.post('/api/bookings/:id/accept', async (req, res) => {
    try {
      res.json(await bookings.accept(req.params.id));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/messages', (req, res) => {
    const { jobId, bookingId, thread } = req.query as Record<string, string | undefined>;
    res.json(store.listMessages({ jobId, bookingId, thread: thread === 'hirer' || thread === 'freelancer' ? thread : undefined }));
  });

  // ------------------------------------------------------------- tokens

  const publicToken = ({ hash: _hash, ...rest }: ApiToken) => rest;

  app.get('/api/tokens', (_req, res) => {
    res.json(readTokens().map(publicToken));
  });

  app.post('/api/tokens', (req, res) => {
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : 'unnamed';
    const secret = `hr_live_${randomBytes(24).toString('hex')}`;
    const token: ApiToken = { id: newId('tok'), name, hash: sha256(secret), prefix: secret.slice(0, 15), createdAt: now() };
    writeTokens([...readTokens(), token]);
    // The secret appears in this response only; afterwards only the hash exists.
    res.status(201).json({ ...publicToken(token), secret });
  });

  app.post('/api/tokens/:id/revoke', (req, res) => {
    const tokens = readTokens();
    const token = tokens.find((t) => t.id === req.params.id);
    if (!token) return fail(res, `Token not found: ${req.params.id}`, 404);
    token.revoked = true;
    writeTokens(tokens);
    res.json(publicToken(token));
  });

  // ------------------------------------------------------------- history
  // Persistent record composed from the store, unlike /api/activity which only
  // holds this process's recent events: who was hired and why, and every step
  // each task went through.

  app.get('/api/history', (_req, res) => {
    const allJobs = store.listJobs();
    const events: { at: number; jobId?: string; task?: string; kind: string; title: string; detail?: string }[] = [];
    const hires = [];

    for (const job of allJobs) {
      const task = job.brief.task;
      events.push({ at: job.createdAt, jobId: job.id, task, kind: 'task', title: 'Task started', detail: task });
      for (const sl of store.listShortlists(job.id)) {
        const names = sl.candidates.map((c) => `${c.profile.name} (${Math.round(c.score)})`).join(', ');
        events.push({
          at: sl.createdAt,
          jobId: job.id,
          task,
          kind: 'shortlist',
          title: `Shortlist, round ${sl.round}: ${sl.candidates.length} candidate${sl.candidates.length === 1 ? '' : 's'}`,
          detail: names || 'nobody fit the brief',
        });
      }
      if ((job.status === 'completed' || job.status === 'failed') && (job.result || job.error)) {
        events.push({
          at: job.updatedAt,
          jobId: job.id,
          task,
          kind: job.status === 'failed' ? 'failed' : 'done',
          title: job.status === 'failed' ? 'Task failed' : 'Task finished',
          detail: job.result?.summary ?? job.error,
        });
      }
    }

    for (const booking of store.listBookings()) {
      const job = store.getJob(booking.jobId);
      const task = job?.brief.task;
      const shortlist = (job?.shortlistId && store.getShortlist(job.shortlistId)) || (job && store.latestShortlist(job.id)) || null;
      const candidate = shortlist?.candidates.find((c) => c.profile.id === booking.profileId);
      const profile = candidate?.profile ?? store.getProfile(booking.profileId);
      events.push({
        at: booking.createdAt,
        jobId: booking.jobId,
        task,
        kind: 'hire',
        title: `Hired ${profile?.name ?? booking.profileId} on ${booking.platform} for $${booking.priceUsd}`,
        detail: candidate?.reason,
      });
      hires.push({
        bookingId: booking.id,
        jobId: booking.jobId,
        task,
        status: booking.status,
        priceUsd: booking.priceUsd,
        platform: booking.platform,
        url: booking.url ?? profile?.url,
        name: profile?.name ?? booking.profileId,
        headline: profile?.headline,
        rating: profile?.rating,
        reviewCount: profile?.reviewCount,
        score: candidate ? Math.round(candidate.score) : undefined,
        reason: candidate?.reason,
        hiredAt: booking.createdAt,
      });
    }

    for (const approval of store.listApprovals()) {
      const task = approval.jobId ? store.getJob(approval.jobId)?.brief.task : undefined;
      events.push({
        at: approval.createdAt,
        jobId: approval.jobId,
        task,
        kind: 'approval',
        title: `Approval requested: ${approval.action.replaceAll('_', ' ')}`,
        detail: approval.summary,
      });
      if (approval.status !== 'pending' && approval.decidedAt) {
        events.push({
          at: approval.decidedAt,
          jobId: approval.jobId,
          task,
          kind: approval.status === 'approved' ? 'approved' : 'denied',
          title: `Approval ${approval.status}${approval.decidedBy ? ` by ${approval.decidedBy}` : ''}`,
          detail: approval.summary,
        });
      }
    }

    events.sort((a, b) => b.at - a.at);
    hires.sort((a, b) => b.hiredAt - a.hiredAt);
    res.json({ hires, events });
  });

  app.get('/api/activity', (req, res) => {
    const since = Number(req.query.since ?? 0);
    res.json(buffer.filter((e) => e.seq > since));
  });

  // Live events. Replays the buffer past `since` (or Last-Event-ID), then streams.
  app.get('/api/events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');

    const send = (entry: { seq: number; at: number; event: HaasEvent }) =>
      res.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`);

    const since = Number(req.query.since ?? req.headers['last-event-id'] ?? 0);
    for (const entry of buffer) if (entry.seq > since) send(entry);

    const off = bus.on((event) => send(buffer[buffer.length - 1] ?? { seq, at: now(), event }));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      off();
    });
  });

  return { stop: unsubscribe };
}
