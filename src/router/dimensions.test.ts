import { describe, expect, it } from 'vitest';
import type { Brief, FreelancerProfile, Pricing, SuitabilityScore } from '../domain/types';
import { distanceKm, profilePlace, resolvePlace } from './geo';
import { dropReason, locationFit, rank, totalScore } from './match';
import { inferTaskType, TASK_WEIGHTS, weightsFor } from './weights';
import { coverage, localToUtc, parseWhen, requestedInterval, timingScore } from './when';
import { fixtures } from '../sources/fake';

// Tuesday 2026-10-06, 10:00 in Singapore.
const NOW = Date.UTC(2026, 9, 6, 2, 0);
const brief = (b: Partial<Brief> = {}): Brief => ({ task: 'help at an event', skills: ['event staffing'], remoteOk: true, ...b });
const prof = (id: string, extra: Partial<FreelancerProfile> = {}): FreelancerProfile => ({
  id: `t:${id}`, platform: 't', platformId: id, url: 'u', name: id, headline: 'h', skills: [], pricing: [], fetchedAt: 0, ...extra,
});
const fixed = (amountUsd: number, deliveryDays?: number): Pricing => ({ kind: 'fixed', amountUsd, deliveryDays });
const sat = { date: '2026-10-10', window: { start: '14:00', end: '17:00' }, timezone: 'Asia/Singapore' };
const weekdays = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, [{ start: '09:00', end: '17:00' }]]));

describe('geo gazetteer', () => {
  it('resolves districts before the city, cities before countries', () => {
    expect(resolvePlace('Marina Bay, Singapore')).toMatchObject({ name: 'marina bay', country: 'sg', precision: 'city' });
    expect(resolvePlace('Singapore')).toMatchObject({ name: 'singapore', precision: 'city' });
    expect(resolvePlace('somewhere in Malaysia')).toMatchObject({ country: 'my', precision: 'country' });
    expect(resolvePlace('in')).toMatchObject({ country: 'in' }); // whole-token code
    expect(resolvePlace('drop in later')).toBeNull(); // never a loose short code
    expect(resolvePlace(undefined)).toBeNull();
  });
  it('places profiles by city when it agrees with the country', () => {
    expect(profilePlace({ country: 'SG', city: 'Singapore' })).toMatchObject({ precision: 'city' });
    expect(profilePlace({ country: 'US', city: 'California' })).toMatchObject({ precision: 'country', country: 'us' });
    expect(profilePlace({ country: 'United Kingdom' })).toMatchObject({ country: 'gb' });
    expect(profilePlace({})).toBeNull();
  });
  it('measures distance', () => {
    const sg = resolvePlace('Singapore')!;
    expect(distanceKm(sg, resolvePlace('Johor Bahru')!)).toBeGreaterThan(15);
    expect(distanceKm(sg, resolvePlace('Johor Bahru')!)).toBeLessThan(40);
    expect(distanceKm(sg, resolvePlace('Kuala Lumpur')!)).toBeGreaterThan(300);
  });
});

describe('location as a scored dimension', () => {
  const onsite = brief({ remoteOk: false, location: 'Marina Bay, Singapore' });

  it('scores nearer people higher and keeps a nearby neighbour country inside the radius', () => {
    const near = locationFit(onsite, prof('n', { country: 'SG', city: 'Raffles Place' }));
    const far = locationFit(onsite, prof('f', { country: 'SG', city: 'Woodlands' }));
    const jb = locationFit(onsite, prof('jb', { country: 'MY', city: 'Johor Bahru' }));
    expect(near).toMatchObject({ score: 1, drop: false });
    expect(near.phrase).toBe('in Marina Bay');
    expect(far.score!).toBeLessThan(1);
    expect(far.phrase).toMatch(/^about \d+ km from Marina Bay$/);
    expect(jb.drop).toBe(false);
    expect(jb.score!).toBeLessThan(far.score!);
  });

  it('hard-filters only beyond the radius', () => {
    expect(dropReason(onsite, prof('kl', { country: 'MY', city: 'Kuala Lumpur' }))).toBe('location');
    expect(dropReason({ ...onsite, radiusKm: 400 }, prof('kl', { country: 'MY', city: 'Kuala Lumpur' }))).toBeNull();
    expect(dropReason({ ...onsite, radiusKm: 5 }, prof('w', { country: 'SG', city: 'Woodlands' }))).toBe('location');
  });

  it('gives same-country-without-city a middling score and unknown a null', () => {
    expect(locationFit(onsite, prof('c', { country: 'SG' }))).toMatchObject({ score: 0.7, drop: false });
    expect(locationFit(onsite, prof('u'))).toMatchObject({ score: null, drop: false });
  });

  it('is a soft preference for remote work and absent without a location', () => {
    const remote = brief({ location: 'Singapore' });
    expect(locationFit(remote, prof('sg', { country: 'SG' })).score).toBe(1);
    const tokyo = locationFit(remote, prof('jp', { country: 'JP' })).score!;
    const ny = locationFit(remote, prof('us', { country: 'US', city: 'New York' })).score!;
    expect(tokyo).toBeGreaterThan(ny);
    expect(locationFit(remote, prof('us', { country: 'US' })).drop).toBe(false);
    expect(locationFit(brief(), prof('x', { country: 'SG' })).score).toBeUndefined();
  });
});

describe('day and time', () => {
  it('turns the brief into a concrete UTC interval', () => {
    const iv = requestedInterval(brief({ when: sat }), NOW)!;
    expect(iv.start).toBe(Date.UTC(2026, 9, 10, 6, 0));
    expect(iv.end).toBe(Date.UTC(2026, 9, 10, 9, 0));
    expect(iv.label).toBe('Sat 14:00-17:00');
    expect(localToUtc('2026-03-29', 120, 'Europe/London')).toBe(Date.UTC(2026, 2, 29, 1, 0)); // DST gap settles
    expect(requestedInterval(brief(), NOW)).toBeNull();
  });

  it('uses the location zone when the brief names none', () => {
    const iv = requestedInterval(brief({ location: 'Singapore', when: { date: '2026-10-10', window: { start: '14:00', end: '17:00' } } }), NOW)!;
    expect(iv.tz).toBe('Asia/Singapore');
  });

  it('scores a published schedule on that specific day', () => {
    const b = brief({ when: sat });
    const weekend = prof('we', { timezone: 'Asia/Singapore', availability: { schedule: { saturday: [{ start: '13:00', end: '18:00' }] } } });
    const weekdayOnly = prof('wd', { timezone: 'Asia/Singapore', availability: { schedule: weekdays } });
    const half = prof('h', { timezone: 'Asia/Singapore', availability: { schedule: { saturday: [{ start: '15:30', end: '20:00' }] } } });
    expect(timingScore(b, weekend, NOW)).toBeCloseTo(1, 5);
    expect(timingScore(b, weekdayOnly, NOW)).toBeCloseTo(0.1, 5);
    expect(timingScore(b, half, NOW)).toBeCloseTo(0.1 + 0.9 * 0.5, 5);
  });

  it('assumes a 09:00-18:00 day in their zone (inferred from country) when no schedule', () => {
    const b = brief({ when: sat });
    const london = prof('l', { country: 'GB' }); // Sat 14-17 SGT is 07-10 in London
    const cov = coverage(london, requestedInterval(b, NOW)!)!;
    expect(cov.basis).toBe('assumed');
    expect(cov.fraction).toBeCloseTo(1 / 3, 5);
    expect(cov.local).toBe('07:00-10:00');
    expect(timingScore(b, prof('sg', { country: 'SG' }), NOW)).toBeCloseTo(0.85, 5);
    expect(timingScore(b, prof('unknown'), NOW)).toBeNull();
    expect(timingScore(brief(), prof('sg', { country: 'SG' }), NOW)).toBeUndefined();
  });

  it('penalises slow responders for soon work and people not taking work', () => {
    const soon = brief({ when: { date: '2026-10-06', window: { start: '14:00', end: '16:00' }, timezone: 'Asia/Singapore' } });
    const base = { timezone: 'Asia/Singapore' };
    const fast = timingScore(soon, prof('f', { ...base, availability: { responseHours: 1, online: true } }), NOW)!;
    const slow = timingScore(soon, prof('s', { ...base, availability: { responseHours: 24 } }), NOW)!;
    const closed = timingScore(soon, prof('c', { ...base, availability: { accepting: false } }), NOW)!;
    expect(fast).toBeGreaterThan(slow);
    expect(closed).toBeLessThan(fast);
  });
});

describe('parseWhen', () => {
  const tz = 'Asia/Singapore';
  it('reads weekdays and ranges', () => {
    expect(parseWhen('need someone this Saturday 2-5pm at Marina Bay', NOW, tz)).toEqual({ date: '2026-10-10', window: { start: '14:00', end: '17:00' }, timezone: tz });
    expect(parseWhen('on saturday from 10am to 1pm', NOW, tz)).toMatchObject({ date: '2026-10-10', window: { start: '10:00', end: '13:00' } });
    expect(parseWhen('next tuesday 14:00-17:30', NOW, tz)).toMatchObject({ date: '2026-10-13', window: { start: '14:00', end: '17:30' } });
  });
  it('reads relative days, dates and parts of the day', () => {
    expect(parseWhen('tomorrow morning', NOW, tz)).toMatchObject({ date: '2026-10-07', window: { start: '09:00', end: '12:00' } });
    expect(parseWhen('2026-10-20 at 3pm', NOW, tz)).toMatchObject({ date: '2026-10-20', window: { start: '15:00', end: '17:00' } });
    expect(parseWhen('Oct 12th', NOW, tz)).toMatchObject({ date: '2026-10-12' });
    expect(parseWhen('12 March', NOW, tz)).toMatchObject({ date: '2027-03-12' });
    expect(parseWhen('tonight', NOW, tz)).toMatchObject({ date: '2026-10-06', window: { start: '18:00', end: '22:00' } });
  });
  it('ignores numbers that are not times', () => {
    expect(parseWhen('logo for my bakery, budget $100-200, 2-3 revisions', NOW, tz)).toBeUndefined();
  });
});

describe('weights per task type', () => {
  it('infers the task type', () => {
    expect(inferTaskType(brief({ remoteOk: false }))).toBe('in_person');
    expect(inferTaskType(brief({ task: 'design a logo', skills: ['logo design'] }))).toBe('remote_creative');
    expect(inferTaskType(brief({ task: 'build a react dashboard', skills: ['react'] }))).toBe('remote_technical');
    expect(inferTaskType(brief({ task: 'call 20 restaurants', skills: [] }))).toBe('remote_general');
    expect(inferTaskType(brief({ remoteOk: false, taskType: 'remote_creative' }))).toBe('remote_creative');
  });
  it('weights location and time heavily for in-person work', () => {
    const w = TASK_WEIGHTS.in_person;
    expect(w.location + w.timing).toBeGreaterThan(TASK_WEIGHTS.remote_creative.location + TASK_WEIGHTS.remote_creative.timing);
    expect(TASK_WEIGHTS.remote_creative.price).toBeGreaterThan(w.price);
  });
  it('accepts a JSON override and ignores junk', () => {
    expect(weightsFor(brief({ remoteOk: false }), '{"in_person":{"location":0.9,"bogus":1,"price":-1}}').weights).toMatchObject({ location: 0.9, price: 0.1 });
    expect(weightsFor(brief({ remoteOk: false }), 'not json').weights).toEqual(TASK_WEIGHTS.in_person);
  });
  it('ignores absent and zero-weight dimensions', () => {
    const s = { suitability: 0.8, price: 0.8, rating: 0.8, availability: 0.8, speed: null };
    expect(totalScore(s, TASK_WEIGHTS.in_person)).toBeCloseTo(80, 5); // speed weighs 0 for errands: no penalty
    expect(totalScore({ ...s, location: null }, TASK_WEIGHTS.in_person)).toBeCloseTo(78, 5);
    expect(totalScore({ ...s, location: 0.2 }, TASK_WEIGHTS.in_person)).toBeLessThan(totalScore({ ...s, location: 1 }, TASK_WEIGHTS.in_person));
  });
});

describe('rank with location and day/time', () => {
  const suit = (score: number): SuitabilityScore => ({ score, reason: 'Does errands' });
  const errand = brief({ task: 'queue for a product launch', skills: ['errands'], remoteOk: false, location: 'Marina Bay, Singapore', when: sat, budgetUsd: 200 });

  it('prefers the nearby person who works Saturday afternoons, and says why', () => {
    const near = prof('near', { country: 'SG', city: 'Bugis', pricing: [fixed(60)], rating: 4.7, reviewCount: 40, availability: { schedule: { saturday: [{ start: '10:00', end: '18:00' }] } } });
    const weekday = prof('weekday', { country: 'SG', city: 'Woodlands', pricing: [fixed(50)], rating: 4.9, reviewCount: 200, availability: { schedule: weekdays } });
    const kl = prof('kl', { country: 'MY', city: 'Kuala Lumpur', pricing: [fixed(20)], rating: 5, reviewCount: 500 });
    const scores = new Map([near, weekday, kl].map((p) => [p.id, suit(0.8)] as const));
    const out = rank(errand, [kl, weekday, near], scores, { limit: 5, now: NOW, weights: weightsFor(errand).weights });
    expect(out.map((c) => c.profile.platformId)).toEqual(['near', 'weekday']);
    expect(out[0]!.reason).toMatch(/km from Marina Bay; available all of Sat 14:00-17:00/);
    expect(out[1]!.reason).toMatch(/not available Sat 14:00-17:00/);
    expect(out[0]!.subscores.location).toBeGreaterThan(out[1]!.subscores.location!);
    expect(out[0]!.subscores.timing).toBeGreaterThan(out[1]!.subscores.timing!);
  });

  it('works on the demo fixtures: Singapore errand runners first, Bangkok filtered', () => {
    const out = rank(errand, fixtures, new Map(fixtures.map((p) => [p.id, suit(p.skills.includes('errands') ? 0.85 : 0.1)] as const)), { limit: 5, now: NOW, weights: weightsFor(errand).weights });
    const ids = out.map((c) => c.profile.platformId);
    expect(ids.slice(0, 2).sort()).toEqual(['errand-siti', 'errand-weijie']);
    expect(ids).not.toContain('errand-somchai');
    expect(out[0]!.reason).toMatch(/Sat 14:00-17:00/);
  });

  it('notes an unknown zone as an unknown, not a drop', () => {
    const [c] = rank(errand, [prof('anon', { pricing: [fixed(40)] })], new Map(), { limit: 3, now: NOW });
    expect(c!.subscores.timing).toBeNull();
    expect(c!.unknowns).toContain('time zone and working hours not published on t');
  });
});
