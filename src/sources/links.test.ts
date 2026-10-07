import { describe, expect, it, vi } from 'vitest';
import type { FreelancerSource, SourceRegistry } from '../domain/ports';
import type { FreelancerProfile } from '../domain/types';
import { findProfileLink, profileFromLink, resolveProfileLink } from './links';

const registryWith = (...sources: Partial<FreelancerSource>[]) => ({ enabled: () => sources, all: () => sources }) as unknown as SourceRegistry;

describe('profile links', () => {
  it.each([
    ['book https://rentahuman.ai/humans/h_123abc please', 'rentahuman', 'h_123abc', 'https://rentahuman.ai/humans/h_123abc'],
    ['https://www.freelancer.com/u/tasyaw?ref=x', 'freelancer', 'tasyaw', 'https://www.freelancer.com/u/tasyaw'],
    ['this one: https://www.fiverr.com/tasya_w/teach-sat-math?context_referrer=search.', 'fiverr', 'tasya_w/teach-sat-math', 'https://www.fiverr.com/tasya_w/teach-sat-math'],
    ['fiverr.com/x? no: http://fiverr.com/tasya_w', 'fiverr', 'tasya_w', 'https://www.fiverr.com/tasya_w'],
    ['https://www.peopleperhour.com/freelancer/design/ann-lee-logo-designer-abc123', 'peopleperhour', 'freelancer/design/ann-lee-logo-designer-abc123', 'https://www.peopleperhour.com/freelancer/design/ann-lee-logo-designer-abc123'],
    ['https://www.guru.com/freelancers/ann-lee', 'guru', 'freelancers/ann-lee', 'https://www.guru.com/freelancers/ann-lee'],
  ])('finds the person in %s', (text, platform, platformId, url) => {
    expect(findProfileLink(text)).toEqual({ platform, platformId, url });
  });

  it('ignores search pages and other sites', () => {
    expect(findProfileLink('https://www.fiverr.com/search/gigs?query=logo')).toBeUndefined();
    expect(findProfileLink('https://www.fiverr.com/categories')).toBeUndefined();
    expect(findProfileLink('see https://example.com/u/ann')).toBeUndefined();
    expect(findProfileLink('no link here')).toBeUndefined();
  });

  it('builds a minimal profile from the URL alone', () => {
    expect(profileFromLink({ platform: 'fiverr', platformId: 'tasya_w/teach-sat-math', url: 'https://www.fiverr.com/tasya_w/teach-sat-math' }, 5)).toEqual({
      id: 'fiverr:tasya_w/teach-sat-math',
      platform: 'fiverr',
      platformId: 'tasya_w/teach-sat-math',
      url: 'https://www.fiverr.com/tasya_w/teach-sat-math',
      name: 'tasya w',
      headline: 'Fiverr profile you sent',
      skills: [],
      pricing: [],
      fetchedAt: 5,
    });
  });

  it("uses the platform's lookup when its source has one, and the URL when it fails", async () => {
    const link = { platform: 'rentahuman', platformId: 'h_1', url: 'https://rentahuman.ai/humans/h_1' };
    const found = { ...profileFromLink(link), name: 'Tasya', headline: 'Queues and errands', pricing: [{ kind: 'hourly', amountUsd: 15 }] } as FreelancerProfile;
    const getProfile = vi.fn(async () => found);
    expect(await resolveProfileLink(link, registryWith({ platform: 'fiverr' }, { platform: 'rentahuman', getProfile }))).toEqual(found);
    expect(getProfile).toHaveBeenCalledWith('h_1');

    const failing = registryWith({ platform: 'rentahuman', getProfile: async () => { throw new Error('offline'); } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await resolveProfileLink(link, failing)).name).toBe('h 1');
    expect((await resolveProfileLink(link, registryWith({ platform: 'rentahuman', getProfile: async () => null }))).id).toBe('rentahuman:h_1');
    expect((await resolveProfileLink(link)).url).toBe(link.url);
  });
});
