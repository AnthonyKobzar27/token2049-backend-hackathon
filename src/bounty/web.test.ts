import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { setupBoard } from './testkit';
import { mountWorkerPages } from './web';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function serve() {
  const h = setupBoard();
  const app = express();
  mountWorkerPages(app, { board: h.board });
  const base = await new Promise<string>((resolve) => {
    server = app.listen(0, () => {
      const a = server!.address();
      resolve(`http://localhost:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });
  const b = h.post();
  const tok = (w: string) => b.offers.find((o) => o.workerId === w)!.token;
  const form = (path: string, fields: Record<string, string>) =>
    fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  return { h, base, b, tok, form };
}

describe('worker pages', () => {
  it('shows the task with a Claim button, and 404s unknown links', async () => {
    const { base, tok } = await serve();
    const res = await fetch(`${base}/w/${tok('w_ana')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('Phone call, ~5 min, book a physio slot, S$3');
    expect(html).toContain('Claim this task');
    expect(html).toContain('name="viewport"');
    expect((await fetch(`${base}/w/nope`)).status).toBe(404);
  });

  it('claims with a form post, then shows the structured result form', async () => {
    const { base, tok, form } = await serve();
    const res = await form(`/w/${tok('w_ana')}/claim`, {});
    expect(res.status).toBe(303);
    const html = await (await fetch(`${base}${res.headers.get('location')}`)).text();
    expect(html).toContain('Claimed. It is yours');
    expect(html).toMatch(/<input name="date" type="date" required/);
    expect(html).toMatch(/<input name="time" type="time" required/);
    expect(html).toMatch(/<input name="reference" type="text" required/);
  });

  it('tells the slower claimer the task is taken (409)', async () => {
    const { base, tok, form } = await serve();
    await form(`/w/${tok('w_ana')}/claim`, {});
    const lost = await form(`/w/${tok('w_ben')}/claim`, {});
    expect(lost.status).toBe(409);
    expect(await lost.text()).toContain('Someone else already claimed this task');
    expect(await (await fetch(`${base}/w/${tok('w_ben')}`)).text()).toContain('Taken by someone else');
  });

  it('validates a submission and shows the errors, then accepts a valid one', async () => {
    const { h, base, b, tok, form } = await serve();
    await form(`/w/${tok('w_ana')}/claim`, {});
    const bad = await form(`/w/${tok('w_ana')}/submit`, { date: '2026-10-08', time: '', reference: '' });
    expect(bad.status).toBe(409);
    expect(await bad.text()).toContain('Time is required; Reference number is required');
    const ok = await form(`/w/${tok('w_ana')}/submit`, { date: '2026-10-08', time: '15:00', reference: '88213', notes: '<script>x</script>' });
    expect(ok.status).toBe(303);
    expect(h.board.get(b.id)).toMatchObject({ status: 'submitted', result: { summary: 'Booked: Thursday 3pm, ref 88213', notes: '<script>x</script>' } });
    const html = await (await fetch(`${base}/w/${tok('w_ana')}`)).text();
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x');
  });

  it('answers JSON for scripts, without the other workers\' tokens', async () => {
    const { base, b, tok } = await serve();
    const res = await fetch(`${base}/w/${tok('w_ana')}/claim`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}' });
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({ ok: true, bounty: { id: b.id, status: 'claimed', reward: { amount: 3, currency: 'SGD' } } });
    expect(JSON.stringify(body)).not.toContain(tok('w_ben'));
    const pub = await (await fetch(`${base}/bounty/${b.id}`)).json();
    expect(JSON.stringify(pub)).not.toContain('token');
  });

  it('lets only the claimer message the client', async () => {
    const { h, b, tok, form } = await serve();
    expect((await form(`/w/${tok('w_ana')}/message`, { text: 'Which branch?' })).status).toBe(409);
    await form(`/w/${tok('w_ana')}/claim`, {});
    expect((await form(`/w/${tok('w_ana')}/message`, { text: 'Which branch?' })).status).toBe(303);
    expect(h.board.get(b.id)!.messages.map((m) => [m.from, m.text])).toEqual([['worker', 'Which branch?']]);
  });
});
