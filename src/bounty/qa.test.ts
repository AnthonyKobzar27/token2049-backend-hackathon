import { describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { checkSubmission, rulesQa } from './qa';
import { rulesSpec } from './spec';
import { PHYSIO } from './testkit';
import type { Bounty } from './types';

const TUE = Date.UTC(2026, 9, 6, 4); // Tuesday 6 Oct 2026, noon in Singapore

function bounty(data: Record<string, string>, notes?: string): Bounty {
  return {
    id: 'bty1', code: 'K7Q2', task: PHYSIO.task, spec: rulesSpec(PHYSIO), rewardUsd: 2.22, reward: { amount: 3, currency: 'SGD' },
    status: 'submitted', mode: 'broadcast', offers: [], workerId: 'w_ana', claimBy: TUE, messages: [], createdAt: TUE, updatedAt: TUE,
    result: { data, summary: 's', ...(notes && { notes }), submittedAt: TUE },
  };
}

describe('submission check', () => {
  it('passes a booking this week', () => {
    expect(rulesQa(bounty({ date: '2026-10-08', time: '15:00', reference: '88213' }))).toMatchObject({ ok: true, issues: [], by: 'rules' });
    expect(rulesQa(bounty({ date: 'Thursday', time: '3pm', reference: 'A1' })).ok).toBe(true);
  });

  it('flags past dates, dates outside this week, bad times and empty references', () => {
    expect(rulesQa(bounty({ date: '2026-10-01', time: '15:00', reference: '88213' })).issues).toEqual(['Date 2026-10-01 is in the past.']);
    expect(rulesQa(bounty({ date: '2026-10-30', time: '15:00', reference: '88213' })).issues).toEqual(['Date 2026-10-30 is not this week.']);
    expect(rulesQa(bounty({ date: '2026-10-08', time: '27:00', reference: '-' })).issues).toEqual(['Time 27:00 is not a valid time.', 'Reference number "-" does not look like a reference.']);
  });

  it('flags a booking whose notes say it could not be done', () => {
    expect(rulesQa(bounty({ date: '2026-10-08', time: '15:00', reference: '88213' }, 'They were fully booked')).ok).toBe(false);
  });

  it('uses rules only when no model key is set', async () => {
    expect((await checkSubmission(bounty({ date: '2026-10-08', time: '15:00', reference: '88213' }), testConfig())).by).toBe('rules');
  });
});
