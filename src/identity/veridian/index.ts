// Veridian (Cardano Foundation KERI/ACDC stack) worker credentials. Entry point used by src/index.ts.

import type { Config } from '../../config';
import type { Store } from '../../domain/ports';
import { connectSignify, type SignifyPort } from './client';
import { createVeridianCredentialIssuer } from './issuer';
import { HAAS_WORKER_SCHEMA_SAID } from './schema';
import { createVeridianService, type VeridianService } from './service';

export const veridianConfigured = (c: Config): boolean => Boolean(c.VERIDIAN_KERIA_URL && c.VERIDIAN_KERIA_BOOT_URL && c.VERIDIAN_PASSCODE);

const list = (v: string | undefined) => (v ? v.split(';').map((s) => s.trim()).filter(Boolean) : []);

/** Null when not configured. Connects to KERIA lazily: HAAS starts even when KERIA is down. */
export function createVeridian(deps: { config: Config; store: Store; client?: SignifyPort }): VeridianService | null {
  const { config, store } = deps;
  if (!deps.client && !veridianConfigured(config)) return null;
  const oobiBaseUrl = (config.VERIDIAN_OOBI_BASE_URL ?? config.PUBLIC_URL).replace(/\/+$/, '');
  let connecting: Promise<SignifyPort> | undefined;
  const connect = () =>
    (connecting ??= connectSignify({ url: config.VERIDIAN_KERIA_URL!, bootUrl: config.VERIDIAN_KERIA_BOOT_URL!, passcode: config.VERIDIAN_PASSCODE! }).catch((err) => {
      connecting = undefined;
      throw err;
    }));
  const issuer = createVeridianCredentialIssuer(deps.client ?? connect, {
    issuerName: config.VERIDIAN_ISSUER_NAME,
    registryName: config.VERIDIAN_REGISTRY_NAME,
    schemaOobiUrl: `${oobiBaseUrl}/oobi/${HAAS_WORKER_SCHEMA_SAID}`,
    oobiBaseUrl,
    witnessOobis: list(config.VERIDIAN_WITNESS_OOBIS),
    witnessAids: list(config.VERIDIAN_WITNESS_AIDS),
    network: config.CARDANO_NETWORK,
  });
  return createVeridianService({ issuer, store, ttlMs: config.VERIDIAN_CACHE_TTL_MIN * 60_000, verifyTimeoutMs: config.VERIDIAN_VERIFY_TIMEOUT_MS });
}

export { mountVeridian } from './api';
export { combineSignals } from './service';
export type { VeridianService } from './service';
export type { VeridianCredential, VerificationResult } from './issuer';
