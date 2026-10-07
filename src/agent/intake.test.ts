import { describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { createIntake } from './intake';

describe('intake without an API key', () => {
  const intake = createIntake({ config: testConfig({ ANTHROPIC_API_KEY: undefined }) });

  it('builds a deterministic brief from the first message', async () => {
    const r = await intake.next([{ from: 'hirer', text: 'I need a logo designed for my bakery, budget $150' }]);
    expect(r.kind).toBe('brief');
    if (r.kind !== 'brief') return;
    expect(r.brief.task).toBe('I need a logo designed for my bakery, budget $150');
    expect(r.brief.remoteOk).toBe(true);
    expect(r.brief.skills.length).toBeGreaterThan(0);
    expect(r.brief.skills.length).toBeLessThanOrEqual(5);
    expect(r.brief.skills).toContain('logo');
    expect(r.brief.budgetUsd).toBe(150);
    expect(r.summary).toContain('logo');
  });

  it('keeps the first message as the task in later turns', async () => {
    const r = await intake.next([
      { from: 'hirer', text: 'translate a manual' },
      { from: 'agent', text: 'Which languages?' },
      { from: 'hirer', text: 'German to English, $40' },
    ]);
    expect(r.kind === 'brief' && r.brief.task).toBe('translate a manual');
  });

  it('asks for what is missing before searching, one topic at a time', async () => {
    const first = await intake.next([{ from: 'hirer', text: 'Wait in line for the iPhone launch at Orchard ION for me' }]);
    expect(first).toMatchObject({ kind: 'ask' });
    expect(first.kind === 'ask' && first.text).toMatch(/day and time/i);
    const second = await intake.next([
      { from: 'hirer', text: 'Wait in line for the iPhone launch at Orchard ION for me' },
      { from: 'agent', text: first.kind === 'ask' ? first.text : '' },
      { from: 'hirer', text: 'Saturday 7am, about 4 hours, $60' },
    ]);
    expect(second.kind).toBe('brief');
    if (second.kind === 'brief') {
      expect(second.brief.remoteOk).toBe(false);
      expect(second.summary).toMatch(/RentAHuman/);
    }
  });
});

describe('intake: place, on-site and day/time without a model', () => {
  // Monday 2026-10-05 10:00 in Singapore.
  const now = Date.UTC(2026, 9, 5, 2, 0);
  const intake = createIntake({ config: testConfig({ ANTHROPIC_API_KEY: undefined }), now: () => now });

  it('reads an on-site errand with a district, a day and a time window', async () => {
    const r = await intake.next([{ from: 'hirer', text: 'Need someone to pick up a parcel near Marina Bay, Singapore this Saturday 2-5pm, about 3 hours, $60' }]);
    if (r.kind !== 'brief') throw new Error('expected a brief');
    expect(r.brief.remoteOk).toBe(false);
    expect(r.brief.taskType).toBe('in_person');
    expect(r.brief.location).toBe('Marina Bay');
    expect(r.brief.when).toEqual({ date: '2026-10-10', window: { start: '14:00', end: '17:00' }, timezone: 'Asia/Singapore' });
    expect(r.brief.hoursNeeded).toBe(3);
    expect(r.brief.budgetUsd).toBe(60);
    expect(r.summary).toContain('When: Sat 2026-10-10 14:00-17:00');
    expect(r.summary).toContain('On site');
  });

  it('picks the time up from a later turn', async () => {
    const r = await intake.next([
      { from: 'hirer', text: 'queue for concert tickets in Singapore' },
      { from: 'agent', text: 'When?' },
      { from: 'hirer', text: 'tomorrow morning, 2 hours, $40' },
    ]);
    if (r.kind !== 'brief') throw new Error('expected a brief');
    expect(r.brief.when?.date).toBe('2026-10-06');
    expect(r.brief.when?.window).toEqual({ start: '09:00', end: '12:00' });
  });

  it('leaves remote work remote and without a time', async () => {
    const r = await intake.next([{ from: 'hirer', text: 'Design a logo for my bakery, remote is fine, $100' }]);
    if (r.kind !== 'brief') throw new Error('expected a brief');
    expect(r.brief.remoteOk).toBe(true);
    expect(r.brief.when).toBeUndefined();
    expect(r.brief.taskType).toBeUndefined();
  });
});
