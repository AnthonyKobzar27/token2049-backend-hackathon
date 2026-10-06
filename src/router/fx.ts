// Fixed approximate rates to USD. Good enough to compare quotes, not to settle payments.

const USD_PER_UNIT: Record<string, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  SGD: 0.74,
  AUD: 0.66,
  CAD: 0.73,
  NZD: 0.6,
  INR: 0.012,
  PKR: 0.0036,
  PHP: 0.0175,
  IDR: 0.000062,
  MYR: 0.22,
  THB: 0.029,
  VND: 0.00004,
  JPY: 0.0067,
  KRW: 0.00073,
  CNY: 0.139,
  HKD: 0.128,
  CHF: 1.13,
  SEK: 0.095,
  NOK: 0.093,
  DKK: 0.145,
  PLN: 0.25,
  TRY: 0.029,
  AED: 0.272,
  ZAR: 0.054,
  NGN: 0.00065,
  EGP: 0.02,
  BRL: 0.18,
  MXN: 0.055,
};

/** Amount in USD, or null for an unknown currency or a non-finite amount. */
export function toUsd(amount: number, currency: string): number | null {
  if (!Number.isFinite(amount)) return null;
  const rate = USD_PER_UNIT[currency.trim().toUpperCase()];
  return rate === undefined ? null : amount * rate;
}

export const knownCurrencies = (): string[] => Object.keys(USD_PER_UNIT);
