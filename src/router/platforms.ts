// Which platforms fit a brief. Physical, on-site work (waiting in line, errands, pick-ups, checking
// something in person) needs a person who can be there: RentAHuman and the local bounty board.
// Freelance marketplaces (Fiverr, Freelancer.com, PeoplePerHour, Guru, Upwork) sell remote,
// skilled work. Short research microtasks (surveys, labelling) suit Prolific's participant pool.

import { looksOnSite } from '../agent/extract';
import type { Brief } from '../domain/types';

export type WorkKind = 'in_person' | 'remote' | 'microtask';

/** Sources that send a person somewhere. */
const IN_PERSON = ['rentahuman', 'bounty'];
/** Marketplaces for remote, skilled work. */
const REMOTE = ['fiverr', 'freelancer', 'peopleperhour', 'guru', 'upwork', 'upwork-browser'];
/** Participant pools for short tasks done by many people. */
const MICRO = ['prolific'];
/** Test fixtures are never filtered out (demo floor). */
const ALWAYS = ['fake'];

const MICROTASK = /\b(survey|questionnaire|label(l)?ing|annotat|user (test|study|research)|participants?|respondents?|rate (images|texts|answers))\b/i;

export function workKind(brief: Brief): WorkKind {
  if (brief.taskType === 'in_person' || brief.remoteOk === false) return 'in_person';
  const text = [brief.task, brief.notes].filter(Boolean).join(' ');
  // The intake model's judgement (taskType) wins; keyword rules only fill in when there is none.
  if (!brief.taskType && looksOnSite(text)) return 'in_person';
  if (MICROTASK.test(text)) return 'microtask';
  return 'remote';
}

/** Every platform this policy knows; sources outside it (tests, new adapters) are never filtered. */
export const KNOWN_PLATFORMS = [...new Set([...IN_PERSON, ...REMOTE, ...MICRO])];

export interface PlatformChoice {
  kind: WorkKind;
  /** Source names to search. */
  sources: string[];
  /** Known platforms that do not fit this work (skipped). */
  skip: string[];
  /** One line for the person: where HAAS looks and why. */
  why: string;
}

export function choosePlatforms(brief: Brief): PlatformChoice {
  const kind = workKind(brief);
  const choice = pick(kind);
  return { ...choice, skip: KNOWN_PLATFORMS.filter((p) => !choice.sources.includes(p)) };
}

function pick(kind: WorkKind): Omit<PlatformChoice, 'skip'> {
  switch (kind) {
    case 'in_person':
      return {
        kind,
        sources: [...IN_PERSON, ...ALWAYS],
        why: 'This needs someone there in person, so I am searching RentAHuman and local workers, not online freelance marketplaces.',
      };
    case 'microtask':
      return {
        kind,
        sources: [...MICRO, ...REMOTE, 'bounty', ...ALWAYS],
        why: 'This is a short task many people can do online, so I am searching Prolific and the freelance marketplaces.',
      };
    default:
      return {
        kind,
        // The bounty board (HAAS's own verified local workers) also takes quick remote jobs like phone calls.
        sources: [...REMOTE, 'bounty', ...ALWAYS],
        why: 'This can be done remotely, so I am searching freelance marketplaces (Fiverr, Freelancer.com, PeoplePerHour, Guru).',
      };
  }
}
