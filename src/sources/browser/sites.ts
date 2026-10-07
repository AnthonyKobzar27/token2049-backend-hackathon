import type { Brief, Platform } from '../../domain/types';
import type { ContactSpec } from './contact';
import { queryVariants } from '../http';

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
  /** How to message a freelancer from their profile or gig page (the booking step). */
  contact?: ContactSpec;
}

/** Search words: the brief's skills, else skill words from the task (no filler, days, times or budgets). */
export function queryFor(brief: Brief): string {
  return queryVariants(brief.skills, brief.task)[0] ?? brief.task.trim().slice(0, 40);
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
    contact: { button: /^\s*(contact( me| seller)?|message( seller)?)\s*$/i, send: /^\s*send( message)?\s*$/i },
  },
  peopleperhour: {
    name: 'peopleperhour',
    platform: 'peopleperhour',
    origin: 'https://www.peopleperhour.com',
    // /services?q= ignores the query; /services/<words joined by +> searches.
    searchUrl: (b) => `https://www.peopleperhour.com/services/${queryFor(b).split(/\s+/).filter(Boolean).map(enc).join('+')}`,
    hints:
      'PeoplePerHour listings ("Hourlies" are fixed-price offers; freelancer cards may show an hourly rate). Each card: freelancer name, offer title, rating, review count, price. A price on an Hourlie is fixed; a rate shown as "/hr" is hourly. Prices may be in GBP, EUR or USD: copy the currency symbol as shown.',
    profileUrlPattern: /^https:\/\/www\.peopleperhour\.com\/(hourlie|freelance|offer|services\/[^/?#]+\/[^/?#]+)\/[^/?#]+/i,
    contact: { button: /^\s*(contact( me| seller| freelancer)?|ask a question|send (a )?message|message)\s*$/i, send: /^\s*send( message)?\s*$/i },
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
    contact: { button: /^\s*(get a quote|contact( me)?|send (a )?message|message)\s*$/i, send: /^\s*(send( message| quote request)?|submit)\s*$/i },
  },
  // Fallback for operators without Upwork API access; named apart from the API source "upwork".
  // Same caveats as Fiverr: reading Upwork with automation is against its terms, so it is opt-in,
  // runs at human pace in the operator's own logged-in Chrome, and stops at the first human check.
  'upwork-browser': {
    name: 'upwork-browser',
    platform: 'upwork',
    origin: 'https://www.upwork.com',
    searchUrl: (b) => `https://www.upwork.com/nx/search/talent/?q=${enc(queryFor(b))}`,
    hints:
      'Upwork talent search results. Each card is one freelancer: name (first name and last initial), title, location, hourly rate ("$xx/hr"), Job Success percentage, badges (Top Rated, Top Rated Plus, Rising Talent), total earned, and skills. Rates are hourly. Put the Job Success percentage and badge in the level field. Ratings in stars are usually not shown on cards.',
    profileUrlPattern: /^https:\/\/www\.upwork\.com\/freelancers\/~[0-9a-z]+/i,
  },
};

export const siteFor = (name: string): SiteDef | undefined => SITES[name.trim().toLowerCase()];
