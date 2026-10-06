import { describe, expect, it } from 'vitest';
import { toUsd } from './fx';

describe('toUsd', () => {
  it('converts known currencies, case-insensitively', () => {
    expect(toUsd(100, 'USD')).toBe(100);
    expect(toUsd(100, 'eur')).toBeCloseTo(108);
    expect(toUsd(1000, 'INR')).toBeCloseTo(12);
    for (const c of ['GBP', 'SGD', 'AUD', 'CAD', 'PKR', 'PHP', 'IDR', 'MYR', 'JPY', 'CHF', 'AED', 'BRL', 'MXN']) expect(toUsd(1, c)).toBeGreaterThan(0);
  });
  it('returns null for unknown currencies and bad amounts', () => {
    expect(toUsd(5, 'XYZ')).toBeNull();
    expect(toUsd(NaN, 'USD')).toBeNull();
  });
});
