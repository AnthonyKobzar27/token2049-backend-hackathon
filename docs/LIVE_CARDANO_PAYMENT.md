# One real paid Task on Cardano Preprod

The runbook for the Cardano track. You end with one paid Sokosumi Task, a confirmed seller collection on Cardano Preprod, and every ID the submission asks for.

Written 2026-10-06, during the hackathon. Sources: the Masumi TOKEN2049 agent guide (https://www.masumi.network/token2049/agent-guide.md), the submission page (https://www.masumi.network/token2049/submission), and this repo. If this file and the live guide disagree, the live guide wins. Anything not checked against a live system is marked **(unverified)**.

---

## 0. What "done" means

The Cardano track does **not** accept "our MIP-003 API works". It wants:

1. A **Coworker** on Sokosumi Preprod, owned by your **Vendor**.
2. A **rehearsal Task**, run by that Coworker. It proves execution only and moves no money.
3. A **paid Task**. Sokosumi (the "Core" buyer) puts **1 test USDM** in escrow, HAAS does the work and submits a result hash, and after the unlock time the seller wallet **collects** the USDM.
4. Proof: Task IDs, event IDs, at least one confirmed Preprod transaction hash with an explorer link, the seller address, the USDM unit, and the net USDM the seller received, measured on chain by you.

A Task marked `COMPLETED`, a credit debit, or a `PURCHASED` state does **not** prove payment. Only the confirmed collection transaction does.

## 1. The big picture, and the gap in our code

```
Sokosumi Task  ──(HAAS worker polls)──>  HAAS worker ──> HAAS router (search, rank)
      │                                   │
      │  masumiPayment event              │ POST /payment (signed terms)
      ▼                                   ▼
 Sokosumi Core (buyer)  ──USDM──>  escrow contract  <── our Masumi Payment Service (MPS)
                                                         │ submit-result, then collect
                                                         ▼
                                                   seller wallet (ours)
```

The repo has the right-hand side: the MIP-003 API (`src/masumi/api.ts`), the MPS client (`src/masumi/payments.ts`), the payment watcher (`src/masumi/watcher.ts`) and MPS infra (`infra/masumi/`).

**It does not have the left-hand side: a Sokosumi Task worker.** The track's paid flow goes through a Coworker that **polls** Sokosumi for Tasks. Sokosumi does not call our `/start_job` for this. Someone has to build `src/sokosumi/worker.ts` (section 9). This is the biggest single piece of work on the critical path.

## 2. Time budget at a glance

| Step | Hands-on | Waiting | Can run in parallel with |
|---|---|---|---|
| 3. Accounts (Sokosumi, Blockfrost, dispenser, Railway) | 20 min | dispenser email | everything |
| 4. Sokosumi CLI, Vendor, Coworker, runtime key | 20 min | — | 5, 6 |
| 5. MPS up and seeded | 30–60 min | — | 4 |
| 6. Fund wallets | 5 min | 5–15 min (dispenser and collateral) | 9 |
| 7. Deploy HAAS publicly | 30–60 min | — | 6 |
| 8. Register the agent (Dynamic, USDM) | 10 min | 3–15 min (mint) | 9 |
| 9. Build the Sokosumi worker | **3–6 h** | — | 6, 8, 11 |
| 10. Rehearsal Task | 15 min | — | — |
| 11. Join the event Workspace, ask for approval | 5 min | **unknown, human** | everything |
| 12. Paid Task | 10 min | 3–10 min (escrow funding) | — |
| 13. Unlock and collect | — | **45–60 min with the timing fix; 4 h 20 min+ with today's code** | the deck |
| 14. Record artifacts | 20 min | — | — |

Critical path: worker build, then rehearsal, then paid Task, then the unlock wait. **Start the paid Task at least 2 hours before the deadline. With today's timing code, at least 6 hours.**

## 3. Accounts (20 min)

1. **Sokosumi Preprod**: sign up at https://preprod.sokosumi.com/signup. Everything below must use this one account.
2. **Blockfrost**: create a free project at https://blockfrost.io and pick **Cardano Preprod**. Keep the project id; it is the `BLOCKFROST_API_KEY_PREPROD` for MPS. The same key also works for `BLOCKFROST_PROJECT_ID` in HAAS (x402) and for measuring balances later. A Mainnet key does not work on Preprod.
3. **Masumi dispenser**: https://dispenser.masumi.network gives test ADA and test USDM. It asks for a **verification code from your registration email**. Get that code early (unverified: which sign-up sends the email; ask a Masumi mentor if it is unclear).
4. **Railway** (https://railway.com) for hosting the worker, MPS and Postgres. Ask before creating billed resources.
5. **Model key**: HAAS uses `ANTHROPIC_API_KEY`. Sokosumi credits do not pay for the model.

## 4. Sokosumi CLI, Vendor and Coworker (20 min)

Use **Node 24**. The guide and the CLI need it. The repo README says Node 22; `process.loadEnvFile` (used in `src/config.ts`) exists in both, so run the repo on 24 too.

```sh
unset SOKOSUMI_API_KEY SOKOSUMI_AUTH_TOKEN      # shell values override your login
npm i -g @masumi_network/sokosumi
sokosumi --version                               # write the version down
sokosumi --preprod auth login
sokosumi --preprod auth whoami --json            # must show the intended account
sokosumi --preprod workspaces list --json        # must list at least one organization
```

If the last command lists no organization, open https://preprod.sokosumi.com, use the Workspace switcher and create a small demo organization. You need one before you can create a Vendor. It does not have to be the TOKEN2049 one.

```sh
sokosumi --preprod vendors me --json                       # reuse it if one exists
sokosumi --preprod vendors create --name "HAAS" --slug haas-<team> --json
sokosumi --preprod coworkers register --vendor-id <VENDOR_ID> \
  --name "HAAS: Human as a Service" --capability tasks --personal --json
```

Save `VENDOR_ID` and `COWORKER_ID`. Each account gets **one** self-service Vendor. If you see a limit error, run `vendors me` and reuse that ID. Do not retry creation.

**Runtime key.** Run the guide's `node --input-type=module -e '...'` block (section 2, "Save the runtime key automatically") from the repo root, with your `COWORKER_ID` filled in. It writes `SOKOSUMI_COWORKER_API_KEY` to `.env.local` and imports the key into the CLI vault. `.env.local` is already git-ignored here (`.env.*` in `.gitignore`). Do not print the file.

Checkpoint: Vendor ID, Coworker ID, Personal Workspace ID, access ID, Personal Coworker access `GRANTED`.

## 5. Masumi Payment Service (30–60 min)

MPS holds the selling wallet, signs payment terms, submits the result hash and collects the money. It must run **from the paid Task until collection is confirmed**. A sleeping laptop breaks the flow.

### Option A: the repo's Docker setup (fastest if Docker works)

`infra/masumi/docker-compose.yml` runs `ghcr.io/masumi-network/masumi-payment-service:0.29.0` (released 2026-10-05, the newest release) with Postgres 15 on port **3001**, with polling tuned for a demo.

Before you start it, change three things to match the guide:

1. Add `AUTO_WITHDRAW_PAYMENTS: 'true'` under `environment`. The guide requires it; it lets MPS collect by itself after unlock.
2. Make sure `COLLECTION_WALLET_V2_PREPROD_ADDRESS` is **not set at all**, in the file or in your shell. The guide says an empty string is not the same as unset. Our file only sets the legacy `COLLECTION_WALLET_PREPROD_ADDRESS` to empty, which the guide allows.
3. The `command:` runs the seed with its output in `docker compose logs`. **The seed can print wallet mnemonics.** For anything hosted, change it to `pnpm run prisma:seed >/dev/null 2>&1`. Then get the wallets from the admin UI instead of the logs. Our `infra/masumi/README.md` step 2 tells you to read the mnemonics from the logs; that is fine on a laptop, not on Railway.

```sh
cd infra/masumi
cp .env.example .env
# ENCRYPTION_KEY=$(openssl rand -hex 24)    48 chars. Never change it after seeding.
# ADMIN_KEY=$(openssl rand -hex 24)         the guide wants 32+ chars; the README's -hex 16 gives exactly 32
# BLOCKFROST_API_KEY_PREPROD=<from step 3>
docker compose up -d
curl http://localhost:3001/api/v1/health      # {"status":"success","data":{"status":"ok"}}
curl http://localhost:3001/api-docs -o mps-openapi.json
```

The repo README says this compose file was written without Docker and never run. Expect small fixes.

### Option B: the guide's local install

Git, Node 24, pnpm **10.30.2**, Postgres 13+ (Docker `postgres:16` on port 5433, or a local database used only for this).

```sh
git clone https://github.com/masumi-network/masumi-payment-service.git && cd masumi-payment-service
git rev-parse HEAD                                   # record it
(umask 077; cp .env.example .env)
# .env: DATABASE_URL, ENCRYPTION_KEY, ADMIN_KEY, BLOCKFROST_API_KEY_PREPROD,
#       PORT=3012, SEED_ONLY_IF_EMPTY=true, AUTO_WITHDRAW_PAYMENTS=true
#       leave Mainnet fields, SEED_V1_LEGACY and the mnemonics empty; delete COLLECTION_WALLET_V2_PREPROD_ADDRESS
pnpm install --frozen-lockfile
pnpm run prisma:generate && pnpm run prisma:migrate
pnpm run prisma:seed >/dev/null 2>&1; echo "seed exit $?"
pnpm -C frontend run build
pnpm run dev
```

The guide uses port **3012**; the repo uses **3001**. Whichever you pick, `MASUMI_API_URL` in `~/.haas/.env` must match (`http://127.0.0.1:3012/api/v1` or `http://localhost:3001/api/v1`).

### After MPS starts (either option)

1. Open `/admin/` and sign in with `ADMIN_KEY`. Do this yourself, outside the coding agent.
2. Check that there is one **Web3CardanoV2 Preprod** payment source, one Selling wallet and one Purchasing wallet.
3. Selling wallet: `collectionAddress` must be `null`. If it is `""`, fix it with the wallet update API (`newCollectionAddress: null`). Do not reseed.
4. Copy the **public** addresses. Never copy mnemonics into chat or the repo.
5. Create a runtime API key with **ReadAndPay** permission, Preprod only. Our README's curl sends `canRead/canPay`; 0.29.0 may expect a `permission` field instead (unverified, check `mps-openapi.json`). This key is `MASUMI_API_KEY` in HAAS. It is **not** the Coworker key.

## 6. Wallets and funding (5 min, then 5–15 min waiting)

| Wallet | Needs | Why | Where |
|---|---|---|---|
| Selling (ours) | test ADA, plus the separate **5 ADA collateral** | registration mint, collateral for Plutus transactions, submit-result and collection fees | https://dispenser.masumi.network and https://docs.cardano.org/cardano-testnets/tools/faucet/ (pick Preprod) |
| Purchasing (ours) | test ADA **and at least 1 test USDM** | only for the optional direct buyer rehearsal (`pnpm spike:masumi`) | dispenser |
| Sokosumi Personal Workspace | **test credits** | Core pays the escrow from these on the paid Task | https://preprod.sokosumi.com/billing?tab=credits, Stripe test card `4242 4242 4242 4242`, any future date, any CVC |

- The selling wallet does **not** need USDM to receive the payment.
- Test USDM unit (policy id + asset name):
  `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d`
- The dispenser sends the 5 ADA collateral as a separate transaction. It "can take a few minutes".
- Check real balances before going on. Our `infra/masumi/README.md` says "about 20 tADA" for selling; the guide says not to assume a fixed figure. Measure it.

```sh
curl -s -H "project_id: $BLOCKFROST_API_KEY_PREPROD" \
  https://cardano-preprod.blockfrost.io/api/v0/addresses/<SELLING_ADDRESS>
```

## 7. Deploy HAAS publicly (30–60 min). Do this before registering.

Register only once, with the **final** URL. If the URL changes you must update the registration (one more transaction and another wait).

**Recommended (guide): Railway.**

| Service | Source | Settings |
|---|---|---|
| `postgres` | Railway PostgreSQL | private networking only |
| `mps` | image `ghcr.io/masumi-network/masumi-payment-service:0.29.0`, or the repo built per the MPS deployment doc | **Serverless off**, restart policy "always", env from step 5, `DATABASE_URL` = the private Postgres URL, seed output suppressed. **No public domain**, or protect it: the admin UI must not be open to the internet |
| `haas` | this repo, start command `pnpm start` | **Serverless off**, volume mounted at `/data` with `HAAS_HOME=/data` (the SQLite database and `.env` live in `HAAS_HOME`), public domain on, `PUBLIC_URL=https://<railway domain>`, `MASUMI_API_URL=http://mps.railway.internal:<port>/api/v1` (unverified hostname pattern; use the private URL Railway shows) |

HAAS on Railway cannot use the browser sources (Fiverr, PeoplePerHour, Guru). They read the operator's own Chrome over CDP. Set `SOURCES=freelancer,rentahuman` on the hosted copy. The Sokosumi worker runs inside the `haas` service (section 9), so it is the single executor.

Moving an existing local MPS: stop the worker and MPS, copy the database, restore it on Railway with the **same `ENCRYPTION_KEY`**, start it, and keep the old one stopped. Never reseed or run two copies against the same wallets.

**Rehearsal shortcut: a tunnel.** `cloudflared tunnel --url http://localhost:8787` gives an HTTPS URL in seconds. A quick tunnel gets a **new URL every restart**, which breaks the registry entry, and the guide says a laptop setup is only a rehearsal and does not count as hosted. Use it to test, not for the registration you submit.

## 8. Register the HAAS agent (10 min, then 3–15 min for the mint)

The guide's required pricing differs from `scripts/register-agent.ts`:

| | Guide | `scripts/register-agent.ts` today |
|---|---|---|
| Pricing | `supportedPaymentSources[].pricing = {"pricingType":"Dynamic"}` and nothing else (no `fixed`, `dynamic`, asset list or `decimals`) | `Fixed`, `3000000` lovelace, `decimals: 6` |
| Asset | test USDM, 1 USDM = `1000000` units, quoted per Task | ADA |
| Access model | `Standard` (default) with `apiBaseUrl` = the HAAS URL, not the MPS URL | `apiBaseUrl` set; access model left to the default |
| Example outputs | worth filling | `[]` |

**Fix before running:** in the V2 branch of `register-agent.ts`, replace the `pricing` object with `{ pricingType: 'Dynamic' }`. Add `ExampleOutputs` and better `Tags` (see `docs/MASUMI_MARKETPLACE.md`).

```sh
# ~/.haas/.env (or Railway variables) needs PUBLIC_URL=https://..., MASUMI_API_URL, MASUMI_API_KEY
pnpm register:agent
```

The script waits for the mint and prints `MASUMI_AGENT_IDENTIFIER` and `MASUMI_SELLER_VKEY`. Also save, from the admin UI or `GET /registry`: the **supported payment source index**, **policy id**, **contract address** and **seller wallet address**. The Masumi agent identifier is not the Coworker ID.

`RegistrationFailed` almost always means the selling wallet has no ADA or no collateral yet.

## 9. Build the Sokosumi worker (3–6 h, the critical path)

HAAS has no worker yet. Add `src/sokosumi/worker.ts` and start it from `src/index.ts` when `SOKOSUMI_COWORKER_ID` is set. Keep one worker per Coworker (one Railway replica, with the local worker stopped).

The loop, per the guide's "Run a paid Task" section:

1. **Find a READY Task** assigned to the Coworker. Save the Task ID and input **before** writing anything anywhere.
2. **Start it**: `sokosumi --preprod runtime start <TASK_ID> --coworker-id <ID> --personal --json`. On a host without the CLI vault, pass the key with `--api-key-stdin`.
3. **Paid Tasks only: request signed terms** from MPS: `POST /payment`. `createPayment` in `src/masumi/payments.ts` already does this. Two changes:
   - Dynamic pricing needs the quote in the request: 1 USDM = `{"amount":"1000000","unit":"16a55b…5344d"}`. The exact field name is in `mps-openapi.json` (unverified; look for something like `RequestedFunds`). Use strings, not numbers.
   - **Shorten the times** (see section 13). Today unlock is 4 h 20 min after the job starts.
4. **Post the `masumiPayment` event** to the Task event endpoint with the Coworker credential. Core charges credits and funds escrow. The guide does not give the endpoint path; read the CLI's `--help`, the API reference (https://www.masumi.network/dev/sokosumi/api-reference) and the `tasks` Skill from `sokosumi skills` (unverified).
5. **Wait for `FundsLocked`.** `createWatcher` already polls MPS every 15 s; reuse `payments.getPayment`.
6. **Run HAAS with no check-in.** A Sokosumi Task has no `awaiting_input` round-trip in this flow, so the result is the **ranked shortlist** (no booking). Add an option to `jobs.startJob` that ends at the shortlist instead of pausing.
7. **Save the exact UTF-8 result** (max 1 MiB) and compute `resultHash(result, identifierFromPurchaser)` from `src/masumi/hash.ts`. The guide warns that raw and JSON-escaped hashing differ. Test with a result containing newlines, quotes and backslashes against what Core expects (unverified which one Core uses).
8. **Submit the hash** with `payments.submitResult`, **then** run `sokosumi --preprod runtime complete <TASK_ID> --coworker-id <ID> --personal --result-file result.txt --json`. `runtime complete` does not submit the hash and does not collect.
9. **Journal** Task ID, blockchainIdentifier, signed deadlines, result bytes and hash, and every pending write in the SQLite store under `HAAS_HOME`, so a restart neither loses nor double-submits a payment.

## 10. Rehearsal Task (15 min)

Execution only. No money moves. Stop the automatic worker first so only you touch this Task.

```sh
sokosumi --preprod tasks create --personal --coworker-id <COWORKER_ID> \
  --name "HAAS rehearsal" \
  --description "Find a logo designer for a small bakery, budget 200 USD, remote OK" \
  --status READY --json
sokosumi --preprod runtime start <TASK_ID> --coworker-id <COWORKER_ID> --personal --json
# get a shortlist from HAAS (local start_job, or the worker's dry-run mode) and save it as result.txt
sokosumi --preprod runtime complete <TASK_ID> --coworker-id <COWORKER_ID> \
  --personal --result-file ./result.txt --json
```

If `runtime start` returns `403` with `kind: grant_required`, approve the Vendor request in the **Personal Workspace notifications** and retry the **same** Task.

Save: rehearsal Task ID, `COMPLETED`, `result.txt`, event ID.

Optional, in parallel: `pnpm spike:masumi` runs a direct buyer through our own purchasing wallet against the MIP-003 API. It proves the escrow and hash path without Sokosumi. It needs the purchasing wallet funded with ADA and USDM, and a fixed `identifier_from_purchaser` of 14–26 hex characters (already handled).

## 11. Join the event Workspace and ask for approval (5 min, then a human wait)

Do this **as soon as the rehearsal passes**. Approval is done by a person and nobody has published how long it takes. Collection is not a prerequisite.

1. Open https://preprod.sokosumi.com/join/9Ycw8wzmzXB2WEKa-umzUJX6_GEFiVdu with the same account.
2. Connect the existing Coworker:
   ```sh
   sokosumi --preprod coworkers connect <COWORKER_ID> --vendor-id <VENDOR_ID> \
     --workspace-id 01a109d1-32a9-71a3-a0e3-658b2a7987cd --json
   sokosumi --preprod workspaces check 01a109d1-32a9-71a3-a0e3-658b2a7987cd --json
   ```
3. `PENDING` means the request went in. Save the access ID. Ping the Masumi team at the venue. Do not register again.
4. Approval sends an email: "HAAS: Human as a Service approved for …". Then check `runtimeAccessStatus` is `GRANTED`, `taskSeatEligible: true`, and that the event Workspace has credits.
5. Event Task commands use `--organization-slug token2049-origins-hackathon-2026-nws2r7`; event runtime commands use `--organization-id 01a109d1-32a9-71a3-a0e3-658b2a7987cd`. Never mix them with `--personal`.

**The paid Task does not need to wait for this.** Run it in the Personal Workspace (section 12).

## 12. Paid Task (10 min, then 3–10 min for escrow funding)

1. Personal Workspace has credits (step 6). MPS is up. Selling wallet is funded. The registration is `RegistrationConfirmed`. The worker is running, and only once.
2. Create a new Task:
   ```sh
   sokosumi --preprod tasks create --personal --coworker-id <COWORKER_ID> \
     --name "HAAS paid demo" --description "<same small brief>" --status READY --json
   ```
3. Watch the worker log: terms requested, `masumiPayment` posted, `FundsLocked`, shortlist ready, hash submitted, Task completed.
4. Write down the signed `payByTime`, `submitResultTime`, `unlockTime` and `externalDisputeUnlockTime` the moment they are created.

How long escrow funding takes depends on Core's own payment node (unverified). With our MPS tuned to 1 confirmation and 15 s polls, expect about 1–3 min after Core broadcasts; with untuned nodes, 5–10 min.

## 13. Unlock and collection: the longest wait

The seller can only collect **after `unlockTime`**, if no refund was requested. The guide adds: "V2 timed collection includes a delay after unlock; it is not immediate at Task completion." It does not say how long that delay is (unverified). MPS then needs one more collection poll (30 s in our compose; 3–5 min by default) and one block (~20 s).

**With today's code** (`defaultTimes` in `src/masumi/payments.ts`):
payByTime +30 min, submitResultTime +4 h, **unlockTime +4 h 20 min**, dispute +4 h 40 min.
You would wait **more than 4 h 20 min** for proof of collection.

**Fix (recommended for the demo):** make the times configurable and use the smallest gaps the API accepts. The repo comment records the 0.29.0 rules: result ≥ now + 15 min, pay ≤ result − 5 min, unlock ≥ result + 15 min, dispute ≥ unlock + 15 min.

| Field | Proposed | Why |
|---|---|---|
| payByTime | now + 20 min | room for Core to fund |
| submitResultTime | now + 30 min | HAAS needs 1–3 min to search and rank |
| unlockTime | now + 45 min | the minimum gap |
| externalDisputeUnlockTime | now + 60 min | the minimum gap |

Collection then lands about **45–60 min after the terms are signed**, plus the unknown V2 delay. **Budget 90 minutes.** Shorter windows give a buyer less time to dispute; fine on Preprod with a 1 USDM job, but say so in the deck.

`AUTO_WITHDRAW_PAYMENTS=true` should make MPS collect by itself. If nothing happens 15 min after unlock, look at the payment's `NextAction` in the admin UI, or `GET /payment/diff/next-action`, before retrying anything.

## 14. Record the artifacts (20 min)

Keep a private `~/.haas/submission.md` (outside the repo) and copy the safe values into the deck and README.

| Artifact | Where to find it |
|---|---|
| Vendor ID, Coworker ID | `sokosumi --preprod vendors me --json`, `coworkers list --scope owned --json` |
| Rehearsal Task ID, paid Task ID, status, result, event IDs | `sokosumi --preprod tasks get <ID> --json` and the `runtime complete` output |
| Masumi agent identifier | `register-agent` output |
| blockchainIdentifier, signed deadlines | worker journal; MPS `GET /payment?network=Preprod` |
| Escrow funding tx, submit-result tx, **collection tx hash** | MPS admin UI, Payments, transaction history (field names in `mps-openapi.json`) |
| Explorer link | `https://preprod.cardanoscan.io/transaction/<TX_HASH>` |
| Seller address | admin UI, Selling wallet |
| USDM unit | `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d` |
| Net USDM received | your own on-chain check: the USDM output of the collection tx to the seller address (`GET /txs/<hash>/utxos` on Blockfrost), or the seller's USDM balance before and after (`GET /addresses/<addr>`). Expect 1.000000 USDM if V2 really charges a 0 % protocol fee, as the 0.28.0 release notes say (unverified for this route). ADA fees are separate. |
| Repo revision, deployed URLs | `git rev-parse HEAD`, Railway dashboard |

Before publishing anything, check staged files and history for keys, mnemonics, personal emails, local paths and private URLs.

## 15. Common failures

| Symptom | Cause | Fix |
|---|---|---|
| `whoami` shows the wrong account | `SOKOSUMI_API_KEY` or `SOKOSUMI_AUTH_TOKEN` set in the shell | `unset` both, log in again |
| "Creating a vendor requires an organization workspace" | no organization | create a demo organization in the web UI |
| Vendor limit conflict | one Vendor per account | `vendors me`, reuse it |
| `403 grant_required` on `runtime start` | Vendor has no runtime grant on the Workspace | approve it in Workspace notifications, retry the same Task |
| `grant_denied` or `grant_revoked` | Workspace owner said no | ask the owner; do not change roles |
| `RegistrationFailed` | selling wallet unfunded, or collateral not there yet | fund it, wait for the 5 ADA collateral, retry |
| Registration rejected on pricing | extra keys in the Dynamic pricing object | send only `{"pricingType":"Dynamic"}` |
| Payment goes to an odd address | `collectionAddress` is `""` | wallet update with `newCollectionAddress: null`, then fresh terms |
| `identifier_from_purchaser must be 14 to 26 hex characters` | MPS nonce rule | send hex |
| Job fails with "payment not received before payByTime" | Core funded late | longer `payByTime`; check Core credits |
| Signature errors on the payment event | someone edited signed terms | never edit signed fields; request fresh terms |
| Result hash mismatch, dispute | raw and escaped hashing differ | test both against the route; save the exact bytes |
| Nothing collected long after unlock | MPS stopped, Railway serverless asleep, or the auto-withdraw flag missing | serverless off, `AUTO_WITHDRAW_PAYMENTS=true`, check `NextAction` |
| Wallets unreadable after redeploy | `ENCRYPTION_KEY` changed | restore the original key; never reseed |
| Registry points at a dead URL | quick tunnel restarted | register with the Railway URL, or update the registration |
| Blockfrost `403` or `project_id` error | Mainnet key, or wrong network base URL | create a Preprod project |
| `docker compose` fails on first start | file never run (see `infra/masumi/README.md`) | use option B |

## 16. Checklist

- [ ] Sokosumi Preprod account; `whoami` correct; CLI version noted
- [ ] Organization membership; Vendor ID; Coworker ID; runtime key in `.env.local` and the vault
- [ ] Blockfrost Preprod key; dispenser verification code
- [ ] MPS healthy; V2 Preprod source; `collectionAddress: null`; `AUTO_WITHDRAW_PAYMENTS=true`; ReadAndPay key
- [ ] Selling wallet: ADA + 5 ADA collateral confirmed on chain
- [ ] Personal Workspace credits (Stripe test card)
- [ ] HAAS deployed on Railway, serverless off, volume on `HAAS_HOME`, `PUBLIC_URL` HTTPS
- [ ] `register-agent.ts` switched to Dynamic; `RegistrationConfirmed`; agent id, source index, policy id, contract address, seller vkey and address saved
- [ ] Payment times shortened and configurable
- [ ] Sokosumi worker built; one executor; journal in `HAAS_HOME`
- [ ] Rehearsal Task `COMPLETED`; IDs saved
- [ ] Event Workspace joined; Coworker connected; access ID saved; approval requested **early**
- [ ] Paid Task done; deadlines recorded; `FundsLocked`; result hash submitted; Task `COMPLETED`
- [ ] Collection tx confirmed; explorer link; net USDM measured on chain
- [ ] Offline-laptop test: new Task from another device is picked up by the hosted worker; restart keeps progress, no double payment
- [ ] Deck with **embedded** demo recording on Google Drive (.ppt or .keynote); submitted on BuilderBase

## 17. Submission facts: confirmed, corrected, unknown

- **Deadline: not verified.** The BuilderBase event data says the event runs from **2026-10-06 04:00 UTC (12:00 SGT) to 2026-10-08 09:30 UTC (17:30 SGT)**, with 36 hours of hacking. The exact submission deadline is behind the BuilderBase login (https://builderbase.com/event/token2049-origins-hackathon#rules); the Masumi page only says "view the submission deadline on BuilderBase". Check it today and write it here. Singapore time is UTC+8.
- **Both Cardano and Solana tracks: not verified.** The official tracks are Cardano (Agentic Commerce), Chainlink, NOWNodes and Solana. The Masumi submission page says "Submit to the main track and any relevant partner track", which suggests you can pick more than one partner track. It is not a confirmed rule. Ask the organizers.
- **Cardano prize: partly verified.** A Cardano.org community digest (2026-09-16) says the Cardano call has **"$27,500 in prizes"**. The split (1st, 2nd, 3rd) was not found. The whole event pool is US$150,000. The top 5 teams demo live on the TOKEN2049 stage.
- **Judging (Masumi page):** quality of results, a useful agent, reliable execution, verified payment.
- **Demo:** the recording must be **embedded in the slides**. Live stage demos and external video links are not accepted for judging.
- **Correction to `infra/x402-facilitator/README.md`:** it says "There is no hosted Cardano facilitator". https://developers.cardano.org/x402/ lists a Cardano Foundation Preprod facilitator at `https://x402.preprod.dev.ecosyseng.cf-deployments.org`.
