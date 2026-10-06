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
  /** Ed25519 seed (64 hex chars) that signs /provide_input responses. Unset: generated once and kept in the database. */
  MASUMI_SIGNING_KEY: optional,
  /** Accept /provide_input without input_schema_hash (pre 2026-03 MIP-003 clients). A wrong hash is always rejected. */
  MASUMI_LENIENT_SCHEMA_HASH: bool(false),
  /** Must match the registration: Dynamic sends RequestedFunds with every payment request, Fixed sends none. */
  MASUMI_PRICING_TYPE: z.enum(['Dynamic', 'Fixed']).default('Dynamic'),
  /** Asset of the Dynamic job fee: policy id + asset name hex (default test USDM on Preprod); "" or "lovelace" for ADA. */
  MASUMI_PRICE_UNIT: z.string().default('16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d'),
  /** Base job fee in atomic units (USDM has 6 decimals: 1000000 = 1 USDM). */
  MASUMI_PRICE_AMOUNT: z.string().regex(/^[1-9]\d{0,18}$/).default('1000000'),
  /** Adds this percent of the brief's budget_usd to the fee (USDM only, 1 USDM = 1 USD). 0 keeps the flat fee. */
  MASUMI_FEE_PERCENT: z.coerce.number().min(0).max(100).default(0),
  /** Ceiling of the quoted fee in atomic units. */
  MASUMI_PRICE_MAX_AMOUNT: z.string().regex(/^[1-9]\d{0,18}$/).default('25000000'),
  /** Index of our Cardano source in the registry entry; unset means look it up. */
  MASUMI_SUPPORTED_PAYMENT_SOURCE_INDEX: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(0).max(24).optional()),
  /**
   * Payment deadlines for MIP-003 jobs, in minutes from start (unlock and dispute: after the previous deadline).
   * The result window covers search and the human check-in; it does not pause while a human answers. Values below
   * the payment service's minimums are raised to them (result 16, unlock 16, dispute 16, pay at most result - 5).
   */
  MASUMI_PAY_WINDOW_MIN: int(20),
  MASUMI_RESULT_WINDOW_MIN: int(90),
  MASUMI_UNLOCK_DELAY_MIN: int(16),
  MASUMI_DISPUTE_DELAY_MIN: int(16),

  /** Sokosumi Coworker worker (Tasks). It runs when both SOKOSUMI_COWORKER_ID and SOKOSUMI_COWORKER_API_KEY are set. */
  SOKOSUMI_COWORKER_ID: optional,
  /** The Coworker's coworker_* runtime key (Preprod). Not the Masumi payment service key. */
  SOKOSUMI_COWORKER_API_KEY: optional,
  SOKOSUMI_API_URL: z.string().default('https://api.preprod.sokosumi.com'),
  /** Only take Tasks of this organization; "personal" means the Personal Workspace only. Unset: every Task assigned to the Coworker. */
  SOKOSUMI_ORGANIZATION_ID: optional,
  SOKOSUMI_POLL_MS: int(10_000),
  /** Charge each Task the Masumi job fee through a masumiPayment event (needs MASUMI_* set and a confirmed Dynamic registration). */
  SOKOSUMI_PAID_TASKS: bool(false),
  /** Payment deadlines for paid Tasks, in minutes (no human check-in, so shorter than the MIP-003 ones): unlock about 45 min after start. */
  SOKOSUMI_PAY_WINDOW_MIN: int(15),
  SOKOSUMI_RESULT_WINDOW_MIN: int(25),
  SOKOSUMI_UNLOCK_DELAY_MIN: int(16),
  SOKOSUMI_DISPUTE_DELAY_MIN: int(16),
  /** How long one HAAS run on a Task may take before the Task fails. */
  SOKOSUMI_RUN_TIMEOUT_MIN: int(15),
  /** Contract address of our V2 payment source, for masumiPayment.PaymentSource when the payment service does not return it. */
  MASUMI_SMART_CONTRACT_ADDRESS: optional,

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
