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

  /**
   * x402 paywall, chain-pluggable (src/payments/x402-networks.ts, docs/X402.md).
   * Comma-separated networks offered in one 402: cardano:preprod | cardano:mainnet | solana:devnet |
   * solana:mainnet (or Solana CAIP-2 ids). A network without its pay-to address is skipped;
   * no payable network disables the paywall.
   */
  X402_NETWORK: z.string().default('cardano:preprod,solana:devnet'),
  /** auto = the chain's stablecoin (USDM on Cardano, USDC on Solana). ADA prices Cardano in lovelace. */
  X402_ASSET: z
    .string()
    .default('auto')
    .transform((v) => v.trim().toUpperCase())
    .pipe(z.enum(['AUTO', 'USDM', 'USDC', 'ADA'])),
  /** Price of one routing request in USD, charged in the stablecoin. */
  X402_PRICE_USD: z.coerce.number().positive().default(0.5),
  /** Cardano receiving address (addr_test1... on preprod). */
  X402_PAY_TO: optional,
  /** Cardano facilitator. Unset: the Cardano Foundation's hosted one for the network. */
  X402_FACILITATOR_URL: optional,
  /** Tried when the Cardano facilitator above is unreachable at startup: the self-hosted one (infra/x402-facilitator). "off" disables. */
  X402_FACILITATOR_FALLBACK_URL: z.string().default('http://localhost:4022'),
  /** USDM unit (policyId + asset name hex) on Cardano. Unset: Masumi's USDM for the network. */
  X402_CARDANO_USDM_UNIT: optional,
  /** Price of one routing request when X402_ASSET=ADA, in lovelace. */
  X402_PRICE_LOVELACE: int(2_000_000),
  /** Solana receiving wallet (base58). */
  X402_SOLANA_PAY_TO: optional,
  /** Solana facilitator; x402.org serves devnet only, mainnet needs e.g. the Coinbase CDP one. */
  X402_SOLANA_FACILITATOR_URL: z.string().default('https://x402.org/facilitator'),
  /** Base58 secret key of the wallet our own client pays x402 with on Solana (spike and demo only). */
  X402_SOLANA_CLIENT_SECRET: optional,
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
