// CredentialIssuer: the seam between "HAAS decided this worker is verified" and the technology that
// records it. Today: a CIP-68 token pair on Cardano (Cip68CredentialIssuer). Later: a Veridian
// KERI/ACDC credential issued to the worker's identifier (AID), see docs/IDENTITY.md.

import type { ReputationChain } from './chain';
import { cip20Message, credentialAssetName, credentialDatumFields, refUnit, reputationFromFields, userUnit } from './cip68';
import type { Reputation, WorkerCredential } from './types';
import { emptyReputation } from './types';

export interface CredentialSubject {
  workerId: string;
  /** Cardano address for CIP-68; for Veridian, the worker's AID or an OOBI to resolve it. */
  walletAddress: string;
  reputation?: Reputation;
}

export interface CredentialStatus {
  /** Exists and has not been revoked. */
  valid: boolean;
  /** The worker still controls what the credential was bound to (for CIP-68: the user NFT sits at the bound wallet). */
  bound: boolean;
  holder?: string | null;
  reputation?: Reputation;
}

export interface CredentialIssuer {
  readonly kind: 'cip68' | 'veridian';
  issue(subject: CredentialSubject): Promise<WorkerCredential>;
  status(credential: WorkerCredential): Promise<CredentialStatus>;
}

export function createCip68Issuer(chain: ReputationChain, opts: { now?: () => number; image?: string } = {}): CredentialIssuer {
  const now = opts.now ?? Date.now;
  return {
    kind: 'cip68',
    async issue({ workerId, walletAddress, reputation }) {
      const policyId = await chain.policyId();
      const assetName = credentialAssetName(workerId);
      const issuedAt = now();
      const fields = credentialDatumFields({ workerId, walletAddress, issuedAt, image: opts.image, reputation: reputation ?? emptyReputation() });
      const { txHash } = await chain.mintCredential({
        assetName,
        holder: walletAddress,
        fields,
        message: cip20Message(['HAAS Verified Worker credential', `worker ${workerId}`]),
      });
      return {
        workerId,
        walletAddress,
        issuer: 'cip68',
        network: chain.network,
        policyId,
        assetName,
        refUnit: refUnit(policyId, assetName),
        userUnit: userUnit(policyId, assetName),
        txHash,
        issuedAt,
      };
    },
    async status(cred) {
      const [ref, holder] = await Promise.all([chain.readReference(cred.assetName), chain.holderOf(cred.userUnit)]);
      if (!ref) return { valid: false, bound: false, holder };
      return { valid: ref.fields.wallet === cred.walletAddress, bound: holder === cred.walletAddress, holder, reputation: { ...reputationFromFields(ref.fields), lastUpdateTx: ref.txHash } };
    },
  };
}

/**
 * Placeholder kept for callers of this module; the implementation is createVeridianCredentialIssuer in
 * ./veridian/issuer.ts (docs/VERIDIAN.md). The design it follows:
 *  1. hold an issuer AID for HAAS in a KERIA agent (signify-ts client),
 *  2. resolve the worker's OOBI (they hold their own AID in the Veridian wallet),
 *  3. issue an ACDC "HAAS Verified Worker" credential against a published schema (SAID), with the
 *     reputation totals and the Cardano receipt units as attributes, and IPEX-grant it to the worker,
 *  4. anchor the issuance and revocation registry (TEL) events, optionally checkpointed on Cardano.
 * Not wired in: it needs a running KERIA instance and the worker's wallet in the loop.
 */
export function createVeridianIssuer(): CredentialIssuer {
  const missing = () => Promise.reject(new Error('Veridian issuer is not implemented yet; see docs/IDENTITY.md'));
  return { kind: 'veridian', issue: missing, status: missing };
}
