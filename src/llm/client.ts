import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config';

let client: Anthropic | undefined;

/** Shared Anthropic client. Throws a clear error when the key is missing. */
export function anthropic(config: Config): Anthropic {
  if (!config.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set (put it in ~/.haas/.env)');
  client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 3 });
  return client;
}

export const hasLlm = (config: Config): boolean => Boolean(config.ANTHROPIC_API_KEY);
