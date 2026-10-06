import { describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { checkTask } from './guard';
import { deriveSpec, rewardFor, rulesSpec, summarize, validateResult } from './spec';
import { parseSubmitArgs } from './telegram';
import { PHYSIO } from './testkit';

describe('legitimacy guard', () => {
  it.each([
    'Solve the captcha on this signup page for me',
    'Need someone to do reCAPTCHA solving, 1000 per hour',
    'Pass the hCaptcha challenge on example.com',
    'Bypass the rate limit on the ticket site',
    'Help me get around the geo-block on a streaming service',
    'Receive SMS verification codes to create accounts on Instagram',
    'Create 50 fake accounts for a giveaway',
    'Write fake reviews for my restaurant',
  ])('rejects %s', (task) => {
    const v = checkTask(task);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/^HAAS does not post tasks/);
  });

  it.each([PHYSIO.task, 'Pick up a parcel at Bugis and drop it at Raffles Place', 'Check whether the bakery on Orchard Road is open today', 'Take a photo of the menu board at the hawker centre'])('allows %s', (task) => {
    expect(checkTask(task)).toEqual({ ok: true });
  });
});

describe('bounty spec (rules)', () => {
  it('turns the physio brief into a phone-call booking bounty', () => {
    const s = rulesSpec(PHYSIO);
    expect(s).toMatchObject({ kind: 'phone_call', estMinutes: 5, title: 'Phone call, ~5 min, book a physio slot, S$3', summaryTemplate: 'Booked: {date} {time}, ref {reference}', derivedBy: 'rules' });
    expect(s.fields.map((f) => [f.key, f.type, f.required])).toEqual([['date', 'date', true], ['time', 'time', true], ['reference', 'text', true]]);
    expect(s.place).toMatchObject({ name: 'Tanjong Pagar Polyclinic', point: { lat: expect.any(Number) } });
    expect(s.instructions).toContain('Call Tanjong Pagar Polyclinic');
  });

  it('picks fields for inquiries, photos and generic tasks', () => {
    expect(rulesSpec({ task: 'Check whether the bakery on Orchard Road is open today', skills: [], remoteOk: false }).fields[0]!.key).toBe('answer');
    expect(rulesSpec({ task: 'Take a photo of the queue at Bugis', skills: [], remoteOk: false }).fields[0]!.key).toBe('photo_url');
    expect(rulesSpec({ task: 'Drop a parcel at Bugis', skills: [], remoteOk: false })).toMatchObject({ kind: 'errand', fields: [{ key: 'outcome' }] });
  });

  it('prices from time in local currency, capped by the budget', () => {
    expect(rewardFor(PHYSIO, 5)).toEqual({ amount: 3, currency: 'SGD', usd: 2.22 });
    expect(rewardFor({ ...PHYSIO, location: undefined, task: 'call a shop in London' }, 30)).toMatchObject({ amount: 18, currency: 'USD' });
    expect(rewardFor({ ...PHYSIO, budgetUsd: 1 }, 30).amount).toBe(1);
  });

  it('falls back to rules without a model key', async () => {
    expect((await deriveSpec(PHYSIO, testConfig())).derivedBy).toBe('rules');
  });
});

describe('results', () => {
  const spec = rulesSpec(PHYSIO);
  it('summarizes with weekday and 12h time', () => {
    expect(summarize(spec, { date: '2026-10-08', time: '15:00', reference: '88213' })).toBe('Booked: Thursday 3pm, ref 88213');
    expect(summarize(spec, { date: 'Thursday', time: '9:30', reference: 'A1' })).toBe('Booked: Thursday 9:30am, ref A1');
  });
  it('validates required fields and types, dropping unknown keys', () => {
    expect(validateResult(spec, { date: '2026-10-08', time: '3pm', reference: 88213, extra: 'x' })).toEqual({ ok: true, data: { date: '2026-10-08', time: '3pm', reference: '88213' } });
    const bad = validateResult(spec, { date: 'soon-ish!', time: '' });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors).toEqual(['Date does not look like a date', 'Time is required', 'Reference number is required']);
  });
  it('parses Telegram /submit arguments', () => {
    expect(parseSubmitArgs('date=2026-10-08 time=15:00 reference=88 213 | bring NRIC, arrive early')).toEqual({ fields: { date: '2026-10-08', time: '15:00', reference: '88 213' }, notes: 'bring NRIC, arrive early' });
    expect(parseSubmitArgs('answer=open till 9pm photo=https://x/p.jpg')).toEqual({ fields: { answer: 'open till 9pm' }, photoUrl: 'https://x/p.jpg' });
  });
});
