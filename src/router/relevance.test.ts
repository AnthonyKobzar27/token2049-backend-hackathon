import { describe, expect, it } from 'vitest';
import type { Brief, FreelancerProfile } from '../domain/types';
import { fixtures } from '../sources/fake';
import { inferCategory, relevanceScores, stem, synonymsOf } from './relevance';

const top = (brief: Brief, n = 3): string[] =>
  [...relevanceScores(brief, fixtures)].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])).slice(0, n).map(([id]) => id.replace('fake:', ''));

describe('relevance (no-API-key suitability)', () => {
  it('stems word families together', () => {
    expect(stem('translation')).toBe(stem('translate'));
    expect(stem('translator')).toBe(stem('translate'));
    expect(stem('designer')).toBe('design');
    expect(stem('editing')).toBe('edit');
    expect(stem('errands')).toBe('errand');
  });

  it('expands synonyms and infers a category', () => {
    expect(synonymsOf(stem('courier'))).toContain('errand');
    expect(inferCategory('Need a logo and brand kit')).toBe('design');
    expect(inferCategory('pick up a parcel, courier run')).toBe('errands');
  });

  it('ranks the right specialists first on the fixtures', () => {
    expect(top({ task: 'I need a logo for my bakery', skills: ['logo design', 'branding'], remoteOk: true }, 1)).toEqual(['logo-mara']);
    expect(top({ task: 'Translate a Japanese manual into English', skills: ['translator'], remoteOk: true }, 1)).toEqual(['trans-kenji']);
    expect(top({ task: 'queue for me and pick up a parcel', skills: ['errands'], remoteOk: false })).toEqual(expect.arrayContaining(['errand-weijie', 'errand-siti']));
    expect(top({ task: 'edit my youtube videos', skills: ['video editor'], remoteOk: true }, 2)).toEqual(expect.arrayContaining(['video-tomas', 'video-aiko']));
  });

  it('finds a match through a synonym, at a discount, and says so', () => {
    const p: FreelancerProfile = { id: 'x:1', platform: 'x', platformId: '1', url: '', name: 'n', headline: 'Courier for documents', skills: ['courier'], pricing: [], fetchedAt: 0 };
    const exact = { ...p, id: 'x:2', headline: 'Errands', skills: ['errands'] };
    const out = relevanceScores({ task: 'errands', skills: [], remoteOk: false }, [p, exact]);
    expect(out.get('x:1')!.reason).toBe('related to errands');
    expect(out.get('x:1')!.score).toBeGreaterThan(0);
    expect(out.get('x:1')!.score).toBeLessThan(out.get('x:2')!.score);
  });

  it('weighs rare terms above common ones (IDF over the set)', () => {
    const mk = (id: string, skills: string[]): FreelancerProfile => ({ id, platform: 'x', platformId: id, url: '', name: id, headline: '', skills, pricing: [], fetchedAt: 0 });
    const set = [mk('a', ['english', 'japanese']), mk('b', ['english']), mk('c', ['english']), mk('d', ['english'])];
    const out = relevanceScores({ task: 'english japanese', skills: [], remoteOk: true }, set);
    expect(out.get('a')!.score).toBeGreaterThan(0.9);
    expect(out.get('b')!.score).toBeLessThan(0.5);
  });

  it('reads the bio too', () => {
    const p: FreelancerProfile = { id: 'x:1', platform: 'x', platformId: '1', url: '', name: 'n', headline: 'Freelancer', skills: [], description: 'I build Solidity smart contracts', pricing: [], fetchedAt: 0 };
    expect(relevanceScores({ task: 'solidity audit', skills: [], remoteOk: true }, [p]).get('x:1')!.score).toBeGreaterThan(0.3);
  });
});
