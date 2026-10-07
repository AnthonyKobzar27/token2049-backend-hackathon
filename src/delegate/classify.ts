// "Can an AI agent do it?" Labels a brief as digital (another Masumi AI agent can do it) or human.
// Fast model with forced tool output, a hard timeout, a keyword fallback and a per-brief cache.
import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config';
import type { Brief } from '../domain/types';
import { anthropic, hasLlm } from '../llm/client';
import { canonicalJson } from '../masumi/hash';

export type WorkKind = 'digital' | 'human';

export interface Classification {
  kind: WorkKind;
  reason: string;
  /** 0 to 1. */
  confidence: number;
  via: 'override' | 'llm' | 'keywords';
  ms: number;
}

export interface Classifier {
  classify(brief: Brief): Promise<Classification>;
}

const TOOL_NAME = 'label_work';

const SYSTEM = `You triage work requests for a router that can hire either an AI agent or a human freelancer.
Label the request "digital" when an AI agent working only with text and the internet can fully deliver it: research, summarising, translating text, writing or editing copy, data lookup, drafting documents, simple analysis.
Label it "human" when it needs a person: phone calls, anything in person or on site, physical errands or deliveries, handling physical objects, signing or legally binding acts, work on platforms that require a human account, or taste and judgment the requester clearly wants from a person (e.g. a professional designer, a lawyer, a tutor).
When unsure, choose "human". Answer only by calling the tool.`;

// The requester explicitly asked for a person. Kept tight (word-boundary phrases) so that
// generic words like "someone" never match. Any hit skips the AI path entirely.
const EXPLICIT_HUMAN = [
  /\ba real person\b/,
  /\ban actual person\b/,
  /\ba real human\b/,
  /\bhumans? only\b/,
  /\bno ai\b/,
  /\bno bots?\b/,
  /\bno agents?\b/,
  /\bnot a bot\b/,
  /\bnot an ai\b/,
  /\bprefer a human\b/,
  /\bwant a human\b/,
  /\bneed a human\b/,
  /\bhire a human\b/,
  /\bget me a human\b/,
  /\bby a human\b/,
  /\bfrom a human\b/,
  /\ba human to\b/,
];

/** The phrase with which the requester explicitly asked for a person, or null. */
export function explicitHumanRequest(text: string): string | null {
  const t = text.toLowerCase();
  for (const r of EXPLICIT_HUMAN) {
    const m = t.match(r);
    if (m) return m[0];
  }
  return null;
}

// Physical, in-person or person-gated work. Checked first: any hit means human.
const HUMAN = [
  /\b(phone|call|calls|calling|ring|voice ?mail)\b/,
  /\b(in[- ]person|on[- ]site|onsite|face[- ]to[- ]face|meet(ing)? (up|with)|visit|show ?up|attend)\b/,
  /\b(pick ?up|drop ?off|courier|errands?|grocer(y|ies)|queue|stand in line|walk (my|the) dog|cleaning|move (house|furniture)|assemble|repair|plumb(er|ing)?|handyman)\b/,
  /\b(photographer|videographer|filming at|photos? at)\b/,
  /\b(sign (for|the|a) (contract|document|package)|notar\w*|witness|power of attorney)\b/,
  /\b(babysit\w*|nanny|caregiv\w*|nurse|massage|haircut|driver|drive (me|to))\b/,
  /\b(mystery shop\w*|inspect(ion)? (the|a|my) (property|apartment|house|car))\b/,
];

// Work an AI agent can do end to end.
const DIGITAL = [
  /\b(research|look ?up|find out|fact[- ]check|compare)\b/,
  /\b(summari[sz]e|summary|tl;?dr|digest|condense)\b/,
  /\b(translat(e|ion)|proofread|copy ?edit|rewrite|paraphrase)\b/,
  /\b(write|draft|copy(writing)?|blog|article|newsletter|tweet|caption|tagline|slogan|press release|product description|seo)\b/,
  /\b(data (entry|lookup|extraction|cleaning)|scrape|spreadsheet|csv|list of|compile)\b/,
  /\b(analy[sz]e|analysis|report on|market (research|size|sizing)|competitors?)\b/,
];

export function keywordClassify(brief: Brief): Omit<Classification, 'ms'> {
  const text = `${brief.task} ${brief.skills.join(' ')} ${brief.notes ?? ''}`.toLowerCase();
  if (brief.remoteOk === false) return { kind: 'human', reason: 'Must be done on site.', confidence: 0.9, via: 'keywords' };
  for (const r of HUMAN) {
    const m = text.match(r);
    if (m) return { kind: 'human', reason: `Needs a person ("${m[0]}").`, confidence: 0.75, via: 'keywords' };
  }
  for (const r of DIGITAL) {
    const m = text.match(r);
    if (m) return { kind: 'digital', reason: `Digital work an AI agent can do ("${m[0]}").`, confidence: 0.6, via: 'keywords' };
  }
  return { kind: 'human', reason: 'No clear sign an AI agent can do it; defaulting to a human.', confidence: 0.4, via: 'keywords' };
}

export const briefKey = (brief: Brief): string => createHash('sha256').update(canonicalJson(brief)).digest('hex').slice(0, 32);

type Messages = Pick<Anthropic['messages'], 'create'>;

export function createClassifier(deps: { config: Config; messages?: Messages; now?: () => number }): Classifier {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const llm = Boolean(deps.messages) || hasLlm(config);
  const cache = new Map<string, Promise<Omit<Classification, 'ms'>>>();

  async function viaLlm(brief: Brief, signal: AbortSignal): Promise<Omit<Classification, 'ms'>> {
    const messages = deps.messages ?? anthropic(config).messages;
    const request = {
      task: brief.task,
      skills: brief.skills,
      notes: brief.notes,
      remote_ok: brief.remoteOk,
      location: brief.location,
    };
    const res = await messages.create(
      {
        model: config.MODEL_FAST,
        max_tokens: 200,
        system: SYSTEM,
        messages: [{ role: 'user', content: `Request:\n${JSON.stringify(request)}` }],
        tools: [
          {
            name: TOOL_NAME,
            description: 'Record whether an AI agent can do this work.',
            input_schema: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['digital', 'human'] },
                confidence: { type: 'number', description: '0 to 1' },
                reason: { type: 'string', description: 'One short sentence' },
              },
              required: ['kind', 'reason'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: TOOL_NAME },
      },
      { signal, maxRetries: 0 },
    );
    for (const block of res.content) {
      if (block.type !== 'tool_use' || block.name !== TOOL_NAME) continue;
      const input = block.input as { kind?: unknown; reason?: unknown; confidence?: unknown };
      if (input.kind !== 'digital' && input.kind !== 'human') break;
      const confidence = typeof input.confidence === 'number' ? Math.min(1, Math.max(0, input.confidence)) : 0.7;
      return { kind: input.kind, reason: typeof input.reason === 'string' ? input.reason : '', confidence, via: 'llm' };
    }
    throw new Error('classifier returned no label');
  }

  async function decide(brief: Brief): Promise<Omit<Classification, 'ms'>> {
    if (!llm) return keywordClassify(brief);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.AI_CLASSIFY_TIMEOUT_MS);
    try {
      return await viaLlm(brief, ctrl.signal);
    } catch (err) {
      console.error(`[delegate] classifier fell back to keywords: ${(err as Error).message}`);
      return keywordClassify(brief);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async classify(brief) {
      const start = now();
      // The only way around agents-first: the requester explicitly asked for a person.
      const asked = explicitHumanRequest(`${brief.task} ${brief.notes ?? ''}`);
      if (asked) return { kind: 'human', reason: `The requester asked for a human ("${asked}").`, confidence: 1, via: 'override', ms: 0 };
      const key = briefKey(brief);
      let p = cache.get(key);
      if (!p) {
        p = decide(brief);
        cache.set(key, p);
        // A keyword answer caused by an LLM error is not worth keeping.
        if (llm) void p.then((r) => r.via === 'keywords' && cache.delete(key));
        if (cache.size > 500) cache.delete(cache.keys().next().value!);
      }
      return { ...(await p), ms: now() - start };
    },
  };
}
