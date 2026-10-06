import { describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { createIntake } from './intake';

describe('intake without an API key', () => {
  const intake = createIntake({ config: testConfig({ ANTHROPIC_API_KEY: undefined }) });

  it('builds a deterministic brief from the first message', async () => {
    const r = await intake.next([{ from: 'hirer', text: 'I need a logo designed for my bakery, budget $150' }]);
    expect(r.kind).toBe('brief');
    if (r.kind !== 'brief') return;
    expect(r.brief.task).toBe('I need a logo designed for my bakery, budget $150');
    expect(r.brief.remoteOk).toBe(true);
    expect(r.brief.skills.length).toBeGreaterThan(0);
    expect(r.brief.skills.length).toBeLessThanOrEqual(5);
    expect(r.brief.skills).toContain('logo');
    expect(r.brief.budgetUsd).toBe(150);
    expect(r.summary).toContain('logo');
  });

  it('keeps the first message as the task in later turns', async () => {
    const r = await intake.next([
      { from: 'hirer', text: 'translate a manual' },
      { from: 'agent', text: 'Which languages?' },
      { from: 'hirer', text: 'German to English' },
    ]);
    expect(r.kind === 'brief' && r.brief.task).toBe('translate a manual');
  });
});
