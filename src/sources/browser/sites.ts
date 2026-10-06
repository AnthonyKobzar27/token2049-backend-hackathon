import type { Brief, Platform } from '../../domain/types';

export interface SiteDef {
  /** Source name, as listed in BROWSER_SITES. */
  name: string;
  platform: Platform;
  origin: string;
  searchUrl(brief: Brief): string;
  /** Extra guidance for the extractor about this site's layout. */
  hints: string;
  /** Absolute URLs matching this are profile or gig pages. */
  profileUrlPattern: RegExp;
}

const STOP = new Set(
  'a an and are as at be by for from has have i in is it me my need of on or our please that the this to we with who want looking someone somebody help build make create get find hire'.split(' '),
);

/** Search words: the brief's skills, else keywords from the task. */
export function queryFor(brief: Brief): string {
  const skills = brief.skills.map((s) => s.trim()).filter(Boolean);
  if (skills.length) return skills.slice(0, 3).join(' ');
  const words = brief.task
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, 4).join(' ') || brief.task.trim().slice(0, 40);
}

const enc = encodeURIComponent;
const slug = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

export const SITES: Record<string, SiteDef> = {
  fiverr: {
    name: 'fiverr',
    platform: 'fiverr',
    origin: 'https://www.fiverr.com',
    searchUrl: (b) => `https://www.fiverr.com/search/gigs?query=${enc(queryFor(b))}`,
    hints:
      'Fiverr gig search results. Each card is one gig: seller name, gig title, rating with review count in brackets, seller level or badge (Top Rated, Level 2, Pro), and a "From <price>" figure. Prices are fixed (starting price of the gig). Delivery time is usually not shown on cards.',
    profileUrlPattern:
      /^https:\/\/www\.fiverr\.com\/(?!search|categories|cp|pro|business|resources|support|learn|become|stories|press|about|legal|logo-maker|go|gigs|sellers\/?$)[^/?#]+\/[^/?#]+/i,
  },
  peopleperhour: {
    name: 'peopleperhour',
    platform: 'peopleperhour',
    origin: 'https://www.peopleperhour.com',
    searchUrl: (b) => `https://www.peopleperhour.com/services?q=${enc(queryFor(b))}`,
    hints:
      'PeoplePerHour listings ("Hourlies" are fixed-price offers; freelancer cards may show an hourly rate). Each card: freelancer name, offer title, rating, review count, price. A price on an Hourlie is fixed; a rate shown as "/hr" is hourly. Prices may be in GBP, EUR or USD: copy the currency symbol as shown.',
    profileUrlPattern: /^https:\/\/www\.peopleperhour\.com\/(hourlie|freelance|offer|services\/[^/?#]+\/[^/?#]+)\/[^/?#]+/i,
  },
  guru: {
    name: 'guru',
    platform: 'guru',
    origin: 'https://www.guru.com',
    // Guru's search pages are per skill: /d/freelancers/skill/<slug>/ (the /q/ form 404s).
    searchUrl: (b) => `https://www.guru.com/d/freelancers/skill/${slug(b.skills[0] ?? queryFor(b))}/`,
    hints:
      'Guru freelancer search results. Each card is a freelancer: name, headline, location, hourly rate ("$xx/hr"), earnings, rating and feedback count, skills. Rates are hourly.',
    profileUrlPattern: /^https:\/\/www\.guru\.com\/freelancers\/[^/?#]+/i,
  },
};

export const siteFor = (name: string): SiteDef | undefined => SITES[name.trim().toLowerCase()];
