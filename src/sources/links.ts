// A hirer who already knows whom they want pastes that person's page. This turns the link into a
// profile: the platform's own lookup when its source has one, otherwise just what the URL says, so
// the person can still be shown with a Choose button and booked through the usual approve-first flow.

import type { SourceRegistry } from '../domain/ports';
import type { FreelancerProfile, Platform } from '../domain/types';
import { platformIdFromUrl } from './browser/extract';
import { SITES } from './browser/sites';

export interface ProfileLink {
  platform: Platform;
  /** Id as the platform's source uses it, so caches, exclusions and getProfile line up. */
  platformId: string;
  url: string;
}

const LABEL: Record<string, string> = { rentahuman: 'RentAHuman', fiverr: 'Fiverr', freelancer: 'Freelancer.com', peopleperhour: 'PeoplePerHour', guru: 'Guru' };

/** A Fiverr seller page (fiverr.com/<seller>) is as good as a gig page: messaging works from both. */
const FIVERR_SELLER = /^https:\/\/www\.fiverr\.com\/([a-z0-9_.-]+)\/?$/i;
const FIVERR_RESERVED = /^(search|categories|cp|pro|business|resources|support|learn|become|stories|press|about|legal|logo-maker|go|gigs|sellers|login|join|inbox)$/i;

const PARSERS: ((url: string) => ProfileLink | undefined)[] = [
  (url) => {
    const m = /^https:\/\/(?:www\.)?rentahuman\.ai\/humans\/([^/?#]+)/i.exec(url);
    return m ? { platform: 'rentahuman', platformId: decodeURIComponent(m[1]!), url: `https://rentahuman.ai/humans/${m[1]}` } : undefined;
  },
  (url) => {
    const m = /^https:\/\/(?:www\.)?freelancer\.com\/u\/([^/?#]+)/i.exec(url);
    return m ? { platform: 'freelancer', platformId: decodeURIComponent(m[1]!), url: `https://www.freelancer.com/u/${m[1]}` } : undefined;
  },
  (url) => {
    const seller = FIVERR_SELLER.exec(url)?.[1];
    if (seller && !FIVERR_RESERVED.test(seller)) return { platform: 'fiverr', platformId: seller.toLowerCase(), url: `https://www.fiverr.com/${seller}` };
    return undefined;
  },
  (url) => {
    // Freelancer pages (/freelancer/<category>/<name-id>); the search pattern only covers offers.
    const m = /^https:\/\/www\.peopleperhour\.com\/freelancer\/[^?#]+/i.exec(url);
    return m ? { platform: 'peopleperhour', platformId: platformIdFromUrl(m[0]), url: m[0].replace(/\/$/, '') } : undefined;
  },
  // Gig and profile pages on the browser-read sites, with the same ids their search gives.
  ...['fiverr', 'peopleperhour', 'guru'].map((name) => (url: string): ProfileLink | undefined => {
    const site = SITES[name]!;
    const m = site.profileUrlPattern.exec(url);
    if (!m) return undefined;
    const clean = url.replace(/[?#].*$/, '');
    return { platform: site.platform, platformId: platformIdFromUrl(clean), url: clean };
  }),
];

/** The first freelancer profile or gig link in a message, or undefined. */
export function findProfileLink(text: string): ProfileLink | undefined {
  for (const raw of text.match(/https?:\/\/[^\s<>"')]+/gi) ?? []) {
    // People paste "fiverr.com/x" without www or over http; the site patterns expect the canonical form.
    const url = raw
      .replace(/^http:/i, 'https:')
      .replace(/^https:\/\/(fiverr|peopleperhour|guru)\.com/i, 'https://www.$1.com')
      .replace(/[.,;:!?]+$/, '');
    for (const parse of PARSERS) {
      const link = parse(url);
      if (link) return link;
    }
  }
  return undefined;
}

/** "Fiverr" for 'fiverr', etc. */
export const platformLabel = (platform: Platform): string => LABEL[platform] ?? platform;

/** What the URL alone says: the handle as the name, nothing about price or rating. */
export function profileFromLink(link: ProfileLink, at: number = Date.now()): FreelancerProfile {
  const handle = link.platformId.split('/')[0]!.replace(/[-_.]+/g, ' ').trim() || link.platformId;
  return {
    id: `${link.platform}:${link.platformId}`,
    platform: link.platform,
    platformId: link.platformId,
    url: link.url,
    name: handle,
    headline: `${platformLabel(link.platform)} profile you sent`,
    skills: [],
    pricing: [],
    fetchedAt: at,
  };
}

/** The platform's profile for the link when its source can look it up; never throws. */
export async function resolveProfileLink(link: ProfileLink, registry?: SourceRegistry): Promise<FreelancerProfile> {
  const source = registry?.enabled().find((s) => s.platform === link.platform && s.getProfile);
  try {
    const found = await source?.getProfile?.(link.platformId);
    if (found) return { ...found, url: found.url || link.url };
  } catch (err) {
    console.error(`[links] ${link.platform} lookup of ${link.platformId} failed:`, err instanceof Error ? err.message : err);
  }
  return profileFromLink(link);
}
