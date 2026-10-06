import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// Runtime state (database, Chrome profile, .env with secrets) lives outside the
// repository, which sits in a synced folder.
export const HAAS_HOME = process.env.HAAS_HOME ?? join(homedir(), '.haas');

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));
const int = (def: number) => z.coerce.number().int().default(def);
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  PORT: int(8787),
  PUBLIC_URL: z.string().default('http://localhost:8787'),
  DB_PATH: z.string().default(join(HAAS_HOME, 'haas.db')),

  ANTHROPIC_API_KEY: optional,
  /** Conversation with people. */
  MODEL_CHAT: z.string().default('claude-opus-5-5'),
  /** Page extraction and suitability scoring. */
  MODEL_FAST: z.string().default('claude-haiku-4-5-20251001'),

  TELEGRAM_BOT_TOKEN: optional,
  /** Telegram user id that receives approvals and operator alerts. */
  TELEGRAM_OPERATOR_ID: optional,

  /** Comma-separated source names to enable; unset means every configured source. */
  SOURCES: optional,
  SOURCE_TIMEOUT_MS: int(60_000),
  PROFILE_CACHE_TTL_MIN: int(360),
  SHORTLIST_SIZE: int(5),
  /** Minutes an unanswered check-in stays open before the job ends with no booking. */
  CHECKIN_TIMEOUT_MIN: int(120),
  APPROVAL_TIMEOUT_MIN: int(60),

  FREELANCER_TOKEN: optional,
  FREELANCER_SANDBOX_TOKEN: optional,
  RENTAHUMAN_API_KEY: optional,

  /** Upwork GraphQL API: a user token, or an Enterprise app's client credentials. */
  UPWORK_ACCESS_TOKEN: optional,
  UPWORK_CLIENT_ID: optional,
  UPWORK_CLIENT_SECRET: optional,
  /** Organization id sent as X-Upwork-API-TenantId, when the token has several. */
  UPWORK_TENANT_ID: optional,
  /** Upwork's own search timeout, kept below SOURCE_TIMEOUT_MS. */
  UPWORK_TIMEOUT_MS: int(8_000),

  /** Prolific participant pool. Unset token disables it. */
  PROLIFIC_API_TOKEN: optional,
  /** Project new draft studies go into (Prolific workspaces). */
  PROLIFIC_PROJECT_ID: optional,
  /** Task link used when the brief carries none (survey, labeling tool). */
  PROLIFIC_TASK_URL: optional,
  PROLIFIC_TIMEOUT_MS: int(5_000),
  /** Reward rate offered to participants, USD per hour (Prolific's minimum is about 8). */
  PROLIFIC_HOURLY_REWARD_USD: z.coerce.number().default(12),
  PROLIFIC_DEFAULT_PLACES: int(20),
  PROLIFIC_DEFAULT_MINUTES: int(10),

  /** Chrome DevTools endpoint of the operator's own logged-in browser. */
  CHROME_CDP_URL: z.string().default('http://127.0.0.1:9222'),
  /** Comma-separated browser-read sites, e.g. "fiverr,peopleperhour". */
  BROWSER_SITES: z.string().default('fiverr'),

  /** Masumi job fee. Unset MASUMI_API_KEY means jobs start without payment. */
  MASUMI_API_URL: z.string().default('http://localhost:3001/api/v1'),
  MASUMI_API_KEY: optional,
  MASUMI_NETWORK: z.enum(['Preprod', 'Mainnet']).default('Preprod'),
  MASUMI_AGENT_IDENTIFIER: optional,
  MASUMI_SELLER_VKEY: optional,

  /** x402 paywall on Cardano. Unset X402_PAY_TO disables it. */
  X402_FACILITATOR_URL: z.string().default('http://localhost:4022'),
  X402_NETWORK: z.string().default('cardano:preprod'),
  X402_PAY_TO: optional,
  /** Price of one routing request, in lovelace. */
  X402_PRICE_LOVELACE: int(2_000_000),
  BLOCKFROST_PROJECT_ID: optional,
  /** Mnemonic of the wallet our own client pays x402 with (spike and demo only). */
  X402_CLIENT_MNEMONIC: optional,

  /** Booking budget escrow. */
  ESCROW_PROVIDER: z.enum(['memory', 'solana']).default('memory'),
  SOLANA_RPC_URL: z.string().default('https://api.devnet.solana.com'),
  SOLANA_USDC_MINT: z.string().default('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  /** Base58 secret key of the operator wallet: pays fees, receives released funds. */
  SOLANA_OPERATOR_SECRET: optional,

  REQUIRE_APPROVAL_FOR_ROUTINE_MESSAGES: bool(false),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

/** Loads ~/.haas/.env (if present) and parses the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && cached) return cached;
  if (env === process.env) {
    mkdirSync(HAAS_HOME, { recursive: true });
    const file = join(HAAS_HOME, '.env');
    if (existsSync(file)) process.loadEnvFile(file);
  }
  const config = schema.parse(env);
  if (env === process.env) cached = config;
  return config;
}

/** Config for tests: defaults plus overrides, no file access. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...schema.parse({ DB_PATH: ':memory:' }), ...overrides };
}
