import { describe, expect, it } from 'vitest';
import { cleanWhen, describeWhen, enrichBrief, extractPlace, looksOnSite } from './extract';

describe('extract', () => {
  it('finds places and on-site work', () => {
    expect(extractPlace('deliver flowers in Orchard, Singapore')).toBe('Orchard');
    expect(extractPlace('logo for my bakery')).toBeUndefined();
    expect(looksOnSite('pick up my laundry')).toBe(true);
    expect(looksOnSite('errands research, done remotely')).toBe(false);
    expect(looksOnSite('write a blog post')).toBe(false);
  });

  it('validates structured when and drops junk', () => {
    expect(cleanWhen({ date: '2026-10-10', start: '9:00', end: '12:00', timezone: 'Asia/Singapore' })).toEqual({ date: '2026-10-10', window: { start: '09:00', end: '12:00' }, timezone: 'Asia/Singapore' });
    expect(cleanWhen({ date: 'saturday', start: '14:00', end: '13:00', timezone: 'Mars/Base' })).toBeUndefined();
    expect(cleanWhen(null)).toBeUndefined();
  });

  it('enriches a brief from its text without overriding set fields', () => {
    const now = Date.UTC(2026, 9, 5, 2, 0);
    const b = enrichBrief({ task: 'help at our booth on Oct 12 at 10am', skills: [], location: 'Singapore', remoteOk: false }, now);
    expect(b.when).toEqual({ date: '2026-10-12', window: { start: '10:00', end: '12:00' }, timezone: 'Asia/Singapore' });
    const kept = enrichBrief({ task: 'tomorrow', skills: [], remoteOk: true, when: { date: '2026-12-01' } }, now);
    expect(kept.when).toEqual({ date: '2026-12-01' });
    expect(describeWhen({ date: '2026-10-10', window: { start: '14:00', end: '17:00' } })).toBe('Sat 2026-10-10 14:00-17:00');
  });
});
