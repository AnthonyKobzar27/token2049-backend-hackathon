import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import type { Brief } from '../domain/types';
import { createClassifier, keywordClassify } from './classify';

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

describe('createClassifier', () => {
  it('honours the env override without calling the model', async () => {
    const create = vi.fn();
    const ai = createClassifier({ config: testConfig({ AI_DELEGATION: 'ai' }), messages: { create } as never });
    expect((await ai.classify(b('Call my mum'))).kind).toBe('digital');
    const human = createClassifier({ config: testConfig({ AI_DELEGATION: 'human' }), messages: { create } as never });
    expect((await human.classify(b('Write a blog post'))).kind).toBe('human');
    expect(create).not.toHaveBeenCalled();
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
