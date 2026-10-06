# Worker identity and on-chain reputation

**Agents can hire a human through HAAS. This part lets the next agent check, on Cardano, whether that human has delivered before.**

Freelancer reviews are stuck inside each platform, and nothing outside that platform can verify them. HAAS records two things on Cardano Preprod for every worker it books:

1. **A "HAAS Verified Worker" credential.** A CIP-68 token pair: a reference NFT that carries the worker's record, and a user NFT in the worker's own wallet.
2. **Reputation from completed jobs.** Each completed, verified, paid job updates the credential's datum (jobs completed, average rating, total earned, last job). It also mints a job receipt NFT to the worker, linking the Masumi job id, the hash of the verified result and the payment transaction.

The router reads this back when it ranks candidates. A verified worker gets a small, capped boost and a line in the reason, such as *"on-chain verified, 7 jobs completed on HAAS"*. Any agent can check the same facts on Cardanoscan without asking HAAS.

## How it fits together

```
booking.updated (completed) ─┐
verification.completed (QA) ─┼─> ReputationMinter ── queue per booking, retries, idempotent
payment.collected (Masumi)  ─┘          │
                                        ▼
                          IdentityRegistry (wallet binding, credential, cache)
                                        │
                     CredentialIssuer ──┤── Cip68CredentialIssuer (today)
                                        │   VeridianIssuer (KERI/ACDC, later)
                                        ▼
                          ReputationChain ── Mesh SDK + Blockfrost (preprod)
                                        │    in-memory chain (tests, demo)
                                        ▼
       Router: cache-only signals() ── boost + reason   GET /workers/:id/reputation
```

| File | Role |
|---|---|
| `src/identity/cip68.ts` | Asset names, the CIP-68 datum (encode and decode), CIP-25 and CIP-20 metadata, Cardanoscan links. Pure functions. |
| `src/identity/chain.ts` | `ReputationChain` port, plus an in-memory chain for tests and demos |
| `src/identity/mesh.ts` | The live chain: Mesh `MeshTxBuilder`, `MeshWallet` and `BlockfrostProvider` |
| `src/identity/issuer.ts` | `CredentialIssuer` interface, the CIP-68 issuer and the Veridian placeholder |
| `src/identity/registry.ts` | `IdentityRegistry`: issue a credential, look a worker up by id or wallet, cached chain checks, ranking signals |
| `src/identity/minter.ts` | `ReputationMinter`: listens on the EventBus and records each job on chain |
| `src/identity/api.ts` | `GET /identity`, `GET /workers/:id/reputation`, `GET /workers/by-wallet/:address/reputation` |
| `src/router/match.ts` | `onchainBoost` and `onchainReason`, which add to the existing score without changing it |

## On chain

**Policy.** A native script that only the operator key can sign, built from `CARDANO_MINT_MNEMONIC`. `IDENTITY_POLICY_LOCK_SLOT` can add a `before` time lock that freezes the policy after a set slot. The policy id is the HAAS issuer identity: a token counts only if it is under this policy.

**Credential (CIP-68).** The asset name is `HAAS-` plus 16 hex characters of `sha256(workerId)`, so it is deterministic and leaks no PII. One transaction mints both tokens:

- `(100)` reference NFT → **the operator's address**, with an inline datum: `{name, image, description, issuer, workerId, wallet, issuedAt, jobs, verifiedJobs, ratedJobs, ratingSumX100, earnedUsdCents, lastJob, lastBooking, lastResult, lastPayment, lastReceipt, prevTx, updatedAt}`. This follows CIP-68 222 (`constructor 0 [metadata map, version]`), so wallets and explorers show it as an NFT.
- `(222)` user NFT → **the worker's wallet**.
- A CIP-20 (label 674) message so the transaction is readable on any explorer.

**Reputation update, once per job.** The operator spends the reference NFT and locks it again with the new totals. This is the "updatable metadata" CIP-68 was designed for, and it costs only fees: no Plutus, no collateral. `prevTx` links each update to the one before it, so the full history can be walked on chain. The same transaction can also mint a **job receipt NFT** (`HAASJOB-` plus a hash of the booking id) to the worker, with CIP-25 (label 721) metadata:

```json
{ "haas": { "worker": "…", "job": "<Masumi blockchainIdentifier / job id>", "booking": "…",
            "result": "<sha256 of the verified result>", "resultKind": "qa | masumi-mip004 | booking",
            "qa": "pass | none", "payment": "<collection or escrow tx>", "paymentKind": "…",
            "priceUsdCents": 6000, "ratingX100": 500 } }
```

The result hash is taken from the first source available, in this order: the QA agent's verdict; the MIP-004 result hash Masumi already commits on chain for the job; a hash of the booking record. The payment reference is chosen the same way: the Masumi collection transaction; the escrow settle transaction; the escrow deposit; the Masumi blockchain identifier.

## Off the critical path

- The minter reacts to `booking.updated` with status `completed`, queues a task and returns at once. Booking never waits on Cardano, and a test checks this against a chain that never responds.
- **Idempotent per booking.** There is one task per booking id. Before writing, the minter reads the chain: if the datum's `lastBooking` already names this booking, or the receipt NFT already exists, it records the earlier success and does not mint again. This covers a crash between submitting a transaction and saving the result.
- **Retries** use exponential backoff, from 30 s up to 30 min across 8 attempts, then the task is marked `failed`. Chain writes run one at a time, because each update spends the output the previous one created, and each waits for confirmation first.
- **QA gate.** A job that fails QA is never recorded. If no QA verdict arrives within `IDENTITY_VERIFY_GRACE_MIN`, the job is recorded with `qa: none`, unless `IDENTITY_REQUIRE_VERIFICATION=true`.
- **Ranking reads only the cache.** `registry.signals()` is synchronous and starts a background refresh for stale entries (5 min TTL). A worker counts as verified only after the chain confirms two things: the datum names the bound wallet, and the user NFT is still in that wallet. The boost is 3 for the credential, plus 0.5 per job up to 10 jobs, plus or minus 2 for rating, capped at 10 points out of 100. Workers whose suitability is below 0.25 get no boost: a credential never rescues a poor fit.
- The API waits up to 4 s for a fresh chain read, then falls back to the cache and shows `checkedAt`.

## Soulbound: what this does and does not guarantee

Cardano native tokens can always be transferred, and a native-script policy cannot stop the user NFT from moving. What this design actually provides:

| Property | Status |
|---|---|
| Only HAAS can issue a credential or change reputation | **Yes.** The policy and the reference NFT are both controlled by the operator key. |
| Reputation can't be faked by the worker | **Yes.** The totals live in the operator-held reference datum, not in the worker's token. |
| Credential bound to one wallet | **Verified, not enforced.** The datum names the wallet. If the user NFT leaves it, `bound=false` and the boost drops to zero. A buyer of the token gains nothing. |
| Non-transferable user token | **No.** That would need the user NFT locked at a Plutus script that only lets the worker's key move it back to itself, plus collateral and a validator to audit. Not worth it for a hackathon; it's the next step. |
| Revocation | The operator can burn the reference NFT; `status()` then reports `valid=false` and the boost disappears. A key-signed policy also lets the operator mint more tokens, so trust rests with HAAS as the issuer, as it does with any attestation. |
| Privacy | Only hashes, ids and totals go on chain. No names, no platform profiles. |

## Veridian (KERI/ACDC) later

`CredentialIssuer` is the seam: `issue(subject)` and `status(credential)`. `createVeridianIssuer()` exists and currently throws. To make it real:

1. Run a **KERIA** agent for HAAS, use it through `signify-ts`, and create the HAAS issuer AID. Publish its OOBI.
2. Publish an ACDC **schema** for "HAAS Verified Worker" (SAID-addressed) with attributes `workerId, jobsCompleted, avgRating, totalEarnedUsd, lastJob, receiptUnits[]`.
3. The worker holds their own AID in the **Veridian wallet** and shares an OOBI. `CredentialSubject.walletAddress` becomes that AID or OOBI.
4. `issue()` creates a credential registry (TEL), issues the ACDC, and sends it to the worker with an **IPEX grant**. `status()` checks the TEL for revocation, and reputation updates are issued as a chained ACDC (edge to the previous one).
5. Optionally anchor each issuance on Cardano by putting the ACDC SAID in the receipt's CIP-25 metadata, so both views agree.

This gives a credential that is truly holder-bound and selectively disclosable, which a CIP-68 token cannot be. The cost is that verifiers must speak KERI. The CIP-68 record can stay as the public, explorer-friendly index.

## Running it

```bash
pnpm identity:demo                       # in-memory chain: credential, 3 jobs, receipts, ranking
pnpm identity:wallet                     # prints a fresh CARDANO_MINT_MNEMONIC and its preprod address
```

Fund that address with test ADA from **https://dispenser.masumi.network** (or the Cardano testnet faucet). Put `BLOCKFROST_PROJECT_ID` (a preprod project) and `CARDANO_MINT_MNEMONIC` in `~/.haas/.env`, then:

```bash
pnpm identity:mint fake:ana addr_test1…  # live credential on Preprod, prints Cardanoscan links
pnpm identity:demo --live                # live: credential + 3 reputation updates with receipts (a few minutes)
pnpm start                               # GET /workers/fake:ana/reputation
```

Costs are a few test ADA. A credential locks the minimum ADA in the two token outputs, and each job update with a receipt locks the minimum ADA in the receipt output. Both pay normal fees; no Plutus collateral is needed.

## Not done yet

- **Inbound events.** The minter listens for `verification.completed` (QA agent) and `payment.collected` (Masumi collection). Nothing in the app emits them yet. Until something does, records fall back to the MIP-004 result hash and the Masumi blockchain identifier.
- **Wallet binding** works from scripts and the registry API only. A worker-facing flow, where the worker signs a CIP-8 message to prove they own the address, is still to come.
- The live Mesh path is tested offline: real transactions are built and signed against a fake provider. It has not yet been run against Preprod in CI.
