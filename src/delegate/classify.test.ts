import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import type { Brief } from '../domain/types';
import { createClassifier, explicitHumanRequest, keywordClassify } from './classify';

const b = (task: string, extra: Partial<Brief> = {}): Brief => ({ task, skills: [], remoteOk: true, ...extra });

describe('keywordClassify', () => {
  it.each([
    'Research the top 10 Cardano DeFi protocols and summarise their TVL',
    'Translate this product description into German',
    'Write a newsletter about our launch',
    'Compile a list of VCs investing in Asia',
  ])('labels "%s" digital', (task) => expect(keywordClassify(b(task)).kind).toBe('digital'));

  it.each([
    'Call the restaurant and book a table for six',
    'Pick up my dry cleaning tomorrow',
    'Photographer at our event in Singapore',
    'Design a logo for my bakery',
  ])('labels "%s" human', (task) => expect(keywordClassify(b(task)).kind).toBe('human'));

  it('treats on-site work as human even when it sounds digital', () => {
    expect(keywordClassify(b('Research local shops', { remoteOk: false })).kind).toBe('human');
  });
});

const toolReply = (input: unknown) => ({ content: [{ type: 'tool_use', id: 't', name: 'label_work', input }] });

describe('explicitHumanRequest', () => {
  it.each([
    ['I want a real person to review my resume', 'a real person'],
    ['humans only for this one', 'humans only'],
    ['no AI please', 'no ai'],
    ['no bots', 'no bots'],
    ['definitely not a bot', 'not a bot'],
    ['I would prefer a human', 'prefer a human'],
    ['get me a human for this', 'get me a human'],
    ['this must be done by a human', 'by a human'],
    ['I need feedback from a human', 'from a human'],
    ['find a human to edit this', 'a human to'],
  ])('matches "%s"', (text, phrase) => expect(explicitHumanRequest(text)).toBe(phrase));

  it.each([
    'find someone to summarise this report',
    'write an essay about humanity',
    'help someone fix my spreadsheet',
    'repair my air conditioner listing copy',
  ])('does not match "%s"', (text) => expect(explicitHumanRequest(text)).toBeNull());
});

describe('createClassifier', () => {
  it('routes an explicit human request to a human without calling the model', async () => {
    const create = vi.fn();
    const c = createClassifier({ config: testConfig(), messages: { create } as never });
    const r = await c.classify(b('I want a real person to review my resume'));
    expect(r).toMatchObject({ kind: 'human', via: 'override', confidence: 1 });
    expect(r.reason).toBe('The requester asked for a human ("a real person").');
    expect(create).not.toHaveBeenCalled();
  });

  it('lets an explicit human request beat digital keywords', async () => {
    const c = createClassifier({ config: testConfig({ ANTHROPIC_API_KEY: undefined }) });
    // "write" is a DIGITAL keyword; the explicit request wins anyway.
    const r = await c.classify(b('no AI please, need a human to write my wedding speech'));
    expect(r).toMatchObject({ kind: 'human', via: 'override', confidence: 1 });
    expect(r.reason).toContain('no ai');
  });

  it('does not treat a generic "someone" as a human request', async () => {
    const c = createClassifier({ config: testConfig({ ANTHROPIC_API_KEY: undefined }) });
    expect(await c.classify(b('find someone to summarise this report'))).toMatchObject({ kind: 'digital', via: 'keywords' });
  });

  it('keeps plain digital work digital', async () => {
    const c = createClassifier({ config: testConfig({ ANTHROPIC_API_KEY: undefined }) });
    expect((await c.classify(b('translate my blog post'))).kind).toBe('digital');
  });

  it('uses the model label and caches by brief', async () => {
    const create = vi.fn(async () => toolReply({ kind: 'digital', reason: 'text work', confidence: 0.9 }));
    const c = createClassifier({ config: testConfig(), messages: { create } as never });
    const first = await c.classify(b('Make me a haiku about Cardano'));
    expect(first).toMatchObject({ kind: 'digital', via: 'llm', confidence: 0.9 });
    await c.classify(b('Make me a haiku about Cardano'));
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0] as unknown[])[0]).toMatchObject({ model: 'claude-haiku-4-5-20251001', tool_choice: { type: 'tool', name: 'label_work' } });
  });

  it('falls back to keywords when the model is slow', async () => {
    const create = vi.fn(
      (_body: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    const c = createClassifier({ config: testConfig({ AI_CLASSIFY_TIMEOUT_MS: 30 }), messages: { create } as never });
    const r = await c.classify(b('Summarise this whitepaper'));
    expect(r).toMatchObject({ kind: 'digital', via: 'keywords' });
    expect(r.ms).toBeLessThan(1000);
  });

  it('uses keywords without an API key', async () => {
    const c = createClassifier({ config: testConfig({ ANTHROPIC_API_KEY: undefined }) });
    expect(await c.classify(b('Translate my CV to French'))).toMatchObject({ kind: 'digital', via: 'keywords' });
  });
});
