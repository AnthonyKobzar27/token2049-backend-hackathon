import { describe, expect, it } from 'vitest';
import { cleanForFreelancer, outreachMessage, taskForFreelancer, titleForFreelancer } from './outreach';

const brief = {
  task: 'SAT tutoring session tomorrow at 3pm with an experienced SAT tutor, budget around $20/hour.',
  skills: ['SAT tutor'],
  remoteOk: true,
  hoursNeeded: 2,
  notes: 'Budget is $20/hour. Format (online vs in person) and session length not specified; defaulted to a 2 hour window. No filtering by appearance, ethnicity or gender. Student is in grade 11.',
  when: { date: '2026-10-08', window: { start: '15:00', end: '17:00' } },
};

describe('outreach to freelancers', () => {
  it('reads like a person booking someone, with no internals or crypto', () => {
    const m = outreachMessage(brief, 40);
    expect(m).toMatch(/^Hey! Looking to book someone for this: SAT tutoring session tomorrow at 3pm with an experienced SAT tutor\./);
    expect(m).toContain('When: Thu 8 Oct, 15:00-17:00');
    expect(m).toContain('about 2 hours');
    expect(m).toContain('Budget is about $40.');
    expect(m).toContain('Student is in grade 11.');
    expect(m).not.toMatch(/default|not specified|filtering|ethnicity|escrow|crypto|solana|cardano|usdc|haas|agent/i);
  });

  it('drops payment-rail and agent sentences anywhere', () => {
    expect(cleanForFreelancer('Paid in USDC on Solana. Bring an umbrella. HAAS agent will confirm.')).toBe('Bring an umbrella.');
  });

  it('makes a short title and strips the budget from the task', () => {
    expect(taskForFreelancer({ ...brief, task: 'design a logo for my bakery, budget $50' })).toBe('Design a logo for my bakery.');
    expect(titleForFreelancer(brief)).toBe('SAT tutoring session tomorrow at 3pm with an experienced SAT tutor');
  });
});
