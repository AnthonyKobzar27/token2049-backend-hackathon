import { describe, expect, it } from 'vitest';
import type { Brief } from '../domain/types';
import { cleanForFreelancer, freelancerSafe, outreachMessage, taskForFreelancer, titleForFreelancer } from './outreach';

// Briefs as the LLM intake writes them: clunky task text, bookkeeping notes, budget repeated.
const satTutor: Brief = {
  task: 'SAT tutoring session tomorrow at 3pm with an experienced SAT tutor, budget around $20/hour.',
  skills: ['SAT tutor'],
  remoteOk: true,
  hoursNeeded: 2,
  notes: 'Budget is $20/hour. Format (online vs in person) and session length not specified; defaulted to a 2 hour window. No filtering by appearance, ethnicity or gender. Student is in grade 11.',
  when: { date: '2026-10-08', window: { start: '15:00', end: '17:00' } },
};

const waitInLine: Brief = {
  task: 'Wait in line at the Pop Mart store on Orchard Road tomorrow morning to buy the new Labubu release',
  skills: ['queueing'],
  remoteOk: false,
  location: 'Singapore',
  hoursNeeded: 3,
  notes: 'Budget is SGD 60. I will pay for the figure separately. Payment in USDC via escrow on Solana.',
  when: { date: '2026-10-09', window: { start: '08:00', end: '11:00' }, timezone: 'Asia/Singapore' },
};

const logo: Brief = {
  task: 'Find a graphic designer to design a logo for my bakery, budget $50',
  skills: ['logo design'],
  remoteOk: true,
  deadlineDays: 5,
  notes: 'Bakery is called Crumb & Co. Warm colours, nothing corporate. Assumed vector files are needed.',
};

const translation: Brief = {
  task: 'Translate a 2-page rental contract from German to English with a native translator',
  skills: ['German translation'],
  remoteOk: true,
  deadlineDays: 2,
  hoursNeeded: 3,
  notes: 'Requester is an AI agent on Masumi. Legal terms matter.',
};

const NEVER = /\b(haas|human as a service|ai|agents?|bots?|escrow|crypto\w*|blockchain|wallets?|solana|cardano|usdc|masumi|sokosumi|default\w*|not specified|filtering|ethnicity|gender|requester)\b/i;

describe('outreach to freelancers', () => {
  it('books an SAT tutor like a person would, with no duplicate budget or intake notes', () => {
    expect(outreachMessage(satTutor, 40)).toBe(
      [
        'Hey! Need someone for this: SAT tutoring session.',
        'Where: online',
        'When: Thu 8 Oct, 15:00-17:00, about 2 hours',
        'Budget is around $40.',
        'Student is in grade 11.',
        "You free? If so, send me an offer and I'll book it. Thanks!",
      ].join('\n'),
    );
  });

  it('asks for someone to wait in line in Singapore, lowercasing the task after the colon', () => {
    expect(outreachMessage(waitInLine, 45)).toBe(
      [
        'Hey! Need someone for this: wait in line at the Pop Mart store on Orchard Road to buy the new Labubu release.',
        'Where: Singapore',
        'When: Fri 9 Oct, 08:00-11:00 (Asia/Singapore), about 3 hours',
        'Budget is around $45.',
        'I will pay for the figure separately.',
        "You free? If so, send me an offer and I'll book it. Thanks!",
      ].join('\n'),
    );
  });

  it('turns "find a designer to…" into the job itself', () => {
    expect(outreachMessage(logo, 50, { ask: 'Let me know if you can do it. Thanks!' })).toBe(
      [
        'Hey! Need someone for this: design a logo for my bakery.',
        'Need it done within 5 days.',
        'Budget is around $50.',
        'Bakery is called Crumb & Co. Warm colours, nothing corporate.',
        'Let me know if you can do it. Thanks!',
      ].join('\n'),
    );
  });

  it('drops "with a native translator" and the agent sentence from a translation job', () => {
    const m = outreachMessage(translation, 60);
    expect(m.split('\n')[0]).toBe('Hey! Need someone for this: translate a 2-page rental contract from German to English.');
    expect(m).toContain('Need it done within 2 days, should take about 3 hours.');
    expect(m).toContain('Legal terms matter.');
  });

  it('keeps the role when the task names it ("find an SAT tutor for…")', () => {
    const b: Brief = { task: 'Find an SAT tutor for 2 hours of math prep', skills: ['SAT tutoring'], remoteOk: true };
    expect(outreachMessage(b, 80).split('\n')[0]).toBe('Hey! Looking for an SAT tutor for 2 hours of math prep.');
    expect(titleForFreelancer(b)).toBe('SAT tutor for 2 hours of math prep');
  });

  it.each([satTutor, waitInLine, logo, translation])('never mentions internals, AI or crypto, and stays short (%#)', (b) => {
    for (const m of [outreachMessage(b, 40), outreachMessage(b, 40, { greeting: false }), titleForFreelancer(b), taskForFreelancer(b)]) {
      expect(m).not.toMatch(NEVER);
      expect(m.split('\n').length).toBeLessThanOrEqual(6);
      expect(m).not.toMatch(/budget is \$\d+\/hour/i);
    }
  });

  it('is deterministic', () => {
    expect(outreachMessage(waitInLine, 45)).toBe(outreachMessage({ ...waitInLine }, 45));
  });

  it('keeps relative days and times when the brief has no concrete When', () => {
    expect(taskForFreelancer({ task: 'Call the clinic tomorrow at 3pm', skills: [], remoteOk: true })).toBe('Call the clinic tomorrow at 3pm.');
    expect(taskForFreelancer({ task: 'Call the clinic tomorrow at 3pm', skills: [], remoteOk: true, when: { date: '2026-10-08' } })).toBe('Call the clinic at 3pm.');
    expect(taskForFreelancer({ task: 'Math tutoring every Saturday, starting this Saturday', skills: [], remoteOk: true, when: { date: '2026-10-10' } })).toBe('Math tutoring every Saturday.');
  });

  it('drops payment-rail and agent sentences anywhere', () => {
    expect(cleanForFreelancer('Paid in USDC on Solana. Bring an umbrella. HAAS agent will confirm.')).toBe('Bring an umbrella.');
    expect(freelancerSafe('Sure, 5pm works.\nThe escrow is funded. See you then!')).toBe('Sure, 5pm works.\nSee you then!');
  });

  it('makes a short title and strips the budget from the task', () => {
    expect(taskForFreelancer({ ...satTutor, task: 'design a logo for my bakery, budget $50' })).toBe('Design a logo for my bakery.');
    expect(titleForFreelancer(satTutor)).toBe('SAT tutoring session');
    expect(titleForFreelancer(waitInLine)).toBe('Wait in line at the Pop Mart store on Orchard Road to buy the new Labubu release');
  });

  it('never sends an empty task when every sentence was internal', () => {
    expect(taskForFreelancer({ task: 'Have a HAAS agent pay in USDC.', skills: ['data entry'], remoteOk: true })).toBe('Data entry.');
  });
});
