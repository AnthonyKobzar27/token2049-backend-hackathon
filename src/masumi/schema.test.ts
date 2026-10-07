import { describe, expect, it } from 'vitest';
import type { Candidate, Shortlist } from '../domain/types';
import { checkInSchema, parseBrief, parseCheckIn } from './schema';

const cand = (id: string, score: number): Candidate => ({
  profile: { id, platform: 'fake', platformId: id, url: `https://x/${id}`, name: `Name ${id}`, headline: 'h', skills: [], pricing: [], fetchedAt: 0 },
  score,
  subscores: { suitability: null, price: null, rating: null, availability: null, speed: null },
  reason: 'r',
  unknowns: [],
  quoteUsd: 120,
});
const shortlist: Shortlist = { id: 's', jobId: 'j', round: 1, candidates: [cand('fake:1', 90), cand('fake:2', 80)], sources: [], createdAt: 0 };

describe('parseBrief', () => {
  it('parses a plain object', () => {
    const r = parseBrief({ task: ' Logo ', skills: 'figma, branding', budget_usd: '250', remote_ok: 'false', deadline_days: 7 });
    expect(r).toEqual({ ok: true, value: { task: 'Logo', skills: ['figma', 'branding'], remoteOk: false, budgetUsd: 250, deadlineDays: 7 } });
  });
  it('parses the list form and applies defaults', () => {
    const r = parseBrief([{ key: 'task', value: 'Translate' }, { id: 'language', value: 'de' }, { key: 'notes', value: '' }]);
    // Skills come from the task when the caller sends none, so every platform has something to search.
    expect(r).toEqual({ ok: true, value: { task: 'Translate', skills: ['translate'], remoteOk: true, language: 'de' } });
  });
  it('rejects bad input', () => {
    expect(parseBrief({})).toMatchObject({ ok: false });
    expect(parseBrief({ task: 'x', budget_usd: 'lots' })).toMatchObject({ ok: false });
    expect(parseBrief(undefined)).toMatchObject({ ok: false });
    expect(parseBrief('str')).toMatchObject({ ok: false });
  });
});

describe('check-in', () => {
  it('lists candidates then the extra options', () => {
    const values = checkInSchema(shortlist).input_data[0]!.data!.values!;
    expect(values).toHaveLength(4);
    expect(values[0]).toContain('fake:1 | Name fake:1');
    expect(values.slice(2)).toEqual(['different_options', 'cancel']);
  });
  it('maps choices to UserInput', () => {
    const [label] = checkInSchema(shortlist).input_data[0]!.data!.values!;
    expect(parseCheckIn({ choice: label }, shortlist)).toEqual({ ok: true, value: { action: 'confirm', profileId: 'fake:1' } });
    expect(parseCheckIn({ choice: 'fake:2' }, shortlist)).toMatchObject({ ok: true, value: { action: 'confirm', profileId: 'fake:2' } });
    expect(parseCheckIn({ choice: ['fake:2'] }, shortlist)).toMatchObject({ ok: true });
    expect(parseCheckIn({ choice: 'different_options', feedback: 'cheaper' }, shortlist)).toEqual({ ok: true, value: { action: 'refine', feedback: 'cheaper' } });
    expect(parseCheckIn({ choice: 'cancel' }, shortlist)).toEqual({ ok: true, value: { action: 'cancel' } });
    expect(parseCheckIn({ feedback: 'more senior' }, shortlist)).toEqual({ ok: true, value: { action: 'refine', feedback: 'more senior' } });
  });
  it('rejects unknown candidates and empty input', () => {
    expect(parseCheckIn({ choice: 'fake:9' }, shortlist)).toMatchObject({ ok: false });
    expect(parseCheckIn({}, shortlist)).toMatchObject({ ok: false });
    expect(parseCheckIn({ choice: 'fake:1' }, null)).toMatchObject({ ok: false });
  });
});

describe('brief day/time and place fields', () => {
  it('accepts when, radius and task type, and reads a time from the task text', () => {
    const r = parseBrief({ task: 'Hand out flyers', location: 'Singapore', remote_ok: 'false', when: '2026-10-10 14:00-17:00', radius_km: '10', task_type: 'in_person' });
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.value.when).toEqual({ date: '2026-10-10', window: { start: '14:00', end: '17:00' } });
    expect(r.value.radiusKm).toBe(10);
    expect(r.value.taskType).toBe('in_person');
    const t = parseBrief({ task: 'Pick up a parcel in Orchard tomorrow at 3pm', remote_ok: false });
    if (!t.ok) throw new Error(t.errors.join());
    expect(t.value.location).toBe('Orchard');
    expect(t.value.when?.window).toEqual({ start: '15:00', end: '17:00' });
    expect(t.value.when?.timezone).toBe('Asia/Singapore');
  });
});
