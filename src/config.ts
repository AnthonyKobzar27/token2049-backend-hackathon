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

  /**
   * Booking budget escrow. 'solana-program': on-chain Anchor escrow (programs/haas-escrow);
   * 'solana-vault' (or legacy 'solana'): server-held vault wallet; 'memory': no chain.
   */
  ESCROW_PROVIDER: z.enum(['memory', 'solana', 'solana-vault', 'solana-program']).default('memory'),
  SOLANA_RPC_URL: z.string().default('https://api.devnet.solana.com'),
  SOLANA_USDC_MINT: z.string().default('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
  /** Base58 secret key of the operator wallet: pays fees, receives released funds. */
  SOLANA_OPERATOR_SECRET: optional,
  /** Deployed haas-escrow program (devnet). */
  SOLANA_ESCROW_PROGRAM_ID: z.string().default('9hzyeY6LPaQzJWszBjtYU17sHN2XmQD6FmyJFCNrs727'),
  /** Minutes the hirer has to fund escrow before the booking is cancelled. */
  ESCROW_DEPOSIT_TIMEOUT_MIN: int(60),
  /** Delivery window in days when the brief has no deadline. */
  ESCROW_DELIVERY_DAYS: int(14),
  /** Hours added after the delivery window before the escrow deadline (time to review and verify). */
  ESCROW_GRACE_HOURS: int(24),
  /** Demo override: escrow deadline this many minutes after booking, ignoring the two above. 0 = off. */
  ESCROW_DEADLINE_MIN: int(0),

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
