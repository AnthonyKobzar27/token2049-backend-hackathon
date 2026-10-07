# Veridian identity: the HAAS Verified Worker credential

HAAS, an agent on Masumi, hires humans for other agents. The buyer needs to know that the human it gets is real and that HAAS vouched for them.

When HAAS has verified a worker's freelance accounts, it issues an **ACDC** (Authentic Chained Data Container). It issues it from its own **KERI** identifier (AID) to an AID the worker controls in the **Veridian wallet**, the Cardano Foundation's KERI/ACDC identity wallet. The router then prefers workers whose credential checks out. The ranking reason says "Veridian KERI credential verified".

This sits next to the Cardano CIP-68 reputation token (`src/identity/`, branch `feat/cardano-reputation`):

- The ACDC says who the worker is and how HAAS verified them, and the worker holds it in their own wallet.
- The CIP-68 token carries the on-chain job history.
- The ACDC can name the reputation asset (`cardanoReputationAsset`).
- `combineSignals()` merges the two signals for the router.

## What is where

| Path | What |
|------|------|
| `src/identity/veridian/schema/haas-verified-worker.schema.json` | ACDC JSON schema. Its `$id` is the schema SAID: `ENVe4IRREn4azglijtsA6OW2o4fm3v3Cwyw1mvlcb4av` |
| `src/identity/veridian/schema.ts` | SAID computation (`pnpm veridian:schema` rewrites the file after edits) |
| `src/identity/veridian/client.ts` | signify-ts connection (connect, or boot then connect), operation waits with deadlines |
| `src/identity/veridian/issuer.ts` | `VeridianCredentialIssuer`, which implements `CredentialIssuer` from `src/identity/issuer.ts` |
| `src/identity/veridian/service.ts` | onboarding sessions and the cache-only `signals()` the router reads; `combineSignals()` |
| `src/identity/veridian/api.ts` | HTTP routes (below) and the worker's connect page with the QR |
| `src/identity/veridian/fake.ts` | in-memory KERIA used by the tests |
| `scripts/veridian-demo.ts` | headless end-to-end run: issuer and a wallet stand-in on one KERIA |
| `scripts/veridian-wallet.ts` | wallet simulator for the HTTP onboarding flow |
| `infra/veridian/` | KERIA 0.4.0 docker-compose / Railway image |

### Credential attributes

These go in the ACDC's `a` block:

| Attribute | Value |
|-----------|-------|
| `i` | the worker's AID |
| `workerId` | HAAS profile id, such as `freelancer:12345`; the same id the router ranks |
| `platformsVerified` | the platforms HAAS verified, such as `["freelancer", "fiverr"]` |
| `verificationMethod` | `platform-oauth`, `profile-challenge` or `operator-review` |
| `issuedAt` | when HAAS completed the verification |
| `cardanoReputationAsset` | optional; the CIP-68 asset |
| `dt` | added by signify-ts |

A test checks that the schema SAID matches the schema's content. A cross-check with keripy's own `Schemer` (inside the KERIA image) gave the same SAID.

### HTTP routes

| Route | Who | What |
|-------|-----|------|
| `GET /oobi/:said` | KERIA, wallets | The schema, served as `application/schema+json` exactly. keripy rejects `; charset=utf-8`. |
| `GET /veridian` | anyone | Issuer AID, issuer OOBI, registry, schema SAID and schema OOBI |
| `POST /veridian/onboarding` | operator | Body: `{workerId, platformsVerified, verificationMethod, cardanoReputationAsset?}`. Returns `{session, qr, connectUrl}`. Needs `Authorization: Bearer $VERIDIAN_ADMIN_TOKEN`; with no token set, only loopback requests are accepted. |
| `GET /veridian/connect/:id` | worker | Page with the QR to scan and a box for the wallet's OOBI |
| `POST /veridian/onboarding/:id/wallet` | worker | Body: `{oobi}`. HAAS resolves it, issues the credential, sends an IPEX grant, and the session becomes `granted`. |
| `GET /veridian/onboarding/:id` | worker | Status. Becomes `admitted` once the wallet accepts. |
| `POST /veridian/verify` | anyone | Body: `{acdc, iss, workerId?}` or `{said}` or `{workerId}`. Returns 200 with a verdict if valid, 422 if not. |
| `GET /veridian/workers/:workerId` | anyone | The stored credential and the last verdict |

### Router

- `createRouter` gets `identity: veridian`.
- `signals(ids)` is synchronous and reads only the cache: workers with a valid verdict get `{verified: true, veridian: true}`. That is worth +3 points in `onchainBoost`, and never applies when suitability is below 0.25.
- Verdicts older than `VERIDIAN_CACHE_TTL_MIN` (default 30) are re-verified in the background. Each re-verification is bounded by `VERIDIAN_VERIFY_TIMEOUT_MS` (default 2000).
- A timeout or a KERIA outage keeps the last verdict for up to 24 h. A revocation removes the mark on the next refresh.
- Ranking never waits on KERIA.
- To also use the Cardano registry, pass `combineSignals(cardanoRegistry, veridian)`.

## Run the demo

Requirements: Docker, Node 22, `pnpm install` (or `npx pnpm@10 install`).

### 1. KERIA up

```bash
cd infra/veridian && docker compose up -d --build && cd ../..
curl http://localhost:3903/health
```

### 2. Headless proof of the whole protocol (about 20 s)

```bash
VERIDIAN_DEMO_REVOKE=1 pnpm veridian:demo
```

The script creates the HAAS issuer and a wallet stand-in on the same KERIA. It serves the schema itself on port 7723, so it does not need HAAS running. It then goes through these steps:

1. Connects both sides by OOBI.
2. Issues the credential and sends the IPEX grant.
3. The wallet admits it, and HAAS sees the admit.
4. Verifies by SAID.
5. The worker presents the credential back over IPEX, so `holderProven: true`.
6. Verifies the raw `{acdc, iss}` through KERIA `POST /credentials/verify`.
7. Rejects a tampered copy.
8. Revokes the credential and shows `credential was revoked`.

With KERIA in Docker on a bridge network, set `VERIDIAN_DEMO_SCHEMA_HOST=host.docker.internal` so KERIA can reach the script's schema server.

### 3. HAAS with the issuer (issuer init)

Set these in `~/.haas/.env`:

```bash
VERIDIAN_KERIA_URL=http://127.0.0.1:3901
VERIDIAN_KERIA_BOOT_URL=http://127.0.0.1:3903
VERIDIAN_PASSCODE=<21+ chars; see infra/veridian/README.md>
VERIDIAN_OOBI_BASE_URL=http://host.docker.internal:8787   # where KERIA reaches HAAS
```

Then start HAAS:

```bash
pnpm start          # logs "[haas] veridian issuer E…" once the AID, registry and schema are ready
curl http://localhost:8787/veridian
```

On the first start HAAS:

1. Boots its KERIA agent.
2. Creates the `haas-issuer` AID and its `agent` end role.
3. Creates the `haas-verified-workers` registry.
4. Resolves the schema from its own `/oobi/{said}`.

Later starts load the same AID and registry. Keep `VERIDIAN_PASSCODE` secret and stable, because it derives the issuer's keys.

### 4. Worker onboarding (operator, then worker)

```bash
curl -s -XPOST localhost:8787/veridian/onboarding -H 'content-type: application/json' \
  -d '{"workerId":"freelancer:12345","platformsVerified":["freelancer"],"verificationMethod":"platform-oauth"}'
# -> {"session":{"id":"…","status":"awaiting-wallet","issuerOobi":"http://…:3902/oobi/E…/agent/E…?name=HAAS"},
#     "qr":"data:image/png;base64,…","connectUrl":"http://localhost:8787/veridian/connect/…"}
```

Send the worker the `connectUrl`.

**With the Veridian wallet on a phone.** Both `KERIA_PUBLIC_URL` and `VERIDIAN_OOBI_BASE_URL` must be reachable from the wallet's agent: use a LAN IP, a tunnel, or Railway. Then:

1. In the wallet, scan the QR on the connect page. This adds "HAAS" as a connection.
2. In the wallet, share the identifier's connection OOBI and paste it into the page. HAAS issues the credential and sends the grant.
3. Accept the credential offer in the wallet. The page shows `admitted`.

**Without a phone.** The wallet simulator does the same three steps over the same protocol, then presents the credential back to HAAS:

```bash
pnpm veridian:wallet http://localhost:8787/veridian/onboarding/<session id>
```

### 5. Verify

```bash
curl -s localhost:8787/veridian/workers/freelancer:12345              # verified: true, last verdict
curl -s -XPOST localhost:8787/veridian/verify -H 'content-type: application/json' \
  -d '{"workerId":"freelancer:12345"}'                                  # re-checks the registry (TEL)
```

A worker, or another agent holding the credential, can `POST /veridian/verify` with `{acdc, iss}`. KERIA parses the credential (`POST /credentials/verify`). HAAS then checks:

- the SAIDs of the credential and its attributes,
- the schema,
- that HAAS is the issuer,
- that the issuance event matches,
- the registry state (`iss` or `rev`).

Presentations sent as IPEX grants to the HAAS AID are polled every 15 s. They are accepted only when the sender is the credential's issuee, which proves the presenter controls the worker AID.

## Verified live vs mocked

All checks on 2026-10-06 used KERIA 0.4.0 in Docker and signify-ts 0.4.0. An earlier run of `veridian:demo` also passed on KERIA 0.2.0-rc2.

**Live:**

- `pnpm veridian:demo`, every step including revocation.
- HAAS `pnpm start` against compose KERIA:
  - issuer init and schema OOBI resolution from HAAS;
  - onboarding through HTTP, then the wallet simulator: `granted`, then `admitted`;
  - the IPEX presentation, with `holderProven: true`;
  - `/veridian/workers` reporting `verified: true` through `signals()`;
  - a restart with the same passcode reloading the same AID and keeping the verdict.
- KERIA accepted the grant carrying `a.oobiUrl`.

**Mocked (vitest, `src/identity/veridian/*.test.ts`, 27 tests):**

- every issuer, service and HTTP path, including timeouts, revocation, tampering, the wrong holder and the wrong worker;
- the witness configuration of the issuer AID.

**Not verified:**

- the real Veridian mobile app;
- the Veridian hosted sandbox;
- witnesses (see `infra/veridian/README.md`);
- a Railway deploy;
- the router's live ranking with the signal. The router seam is the same `signals()` the endpoint uses, and the boost and reason are unit-tested.

## Honest limits

- **The Veridian app is untested.** Its flow should work for these reasons, taken from the wallet source (`ipexCommunicationService.ts`):
  - HAAS's OOBI is a standard agent OOBI with `?name=HAAS`.
  - Grants carry `a.oobiUrl = {VERIDIAN_OOBI_BASE_URL}/oobi`, which the wallet uses to fetch the schema. Upstream KERIA 0.4 rejects the alternative, an `indexer` end role on the issuer's own AID ("unable to verify end role reply message"), so HAAS logs a warning and relies on `oobiUrl`.
  - The wallet accepts grants only for its own AIDs, and only after the user taps accept.

  Menu names in the wallet may differ from the steps above.
- **The wallet must send its OOBI to HAAS.** HAAS learns the worker's AID only when the worker gives it their OOBI, through the paste box. A QR scan connects in one direction only. Veridian's own credential server works the same way: it has a "resolve OOBI" step.
- **The issuer AID has no witnesses in the demo.** Its key state is served only by HAAS's KERIA agent. If that agent is lost, credentials cannot be verified. Production needs witnesses and a backed-up passcode.
- **"Verified" means HAAS vouches.** The credential is exactly as strong as HAAS's platform checks (`verificationMethod`). ACDCs make that claim tamper-evident, attributable and revocable. They do not make it true.
- **A raw `{acdc, iss}` POST to `/veridian/verify` is a bearer presentation.** It proves the credential is genuine and unrevoked, but not that the caller is the worker. Only IPEX presentations (`holderProven: true`) prove control of the worker AID. The router's mark does not currently require `holderProven`.
- **Onboarding is gated by the operator.** Without `VERIDIAN_ADMIN_TOKEN`, onboarding accepts loopback requests only. Behind a proxy that makes every request look local, set the token.
- **Revocation is not exposed over HTTP.** It exists as `issuer.revoke(said)`, used by the demo.
- **No Cardano anchoring.** KERI events are not checkpointed on Cardano. The link to Cardano is the optional `cardanoReputationAsset` attribute and the shared ranking signal.
