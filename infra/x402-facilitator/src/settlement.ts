import { ERR_SETTLEMENT_FAILED, ERR_SETTLEMENT_PENDING, withCardanoProviderTimeout, type FacilitatorCardanoSigner } from '@x402/cardano';
import type { SettleResponse } from '@x402/core/types';

/**
 * The SDK can turn a failed evidence lookup into "unknown" and then report expiry from its local
 * clock. Require a successful lookup before an expiry result lets the client pay again.
 * (Same as the reference demo, cardano-foundation/x402-cardano-demo.)
 */
export async function confirmExpiry(result: SettleResponse, signer: FacilitatorCardanoSigner): Promise<SettleResponse> {
  if (result.success || result.errorReason !== ERR_SETTLEMENT_FAILED || result.extra?.status !== 'expired') return result;
  let errorMessage = 'Settlement evidence changed while checking expiry. Check the same payment again.';
  try {
    const evidence = signer.getTransactionEvidence && (await withCardanoProviderTimeout(signer.getTransactionEvidence(result.transaction, result.network), 15_000, 'expiry evidence'));
    if (evidence?.status === 'unknown') return result;
  } catch {
    errorMessage = 'The transaction lookup is unavailable, so expiry cannot be confirmed. Check the same payment again.';
  }
  return { ...result, success: false, errorReason: ERR_SETTLEMENT_PENDING, errorMessage, extra: { ...result.extra, status: 'pending', transactionId: result.transaction } };
}
