// Dynamic job fee. Registration advertises {"pricingType":"Dynamic"}; each payment request carries the amount.
// Default: a flat 1 test USDM (the TOKEN2049 guide's quote). MASUMI_FEE_PERCENT adds a share of the brief's
// budget (USDM is a USD stablecoin with 6 decimals), capped at MASUMI_PRICE_MAX_AMOUNT.
import type { Config } from '../config';
import type { Brief } from '../domain/types';

/** Test USDM on Cardano Preprod (policy id + asset name hex). */
export const USDM_PREPROD_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
export const USDM_DECIMALS = 6;

export interface Amount {
  amount: string;
  unit: string;
}

/** "lovelace" and "" both mean ADA; the payment service wants "". */
export const normalizeUnit = (unit: string): string => (unit.trim().toLowerCase() === 'lovelace' ? '' : unit.trim());

const isUsdm = (unit: string) => normalizeUnit(unit) === USDM_PREPROD_UNIT || /745553444d$/i.test(unit); // asset name "USDM"

/** The fee for this brief, in atomic units of MASUMI_PRICE_UNIT. */
export function quoteFee(brief: Pick<Brief, 'budgetUsd'> | undefined, config: Config): Amount {
  const unit = normalizeUnit(config.MASUMI_PRICE_UNIT);
  let amount = BigInt(config.MASUMI_PRICE_AMOUNT);
  if (config.MASUMI_FEE_PERCENT > 0 && brief?.budgetUsd && isUsdm(unit)) {
    // budget * percent / 100 in USDM, in atomic units, rounded down to whole cents.
    const cents = Math.floor(brief.budgetUsd * config.MASUMI_FEE_PERCENT);
    amount += BigInt(cents) * 10n ** BigInt(USDM_DECIMALS - 2);
  }
  const max = BigInt(config.MASUMI_PRICE_MAX_AMOUNT);
  if (amount > max) amount = max;
  return { amount: amount.toString(), unit };
}

/** Human-readable amount, e.g. "1.5 USDM" or "3 ADA". */
export function formatAmount(a: Amount): string {
  const n = BigInt(a.amount);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  const value = frac ? `${whole}.${frac}` : `${whole}`;
  const unit = a.unit === '' ? 'ADA' : isUsdm(a.unit) ? 'USDM' : a.unit.slice(-16);
  return `${value} ${unit}`;
}
