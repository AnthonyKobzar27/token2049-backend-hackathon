# Manual testing before the demo

This guide is for testing HAAS by hand on a Mac before the demo. Start with **Your manual checklist** below: it lists everything only a person can do. Then work through the sections top to bottom. Each step says what to run, what you should see, what failure looks like, and which automated tests already cover it.

Written 2026-10-06 against branch `integration/all-features` at `1f9f047`.

**Baseline on that commit (Linux container, Node 22.22, pnpm 10.28):**

```
pnpm install    -> Done in 13.7s (warning: ignored build scripts for bigint-buffer, bufferutil, ... ; harmless)
pnpm test       -> Test Files  52 passed (52)   Tests  497 passed (497)
pnpm typecheck  -> tsc --noEmit, no output, exit 0
```

Sections 2.1, 2.5–2.8 and 2.10–2.13 were also run by hand, with no keys, against a live `pnpm start`. The outputs quoted below come from those runs. The sandbox could not reach freelancer.com or rentahuman.ai. On your Mac those two sources should answer too.

---

## Your manual checklist

Everything here needs a person, an account, a wallet or an approval. No agent can do it. Work top to bottom: items are ordered by how much they matter for winning the Cardano track. Tick them off as you go.

### A. Today, most important first

1. [ ] **Run one live paid Cardano Task.** This is the Cardano track's required proof: a Preprod collection transaction paying the seller in test USDM through your own Masumi Payment Service. Start it **at least 2 hours before the deadline**; the unlock and collection wait alone is about 60 minutes. Steps: section 2.14 and `docs/LIVE_CARDANO_PAYMENT.md`.
2. [ ] **Start the Masumi Payment Service (MPS).** Its docker compose has never been run, so leave time for fixes. Steps: "The Masumi payment service" in section 1. Fallback: runbook §5, option B.
3. [ ] **Deploy the Solana escrow program to devnet**, or demo with `ESCROW_PROVIDER=memory` and say so. `SOLANA_ESCROW_PROGRAM_ID` is a placeholder until you run `anchor deploy` and `pnpm spike:solana`. Steps: section 2.8 and `programs/haas-escrow/README.md`.
4. [ ] **Pick one real Masumi AI agent** for the "try an AI agent first" path and set `AI_AGENT_URL`. If you don't, set `AI_DELEGATION=human` so the demo stays on the human path. Steps: section 2.5.
5. [ ] **Configure Telegram before the demo** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPERATOR_ID`). Without it every approval (book, accept, release) is granted automatically. Steps: section 2.2.

### B. Accounts and keys to get

- [ ] **Anthropic API key** (`ANTHROPIC_API_KEY`) from console.anthropic.com. Turns on LLM scoping, AI-vs-human, better scoring and the Claude QA rubric. Without it QA returns `needs_human`.
- [ ] **Blockfrost Preprod project** (`BLOCKFROST_PROJECT_ID`, and `BLOCKFROST_API_KEY_PREPROD` in `infra/masumi/.env`). Must be a Preprod key; a Mainnet key returns 403.
- [ ] **Masumi dispenser access.** It asks for a code from your registration email. Request it early. You need tADA, the 5 ADA collateral and test USDM from https://dispenser.masumi.network.
- [ ] **Sokosumi Preprod account**, then a Vendor (needs an organization first) and a Coworker with the `sokosumi` CLI. Add workspace credits with the Stripe test card. Steps: `docs/LIVE_CARDANO_PAYMENT.md` §4.
- [ ] **Join the event workspace** at https://preprod.sokosumi.com/join/9Ycw8wzmzXB2WEKa-umzUJX6_GEFiVdu and run `coworkers connect`. It stays PENDING until a Masumi admin approves it, so do this early and ask them.
- [ ] **Railway account** (or another host) for the worker, MPS and Postgres, with serverless off. The guide wants the deployed URL in the submission.
- [ ] **Solana devnet wallet** (`solana-keygen new`, airdrop SOL) and **devnet USDC** from https://faucet.circle.com.
- [ ] **Cardano minting wallet** for reputation: `pnpm identity:wallet`, then fund it with tADA.
- [ ] **Teammates' details** for the bounty board: Telegram ids and Cardano and Solana addresses (`WORKER_NITHYA_*`, `WORKER_OLIVER_*` and so on), then `pnpm seed:workers`.
- [ ] Optional: **Upwork API key** (needs Upwork's approval), **Prolific API token**, a **KERIA server** for Veridian (`docs/VERIDIAN.md`), **x402 pay-to addresses** (`docs/X402.md`).

### C. Register and list the agent on Masumi

- [ ] Expose HAAS on a public HTTPS URL and set `PUBLIC_URL`.
- [ ] Fund the selling wallet, create the MPS Read and Pay key (`MASUMI_API_KEY`).
- [ ] Run `pnpm register:agent`. Wait for `RegistrationConfirmed`. Copy `MASUMI_AGENT_IDENTIFIER` and `MASUMI_SELLER_VKEY` into `~/.haas/.env`. (The boot line says `masumi payments: on` with only the API key; paid jobs also need the identifier.)
- [ ] Run a **rehearsal Task**, then the **paid Task** in your Personal Workspace (you don't need to wait for event approval for the paid one).
- [ ] Record for the submission: rehearsal and paid Task IDs, Coworker ID, Preprod transaction hash and explorer link, seller address, USDM unit, and the measured net amount received.

### D. Run each live service once

Each of these has code and tests but has never run against the real service.

- [ ] Live search on Freelancer.com and RentAHuman from your Mac (section 2.6).
- [ ] A paid MIP-003 job against your MPS (section 2.1, paid mode).
- [ ] The Telegram bot end to end, hirer and worker commands (sections 2.2 and 2.9).
- [ ] Hiring your chosen Masumi AI agent (section 2.5).
- [ ] A Solana Pay deposit, release and refund-after-timeout on devnet (sections 2.8 and 2.11).
- [ ] A reputation mint on Preprod: `pnpm identity:demo --live` (section 2.12).
- [ ] Optional: x402 payment on Cardano and on Solana; Veridian issue and verify; Upwork and Prolific searches.

### E. Small fixes before recording

- [ ] Shortlist text shows `4.9 from 0 reviews` and `$2.22 fixed in 0 days`. Hide zero counts.
- [ ] A "Verified HAAS worker" headline can sit next to `"verified":false`. Make them agree.
- [ ] Update stale docs: `docs/LIVE_CARDANO_PAYMENT.md` §1, §8, §9, §13 (the worker exists, pricing is Dynamic, windows are configurable); `docs/DELEGATION_AND_SPEED.md` (it says no Masumi agent is called); `docs/IDENTITY.md:115` (it says nothing emits `verification.completed`).
- [ ] Make the boot log say `masumi payments: off` unless `MASUMI_AGENT_IDENTIFIER` is also set.
- [ ] Use Node 24 if you also run the Sokosumi CLI.
- [ ] Bounty payouts are ledger lines, not transfers. Either pay through the Solana escrow (worker wallet as payee) or say so in the pitch.

### F. Submission and demo

- [ ] Confirm the hackathon kickoff time against the repo's first commit (2026-10-06 13:56 Singapore time) and be ready to explain how the commits were made. The rules say all work must start after kickoff.
- [ ] Confirm the submission deadline and time zone on the BuilderBase rules page (it needs a login).
- [ ] Decide whether to merge `integration/all-features` (or this branch) into `main`. Nothing has been merged to `main`.
- [ ] Rehearse the clinic story (section 3) and **record the demo**. The Cardano track only accepts a recording embedded in the deck; live demos and external video links don't count.
- [ ] Build the deck (Google Drive link to .ppt or .keynote with the recording embedded) and fill in: public repo and run instructions, deployed agent URL, Coworker ID, sample Task, Task IDs, transaction hash, seller address, USDM unit, net amount received.
- [ ] Submit to the Cardano track and, if allowed, the Solana track.

---

## 0. Setup on the Mac (10 min)

```bash
brew install node@22 jq          # Node 22 or 24 (the Sokosumi CLI wants 24)
corepack enable                  # or: npm i -g pnpm@10
git clone https://github.com/oliver-sommer/token2049-origins-hackathon.git
cd token2049-origins-hackathon
git checkout integration/all-features
pnpm install && pnpm test && pnpm typecheck
mkdir -p ~/.haas && cp .env.example ~/.haas/.env
```

Expect the same numbers as the baseline above.

- HAAS reads `~/.haas/.env`, then `./.env.local`. Variables already set in your shell win.
- The database is `~/.haas/haas.db`.
- To test from a clean state, use a throwaway home: `export HAAS_HOME=/tmp/haas-test`.

**Helper used below.** `/provide_input` needs the sha256 of the canonical `input_schema`. This prints it for a job (run it from the repo root):

```bash
schemahash() { curl -s "localhost:8787/status?job_id=$1" | npx tsx -e "import {schemaHash} from './src/masumi/hash.ts'; let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(schemaHash(JSON.parse(s).input_schema)))"; }
```

---

## 1. Prerequisites: keys per feature

Every key is optional. A missing key switches its feature off and prints a line at boot.

### What runs with no keys at all

- `pnpm start`: the MIP-003 API, unpaid jobs, memory escrow, rule-based QA, and the bounty board after `pnpm seed:workers`.
  - Approvals are **auto-approved** ("headless") when no Telegram token or operator id is set.
- Live search on Freelancer.com and RentAHuman, with TF-IDF scoring.
- `pnpm demo:bounty`: the whole clinic story in one process.
- `pnpm identity:demo`: Cardano reputation on an in-memory chain.
- `pnpm demo:warm`, then `DEMO_MODE=true pnpm start`: built-in fixture freelancers, about 2 s shortlists.
- `npx vitest run src/e2e`: the full pitch flow with every outside service faked.

### Keys by feature

| Feature | Variables in `~/.haas/.env` | Where to get it |
|---|---|---|
| LLM scoping, scoring, AI-vs-human, QA rubric | `ANTHROPIC_API_KEY` (models: `MODEL_CHAT`, `MODEL_FAST`, `MODEL_VERIFY`, `MODEL_VERIFY_STRONG`) | console.anthropic.com > API keys |
| Telegram hirer bot + operator approvals + worker commands | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPERATOR_ID` | Token: talk to @BotFather, `/newbot`. Your numeric id: message @userinfobot |
| Masumi job fee (paid MIP-003) | `MASUMI_API_URL` (default `http://localhost:3001/api/v1`), `MASUMI_API_KEY`, `MASUMI_AGENT_IDENTIFIER`, `MASUMI_SELLER_VKEY` | Your own Masumi Payment Service (`infra/masumi/README.md`). The key comes from its admin UI (Read and Pay). The identifier and vkey are printed by `pnpm register:agent` |
| Blockfrost (Cardano Preprod reads/writes) | `BLOCKFROST_PROJECT_ID`; for MPS, `BLOCKFROST_API_KEY_PREPROD` in `infra/masumi/.env` | blockfrost.io > new project > **Cardano Preprod**. A Mainnet key returns 403 |
| Cardano reputation mint | `BLOCKFROST_PROJECT_ID` + `CARDANO_MINT_MNEMONIC` (`CARDANO_NETWORK=preprod`) | `pnpm identity:wallet` prints a new mnemonic and its address. Fund it with tADA from https://dispenser.masumi.network or https://docs.cardano.org/cardano-testnets/tools/faucet |
| Cardano wallets for MPS | Selling and purchasing wallets, made by the MPS seed | Fund the selling wallet with tADA from the dispenser (it also sends 5 ADA collateral). Test USDM also comes from the dispenser. The dispenser asks for a code from your registration email, so get it early |
| Hiring a Masumi AI agent | `AI_AGENT_URL` (pinned agent), or `MASUMI_REGISTRY_URL` (+ `MASUMI_REGISTRY_TOKEN`); `MASUMI_BUYER_API_KEY` for paid agents; `AI_AGENT_FREE=true` for the demo | Any MIP-003 agent's base URL (Sokosumi / Masumi registry) |
| Solana escrow (devnet) | `ESCROW_PROVIDER=solana-program`, `SOLANA_OPERATOR_SECRET`, `SOLANA_ESCROW_PROGRAM_ID`, `SOLANA_USDC_MINT`, `PUBLIC_URL` (HTTPS) | Wallet: `solana-keygen new`, then `solana airdrop 2 --url devnet` or https://faucet.solana.com. Devnet USDC: https://faucet.circle.com (pick Solana Devnet). The program must be **deployed by you** first (see 2.8) |
| Bounty worker contacts and wallets | `WORKER_NITHYA_TELEGRAM`, `WORKER_NITHYA_CARDANO`, `WORKER_NITHYA_SOLANA` (same for OLIVER, SAM, PRIYA) | Teammates' Telegram ids and wallet addresses |
| Sokosumi Coworker worker | `SOKOSUMI_COWORKER_ID`, `SOKOSUMI_COWORKER_API_KEY` (`coworker_*`), `SOKOSUMI_PAID_TASKS=true` for paid | Sokosumi CLI, `docs/LIVE_CARDANO_PAYMENT.md` §4 |
| x402 (optional) | `X402_PAY_TO` (Cardano), `X402_SOLANA_PAY_TO` (Solana) | `docs/X402.md` |
| Veridian (optional) | `VERIDIAN_KERIA_URL` and friends | `docs/VERIDIAN.md` |

**The Masumi payment service.** You need Docker Desktop.

```bash
cd infra/masumi && cp .env.example .env
# fill: ENCRYPTION_KEY=$(openssl rand -hex 24)  ADMIN_KEY=$(openssl rand -hex 24)  BLOCKFROST_API_KEY_PREPROD=...
docker compose up -d && docker compose logs -f payment-service
curl http://localhost:3001/api/v1/health     # {"status":"success","data":{"status":"ok"}}
```

- Open http://localhost:3001/admin/ and sign in with `ADMIN_KEY`.
- Create an API key with Read and Pay. That key is `MASUMI_API_KEY`.
- Never change `ENCRYPTION_KEY` after the first start; it decrypts the wallets.
- The compose file has **never been run** by the team. Expect small fixes. Fallback: runbook §5, option B.

**Boot check.** `pnpm start` prints which features are on:

```
[telegram] Telegram disabled (TELEGRAM_BOT_TOKEN not set)
[haas] listening on http://localhost:8787 (port 8787)
[haas] sources: freelancer, rentahuman, bounty
[haas] AI-first: auto; agent: none
[haas] escrow: memory; masumi payments: off; x402: off; identity: off
```

- Note: `masumi payments: on` only checks `MASUMI_API_KEY`. Paid jobs also need `MASUMI_AGENT_IDENTIFIER`. Without it, jobs still start unpaid even though the line says "on".
- `curl localhost:8787/health` lists every source and whether it is enabled.

---

## 2. The flow, step by step

### 2.1 Request in: Masumi API (MIP-003)

```bash
pnpm seed:workers      # once: registers Nithya, Oliver, Sam (verified) and Priya (not verified)
pnpm start             # second terminal from here on
curl -s localhost:8787/availability
curl -s localhost:8787/input_schema | jq '.input_data[].id'
curl -s -X POST localhost:8787/start_job -H 'content-type: application/json' -d '{
  "identifier_from_purchaser": "a1b2c3d4e5f60718",
  "input_data": {"task": "Call Tanjong Pagar Polyclinic and book the earliest physio slot this week",
                 "location": "Singapore", "budget_usd": 5}}' | tee /tmp/start.json | jq
JOB=$(jq -r .job_id /tmp/start.json)
```

**Expected.**
- `/availability` returns `{"status":"available","type":"masumi-agent","message":"HAAS is ready to accept jobs"}`.
- `/start_job` returns `job_id`, `"blockchainIdentifier":"free_job_…"`, `"payment_required":false` and an `input_hash`.
- Sending the same identifier and input again returns the same job. It is idempotent.
- In paid mode, `payment_required:true`, real deadlines and `price` ("1 USDM") come back, and `/status` shows `awaiting_payment` until the watcher logs `[masumi] job <id>: funds locked`.

**Failure signs.**
- `400 task: required`: the `input_data.task` field is missing.
- Paid mode `400 identifier_from_purchaser must be 14 to 26 hex characters`: use hex, e.g. `openssl rand -hex 10`.
- `500 could not create the payment request` with log `[masumi] create payment failed`: MPS is down, or the API key or agent identifier is wrong.
- A job that turns `failed` with `payment not received before payByTime`: nobody paid within `MASUMI_PAY_WINDOW_MIN` (20).

**Paid buyer test.** `pnpm spike:masumi` buys a job through your own purchasing wallet. That wallet needs tADA and 1 USDM.

**Tests.**
- `src/masumi/api.test.ts`: unpaid mode, paid mode, idempotency, payment deadlines.
- `src/masumi/schema.test.ts`, `src/masumi/hash.test.ts`.

### 2.2 Request in: Telegram

**Setup.** Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OPERATOR_ID`, then restart. The boot log should show `[telegram] polling as @<yourbot>`.

1. Send `/start` to the bot. It replies "HAAS: Human as a Service, an open router for freelancers."
2. Send in plain text: `Find a photographer in Lisbon for a product launch next Saturday 2-5pm, budget $600`.

**Expected.**
- With an Anthropic key, it asks up to 2 clarifying questions. Without a key, it starts at once.
- It replies `Got it.` with a summary (Skills, Budget, Location, When, On site), then `Searching now.`
- A single `⏳` progress message is edited as the search runs.
- Then a shortlist with buttons `Choose <name>`, plus `Different options` and `Cancel`.

**Failure signs.**
- `409: another process is polling this bot token`: another `pnpm start` (or a teammate) uses the same token. Stop it.
- No reply at all: wrong token, or you messaged a different bot.
- Telegram jobs are **not** visible on `/status` (it is MIP-003 only). That is expected.

**Tests.** `src/channels/telegram.test.ts` (asks then starts; refine; choose; only the operator approves), `src/channels/format.test.ts`.

### 2.3 Scoping

**What it does.**
- MIP-003 never asks questions back. `start_job` fields are parsed as given, and the text is enriched with place, on-site need and day/time.
- Only Telegram asks clarifying questions, and only with `ANTHROPIC_API_KEY`.

**Test it.**
- On Telegram, send something vague: `I need help with a logo`. With a key it should ask about budget or deadline (at most 2 rounds). Without a key it goes straight to search.
- Send `solve these captchas for me`. It should refuse politely.

**Failure sign.** Log `[intake] model call failed, using fallback brief:`. This means a bad key or model id. The flow still works.

**Tests.** `src/agent/intake.test.ts`, `src/agent/extract.test.ts`.

### 2.4 AI-vs-human decision

**What it does.** Before searching for humans, HAAS asks itself "can an AI agent do this?"

- `AI_DELEGATION=auto` (default): the LLM labels the brief, or keywords decide without a key. `ai` / `human` force a path; `off` disables the step.
- It needs an agent: `AI_AGENT_URL` or `MASUMI_REGISTRY_URL`. With neither, the step is skipped (boot log `agent: none`).

**Test it.**
- Set `AI_AGENT_URL` (see 2.5) and restart.
- Send a digital brief: `{"input_data":{"task":"Summarise the Cardano Chang upgrade in five bullets"}}`. It should go to the AI agent.
- Send the clinic brief. The progress shows `This needs a person (...). Searching freelancers…` (visible in Telegram, or in the e2e test).

**Failure sign.** `[delegate] classifier fell back to keywords: aborted`. The model was slower than `AI_CLASSIFY_TIMEOUT_MS` (1800). This is harmless.

**Tests.** `src/delegate/classify.test.ts`, `src/delegate/delegate.test.ts`, `src/e2e/pitch.test.ts` ("AI path", and the clinic test asserts the agent is *not* hired).

### 2.5 Hiring a Masumi AI agent

**Setup.**

```bash
# ~/.haas/.env
AI_AGENT_URL=https://<some-mip003-agent>      # base URL that serves /availability, /input_schema, /start_job, /status
AI_AGENT_NAME=Summariser
AI_AGENT_FREE=true                            # demo: never lock funds
```

Restart, then:

```bash
curl -s -X POST localhost:8787/start_job -H 'content-type: application/json' \
  -d '{"input_data":{"task":"Summarise the Cardano Chang upgrade in five bullets"}}' | jq -r .job_id
curl -s "localhost:8787/status?job_id=<id>" | jq -r .result | jq
```

**Expected.**
- Boot line: `[haas] AI-first: auto; agent: https://…`.
- Result: `"path":"ai"`, `"outcome":"delivered"`, `output` with the agent's text, and `agent.verified:true` when the MIP-004 hash matched.
- No booking and no bounty are created.
- Paid agents (with `AI_AGENT_FREE=false`) are bought through `POST /purchase` on your MPS, using `MASUMI_BUYER_API_KEY` or `MASUMI_API_KEY`. Any later failure requests a refund automatically.

**Failure signs.**
- `agent requires payment but MASUMI_BUYER_API_KEY / MASUMI_API_KEY is not set`.
- `asked for more input, which the AI path does not support`.
- `input hash mismatch`.
- Out of time (`AI_TIME_BUDGET_MS`, 60 s).

In every one of these the job falls back to humans with `…finding a human instead…`. That fallback is the intended behaviour. Log `[buyer] refund request for … failed` means a paid refund needs a manual look in the MPS admin UI.

**Gap.** The team has no confirmed live agent URL. The e2e test uses a local fake seller. Pick and test a real Preprod agent before the demo.

**Tests.** `src/masumi/buyer.test.ts` (including "buyer refunds when it gives up after paying"), `src/delegate/delegate.test.ts`.

### 2.6 Open router matching (day/time, location, demo mode)

Poll the job from 2.1 until it shows `awaiting_input`. That takes up to `SEARCH_BUDGET_MS`, 6 s.

```bash
curl -s "localhost:8787/status?job_id=$JOB" | jq '{status, shortlist: [.shortlist[] | {id, score, reason, verified}]}'
```

**Expected** (seen in our run):

```
"status": "awaiting_input"
bounty:w_nithya  82.6  "Matches call, tanjong, pagar; based in Singapore; $2.22 fixed in 0 days; 4.9 from 0 reviews; replies within the hour."
bounty:w_oliver  82.2  ...   bounty:w_sam  81.2  ...
```

Each candidate has `headline` text such as `Verified HAAS worker in Tanjong Pagar, 0.3 km from Tanjong Pagar Polyclinic`. Priya (Woodlands, not verified) never appears.

**Day/time.** Add `"when":"Saturday 2-5pm"` (or `"2026-10-12 10:00-12:00"`) and `"timezone":"Asia/Singapore"`. People whose schedule misses the slot score lower. Unknown schedules lose a little and are never dropped.

**Location.**
- Add `"remote_ok":false` and `"radius_km":5`. On-site people beyond the radius (default 50 km), or in another country, are dropped.
- Try a remote brief, e.g. `{"task":"Design a logo for a coffee shop","skills":"logo design, branding","budget_usd":200}`. Freelancer.com and RentAHuman profiles should appear on your Mac. In our sandbox the network was blocked, so the list came back empty.

**Demo mode** (for the stage):

```bash
pnpm demo:warm            # "Warming 4 briefs into ~/.haas/haas.db" ... "Pinned demo run: <ms> ms <task> -> <name> (<score>)"
DEMO_MODE=true pnpm start # "[haas] demo mode: pinned cache, 2000 ms budget (warm it with pnpm demo:warm)"
```

Fixture people (Mara Lindqvist, Siti Rahmah, …) join the results. A shortlist comes back in about 2 s.

**Failure signs.**
- Empty shortlist (`"candidates":[]`, only `different_options` and `cancel`): no source answered. Check `/health`, your network, and `npx tsx scripts/sources-smoke.ts`.
- `freelancer: unavailable` in Telegram progress: the platform failed. The others still answer.

**Cosmetic quirks to know before the demo** (not blockers):
- Bounty reasons say `4.9 from 0 reviews` and `$2.22 fixed in 0 days`.
- The shortlist JSON says `"verified": false` for seeded workers even though their headline says "Verified HAAS worker". The `verified` flag only turns true with a Cardano or Veridian credential (see 2.12).

**Tests.** `src/router/match.test.ts`, `dimensions.test.ts` (geo, day/time, weights, Singapore errand runners first), `router.test.ts` (demo mode under 2 s), `src/sources/registry.test.ts`, `relevance.test.ts`, `suitability.test.ts`.

### 2.7 Human check-in: provide_input

```bash
H=$(schemahash $JOB); echo $H
curl -s -X POST localhost:8787/provide_input -H 'content-type: application/json' \
  -d "{\"job_id\":\"$JOB\",\"input_schema_hash\":\"$H\",\"input_data\":{\"choice\":\"bounty:w_nithya\"}}" | jq
curl -s localhost:8787/signing_key | jq
```

**Expected.**
- The response is `{"input_hash":"…","signature":"<128 hex>"}`. The signature is Ed25519 over the `input_hash` string; the public key comes from `/signing_key`.
- `/status` then shows `running`.
- Other choices:
  - `"choice":"different_options"` (plus optional `"feedback":"cheaper"`) gives round 2 with new people.
  - `"choice":"cancel"` completes with `no_booking`.

**Failure signs.**
- `400 input_schema_hash is required…`: you sent no hash. `MASUMI_LENIENT_SCHEMA_HASH=true` relaxes this for old clients.
- `400 … does not match the input_schema currently issued by /status; fetch /status again`: the shortlist changed. Recompute the hash.
- `400 choice: unknown candidate`.
- `400 job is running, not awaiting_input`.
- With no answer for `CHECKIN_TIMEOUT_MIN` (120), the job completes with "The check-in expired without an answer."

**Tests.** `src/masumi/api.test.ts` ("check-in flow with hash and signature", "lenient mode"), `src/engine/jobs.test.ts` (confirm, refine, cancel, expiry).

### 2.8 Solana escrow lock

**Without keys.** `ESCROW_PROVIDER=memory`. The deposit is instant. The log goes straight to `[approvals] headless: auto-approving book: Book Nithya on bounty for $2.22`.

**Live on devnet.** The program id in the repo is a **placeholder and is not deployed**. You must deploy your own first: `programs/haas-escrow/README.md` steps 1–5 (Solana CLI, Anchor 1.2.0, about 3 SOL).

```bash
SOLANA_ESCROW_PROGRAM_ID=<your id> pnpm spike:solana       # expect "PASS (n/m)" with explorer links
# base58 secret for SOLANA_OPERATOR_SECRET from a solana-keygen file:
npx tsx -e "import bs58 from 'bs58'; import {readFileSync} from 'fs'; console.log(bs58.encode(Uint8Array.from(JSON.parse(readFileSync(process.env.HOME+'/.config/solana/id.json','utf8')))))"
```

Then, in `~/.haas/.env`:
- `ESCROW_PROVIDER=solana-program`
- `SOLANA_ESCROW_PROGRAM_ID=<id>`
- `SOLANA_OPERATOR_SECRET=<base58>`
- `PUBLIC_URL=https://<tunnel>`, e.g. `cloudflared tunnel --url http://localhost:8787`. The phone wallet must reach it.
- Optional: `ESCROW_DEADLINE_MIN=10` for the demo.

**Expected.**
- After the check-in, the booking waits in `pending_escrow`.
- Telegram sends a QR code and the text "Pay into escrow: X USDC … switch your wallet to devnet". The QR is also at `/solana-pay/qr/<bookingId>.png`.
- Scan it with Phantom or Solflare on devnet, holding devnet USDC from faucet.circle.com. The wallet shows "Lock X USDC for HAAS booking …".
- On the next tick (up to 15 s): `Escrow funded`, then the `book` approval.

**Failure signs.**
- Boot error `ESCROW_PROVIDER=solana-program needs SOLANA_OPERATOR_SECRET`.
- Wallet error / 409 `the deposit window for this booking is closing`: the booking expired. Start a new job.
- `deposit rejected: …`: wrong mint, amount or payee. The deposit is refunded.
- "The escrow deposit did not arrive in time, so I cancelled the booking": nobody paid within `ESCROW_DEPOSIT_TIMEOUT_MIN` (60).
- The QR does not open in the wallet: `PUBLIC_URL` is not public HTTPS.

**Tests.** `src/payments/payments.test.ts`, `solana-pay.test.ts`, `solana-program.test.ts` (codec vs IDL, refund vs cancel, short/wrong deposit), `src/engine/bookings.test.ts`. No test runs against real devnet. `spike:solana` is the only live check.

### 2.9 Bounty board: worker page and Telegram

After the `book` approval, the console prints one line per verified worker:

```
[bounty → Nithya] New task: Phone call, ~5 min, book a physio slot, S$3 [UH8X] First to claim gets it.
  http://localhost:8787/w/nwflUsV8dCtN6fyQ
```

**Web.** Open the `/w/<token>` link in a browser, or on a phone if `PUBLIC_URL` is a tunnel. You should see the task text, a **Claim this task** button, then a form with Date, Time and Reference number and a **Submit result** button. The same steps with curl:

```bash
T=<token>
curl -s -X POST localhost:8787/w/$T/claim  -H 'content-type: application/json' -d '{}' | jq .bounty.status       # "claimed"
curl -s -X POST localhost:8787/w/$T/submit -H 'content-type: application/json' \
  -d '{"date":"2026-10-08","time":"15:00","reference":"88213","notes":"Physio, Block 2 level 3"}' | jq .bounty.result.summary
# "Booked: Thursday 3pm, ref 88213"
```

Use a date in the current week: the check rejects past dates and "not this week". The other workers get `Task UH8X was claimed by someone else.`

**Telegram (workers).**
- `pnpm seed:workers` prints a link code per worker. The worker sends `/link <code>` to the same bot and gets "Hi Nithya, you will get tasks here."
- Then `/tasks`, `/claim UH8X`, and `/submit UH8X date=2026-10-08 time=15:00 reference=88213 | notes`.
- Or set `WORKER_NITHYA_TELEGRAM=<id>` before seeding.

**Failure signs.**
- `409 Someone else already claimed this task`.
- `This task was not offered to you`.
- `This task has expired`: the claim window is `BOUNTY_CLAIM_MIN` 15, the submit window is `BOUNTY_SUBMIT_MIN` 60. The escrow is refunded.
- No workers are offered: you did not run `seed:workers` against the same `HAAS_HOME`, or the place is more than 15 km away (`BOUNTY_RADIUS_KM`).
- `That code is not known.` on `/link`: you reseeded into a different database.

**Tests.** `src/bounty/board.test.ts` (one claimer wins), `web.test.ts`, `telegram.test.ts`, `spec.test.ts`, `flow.test.ts` (start_job to "Booked: Thursday 3pm, ref 88213"; CAPTCHA refusal; unclaimed refund).

### 2.10 AI QA: pass, fail, reject

QA has two layers:
1. The bounty check: rules, plus the LLM when a key is set.
2. Booking QA: rule checks, then a Claude rubric.

**Pass.** Submit as in 2.9. Expect:
- `[bounty] UH8X passed the check (rules): Booked: Thursday 3pm, ref 88213`
- Then an `accept` approval:
  - With no key: `QA needs your review: accept delivery and release $2.22 (bounty)`, because the rubric is unavailable and a person must confirm.
  - With a key: `QA passed: accept delivery and release …`.

**Fail, then revision.** Submit a past date or a junk reference, e.g. `"date":"2026-01-01","reference":"x"`. The worker sees `Please fix task UH8X: …` and the bounty goes back to `claimed`. Submit a correct result and it passes.

**Reject.** Fail twice. Expect:
- The booking is `rejected` and then `refunded`.
- `/status` shows `"outcome":"no_booking"` with `Booking ended (rejected): Rejected by QA: …`.
- No payout and no mint.

**Human deny.** On Telegram, press **Deny** on the accept approval. This counts as a QA fail and takes the revise/reject path.

**Knobs.**
- `AUTO_QA_REVISION=true` (default) sends the revision request without asking.
- `AUTO_RELEASE_MAX_USD=5` releases QA-passed bookings at or under $5 without asking.

**Tests.**
- `src/verify/verifier.test.ts`: hard fails skip the model; timeout gives needs_human; no key gives needs_human; strong model above $250.
- `src/bounty/qa.test.ts`, `src/approvals/policy.test.ts` ("QA autonomy").
- e2e "rejected result".

### 2.11 Release and auto-refund

**Release.** After the accept approval, expect:

```
[bounty] payout 3 SGD (~$2.22) to Nithya on solana DemoSo1anaWa11et1111111111111111111111111111 (ledger_bty_…)
[bounty → Nithya] Thanks! Task UH8X accepted. 3 SGD is on its way to …
```

- The bounty payout is a **ledger entry**, not a real transfer.
- With `solana-program`, the escrow `release(result_hash)` transaction pays the payee and records the hash. Telegram shows "Escrow released" with a "View transaction" link.

**Auto-refund.** Set `ESCROW_DEADLINE_MIN=2`, book, and do not submit. Within about 2.5 min the booking is `refunded` and the bounty is `cancelled`. Telegram says "The delivery was not accepted before the escrow deadline, so the budget was returned to you". A late claim returns `ok:false`.

**Failure sign.** `[bookings] release failed for …` or `refund failed for …`. Usually the operator is out of SOL or there is an RPC error. The tick retries.

**Tests.** `src/engine/bookings.test.ts` (timeouts, releaseOnVerified, settling races), e2e "timeout".

### 2.12 Cardano reputation mint

**No keys.** `pnpm identity:demo`. Expect (from our run):

```
[demo] memory chain on preprod; worker demo:ana -> addr_test1_operator
[demo] credential minted: https://preprod.cardanoscan.io/transaction/813dec…
[demo] job 1 "Pick up a parcel in Marina Bay": done https://preprod.cardanoscan.io/transaction/34cf…
... job 2, job 3 ...
[demo] GET /workers/:id/reputation -> { "credential": {...}, "onChain": {"verified": true, ...}, "reputation": {"jobsCompleted": 3, ...} }
[demo] ranking two otherwise identical workers: ...
```

On the memory chain the links are not real.

**Live on Preprod.**
1. `pnpm identity:wallet`. Put `CARDANO_MINT_MNEMONIC` in `~/.haas/.env` with `BLOCKFROST_PROJECT_ID`, then fund the printed address from the dispenser.
2. `WORKER_ADDRESS=addr_test1… pnpm identity:demo --live`. This takes a few minutes and a few tADA. Open the printed Cardanoscan links.
3. In the full flow: set `WORKER_NITHYA_CARDANO=addr_test1…`, re-run `pnpm seed:workers` and restart. The boot line should show `identity: preprod`.

After a completed, QA-passed booking, expect:
- `[identity] reputation task for booking bk_… (bounty:w_nithya): queued`
- then `[identity] reputation for bounty:w_nithya updated: tx <hash>`

Then `curl localhost:8787/workers/bounty:w_nithya/reputation | jq` shows `jobsCompleted` and Cardanoscan links. That worker now shows `"verified":true` in the next shortlist.

**Failure signs.**
- `503 identity is not configured`: keys are missing.
- The task sits in `waiting_wallet`: the worker has no `addr…` wallet.
- `… failed (attempt N, will retry)`: the wallet is unfunded or Blockfrost is down. After 8 attempts the task is `failed`.
- Blockfrost 403: a Mainnet key.
- With no QA verdict, the mint waits `IDENTITY_VERIFY_GRACE_MIN` (10) before recording `qa: none`.

**Tests.** `src/identity/identity.test.ts`, `mesh.test.ts` (offline CIP-68 mint), `seams.test.ts` (QA pass queues the mint; a rejection never mints), `src/router/onchain.test.ts`, e2e clinic test. No test touches real Preprod.

### 2.13 Result back to the caller

```bash
curl -s "localhost:8787/status?job_id=$JOB" | jq -r .result | jq
```

**Expected** (our run):

```json
{"path":"human","outcome":"booked","summary":"Booked: Thursday 3pm, ref 88213",
 "work":{"data":{"date":"2026-10-08","time":"15:00","reference":"88213", ...}},
 "freelancer":{"id":"bounty:w_nithya", ...},"priceUsd":2.22,"bookingId":"bk_…",
 "verifiedResult":{"hash":"8c0426…","payload":"…"}}
```

- `verifiedResult.hash` is the hash the Solana release records and the reputation receipt carries.
- In paid mode, the watcher then logs `[masumi] job <id>: result hash <h> submitted; collection after <iso>`. Later it logs `collected, tx <hash> (https://preprod.cardanoscan.io/transaction/…)`.
- Other outcomes: `no_booking` (cancel, reject, refund, expiry), `handoff` (finish on the platform), `delivered` (AI path).

**Failure sign.** `submitResultTime passed before the result was ready; the buyer can claim a refund`. The human part took longer than `MASUMI_RESULT_WINDOW_MIN` (90). Raise it for live runs. HAAS also refuses to book when the window is closing.

**Tests.** `src/masumi/api.test.ts` ("result string", paid collection), `src/engine/jobs.test.ts` ("paid result window"), e2e clinic test (MIP-004 hash check).

### 2.14 Live Cardano paid Task: runbook + Sokosumi worker

Follow `docs/LIVE_CARDANO_PAYMENT.md`. Parts of it are **out of date**:
- The Sokosumi worker now exists (`src/sokosumi/worker.ts`). §1 and §9 say it has to be built.
- `register-agent.ts` already registers Dynamic pricing. §8 says Fixed 3 ADA.
- Payment windows are now configurable. §13's "+4 h 20 min" is gone: Sokosumi defaults are pay 15, result 25, unlock +16, dispute +16 min, so collection comes about 60 min after the terms.

Short version:

1. **Accounts** (§3): Sokosumi Preprod, Blockfrost Preprod, dispenser code, Anthropic key.
2. **CLI, Vendor and Coworker** (§4): Node 24.

   ```bash
   unset SOKOSUMI_API_KEY SOKOSUMI_AUTH_TOKEN
   npm i -g @masumi_network/sokosumi && sokosumi --preprod auth login && sokosumi --preprod auth whoami --json
   ```

   Put `SOKOSUMI_COWORKER_ID` and `SOKOSUMI_COWORKER_API_KEY` (`coworker_…`) in `~/.haas/.env`.
3. **MPS** (§5, section 1 above). Fund the selling wallet plus collateral (§6). Buy Workspace credits with the Stripe test card `4242 4242 4242 4242`.
4. **Public URL** (§7): Railway, or `cloudflared tunnel --url http://localhost:8787` for rehearsals. Set `PUBLIC_URL`.
5. **Register** (§8): `pnpm register:agent --dry-run`, then `pnpm register:agent`. Copy the printed `MASUMI_AGENT_IDENTIFIER`, `MASUMI_SELLER_VKEY` and `MASUMI_SMART_CONTRACT_ADDRESS` into `.env`.
6. **Check the worker:** `pnpm sokosumi:worker --check`. Expect `Coworker: <id> … OK`, `READY Tasks: N`, `Paid Tasks: …`, `Fee per Task: 1 USDM`, and `Deadlines (min): pay 15, result 25, unlock +16, dispute +16`. It exits 0 when OK.
7. **Rehearsal (unpaid), §10.** Leave `SOKOSUMI_PAID_TASKS=false`.

   ```bash
   sokosumi --preprod tasks create --personal --coworker-id <ID> --name "HAAS rehearsal" \
     --description "Find a logo designer for a small bakery, budget 200 USD, remote OK" --status READY --json
   pnpm sokosumi:worker --once
   ```

   Expect `[sokosumi] task <id> picked up`, then `RUNNING`, `result ready (N bytes, hash …)` and `COMPLETED (event …)`.
8. **Paid Task, §12.** Set `SOKOSUMI_PAID_TASKS=true` and run `pnpm sokosumi:worker`. Run **only one** worker per Coworker: unset `SOKOSUMI_COWORKER_ID` for `pnpm start` while you do this. Create a new Task. Expect:
   - `terms <bcid>… payBy … unlock …`
   - `masumiPayment event … posted`
   - `FundsLocked`
   - `result hash submitted; collection after <ISO>`
   - `COMPLETED`
   - about 60 min later: `collected: https://preprod.cardanoscan.io/transaction/<tx>`

   `pnpm sokosumi:worker --status` prints the journal.
9. **Record the artifacts** (§14). Only the confirmed collection tx proves payment.

**Failure signs** (also runbook §15).
- `paid Tasks need the Masumi payment service (MASUMI_API_KEY, MASUMI_AGENT_IDENTIFIER)`.
- `the payment service returned no amount; register the agent with Dynamic pricing`.
- `Sokosumi did not charge the Task, it is now OUT_OF_CREDITS`.
- `escrow was not funded before payByTime`.
- `403 grant_required`: approve the request in the Personal Workspace notifications, then retry the same Task.
- `no collection a day after the dispute window`: check `AUTO_WITHDRAW_PAYMENTS` and `NextAction` in the MPS admin UI.

**Tests.**
- `src/sokosumi/worker.test.ts`: unpaid Task; paid end to end with collection; resume after restart; no double terms; not funded; rejected payment; out of credits; workspace filter.
- `src/sokosumi/haas.test.ts`.

All of these use a fake Core and a fake MPS. **The team has not yet run a live paid Task.**

---

## 3. End-to-end rehearsal: the clinic booking

The story: an agent asks HAAS to "Call Tanjong Pagar Polyclinic and book the earliest physio slot this week". HAAS decides it needs a person, finds verified people nearby, a teammate claims it on their phone and calls, QA checks the result, the escrow is released, and the caller gets "Booked: Thursday 3pm, ref 88213".

### Level 1: one command, no keys (2 min)

```bash
pnpm demo:bounty
```

Expect, in order:
- `▶ Caller … POST /start_job`
- the shortlist (Nithya 82.6, Oliver 82.2, Sam 81.2)
- `▶ Caller confirms bounty:w_nithya`
- the auto-approved `book`
- three `New task` links
- `Nithya … taps Claim`
- `passed the check (rules)`
- `payout 3 SGD`
- `▶ GET /status -> completed … Booked: Thursday 3pm, ref 88213`

`pnpm demo:bounty --live` does the same but waits for a real tap on the printed `/w/` link. Set `PUBLIC_URL` to a tunnel so a phone can open it.

### Level 2: the automated pitch test (30 s)

```bash
npx vitest run src/e2e
```

This runs 4 tests: clinic, AI path, rejected result, timeout refund. All outside services are faked.

### Level 3: real server, real phones (20 min)

**Terminal A:**

```bash
export HAAS_HOME=~/.haas            # your keys: ANTHROPIC, TELEGRAM_*, optionally Solana + Cardano
pnpm seed:workers                   # teammates: send /link <code> to the bot
cloudflared tunnel --url http://localhost:8787     # put the https URL in PUBLIC_URL, then:
pnpm start
```

**Terminal B (the "calling agent"):**

```bash
curl -s -X POST localhost:8787/start_job -H 'content-type: application/json' -d '{
  "identifier_from_purchaser":"'$(openssl rand -hex 10)'",
  "input_data":{"task":"Call Tanjong Pagar Polyclinic and book the earliest physio slot this week","location":"Singapore","budget_usd":5}}' \
  | tee /tmp/start.json | jq '{job_id,payment_required}'
JOB=$(jq -r .job_id /tmp/start.json)
sleep 8; curl -s "localhost:8787/status?job_id=$JOB" | jq '.status, [.shortlist[]|.id]'
curl -s -X POST localhost:8787/provide_input -H 'content-type: application/json' \
  -d "{\"job_id\":\"$JOB\",\"input_schema_hash\":\"$(schemahash $JOB)\",\"input_data\":{\"choice\":\"bounty:w_nithya\"}}"
```

**Then, in order:**
1. With `solana-program` only: scan the escrow QR on Telegram and approve it in a devnet wallet.
2. Operator: press **Approve** on "Book Nithya on bounty…".
3. Nithya: tap the Telegram notice or `/w/` link, press **Claim this task**, "make the call", and submit date (this Thursday), `15:00`, `88213`.
4. Operator: press **Approve** on "QA passed / needs your review: accept delivery…".
5. Terminal B: `curl -s "localhost:8787/status?job_id=$JOB" | jq -r .result | jq '.summary, .verifiedResult.hash'`. Expect `"Booked: Thursday 3pm, ref 88213"`.
6. With Cardano identity on: watch for `[identity] reputation for bounty:w_nithya updated: tx …`. Then open the link from `/workers/bounty:w_nithya/reputation`.

**Rehearse the bad paths once each:**
- Submit a past date (QA revision).
- Press **Deny** twice (reject and refund).
- Set `ESCROW_DEADLINE_MIN=2` and do nothing (auto-refund).

---

## 4. Status of each step

"Works" means exercised end to end by hand here and covered by tests. "Partial" means the code and tests exist but the live service has not been run. "Manual-only" means it depends on human or outside steps that no test covers.

| # | Step | Status | Notes |
|---|---|---|---|
| 2.1 | Request in via MIP-003 (unpaid) | **Works** | Run by hand against `pnpm start` |
| 2.1 | Request in via MIP-003 (paid, Masumi) | Partial | Fake MPS in tests only; the MPS docker compose has never been run |
| 2.2 | Request in via Telegram | Partial | Unit-tested with a fake bot; no live bot run recorded |
| 2.3 | Scoping | Partial | Keyless fallback works; the LLM clarifying questions need a key, Telegram only |
| 2.4 | AI-vs-human decision | **Works** (keywords) / Partial (LLM) | The keyword path is verified; the LLM path is untested live |
| 2.5 | Hire a Masumi AI agent | Partial | Fake seller in tests; no real agent URL chosen yet |
| 2.6 | Router: bounty, day/time, location, demo mode | **Works** | Live Freelancer/RentAHuman not reachable from the sandbox; check on the Mac |
| 2.7 | provide_input check-in | **Works** | Hash plus signature verified by hand |
| 2.8 | Solana escrow lock | Partial (memory works) | Program **not deployed**; the placeholder id must be replaced; QR deposit never run live |
| 2.9 | Bounty board web + Telegram | **Works** (web) / Partial (Telegram) | The worker page claim/submit was run by hand |
| 2.10 | AI QA pass/fail/reject | **Works** (rules) / Partial (Claude rubric) | No key means `needs_human`, so a person approves |
| 2.11 | Release + auto-refund | **Works** (memory, ledger) / Partial (on chain) | The bounty payout is a ledger line, not a transfer |
| 2.12 | Cardano reputation mint | **Works** (memory chain) / Partial (Preprod) | `identity:demo --live` not yet run |
| 2.13 | Result back to caller | **Works** | MIP-004 hash submit is tested against a fake MPS only |
| 2.14 | Live paid Sokosumi Task | Manual-only | Worker built and tested with fakes; needs a Coworker, MPS, registration, credits and a 60+ min wait |

---

## 5. Remaining gaps

1. **No live paid Task yet.** This is the Cardano track's proof. Start it at least 2 hours before the deadline: the unlock and collection wait alone is about 60 min.
2. **Escrow program not deployed.** `SOLANA_ESCROW_PROGRAM_ID` is a placeholder. Someone must run `anchor deploy` on devnet and `pnpm spike:solana` before the Solana part of the demo is real. Until then, demo with `ESCROW_PROVIDER=memory` and say so.
3. **MPS docker compose never run.** Allow time to fix it, or use runbook §5 option B.
4. **No real AI agent chosen** for the AI path. Pin one with `AI_AGENT_URL` and test it, or set `AI_DELEGATION=human` to keep the demo on the human path.
5. **Bounty payouts are ledger entries.** No ADA or USDC moves to the worker. When a worker's Solana wallet is the escrow payee, the escrow release itself pays them.
6. **Headless auto-approval.** Without Telegram keys, every approval (book, accept) is granted automatically. Fine for rehearsals; say so if you demo without the bot.
7. **Telegram, the LLM paths and the x402 paywall have not been run against live services.** The README says the same.
8. **Docs out of date:**
   - `docs/LIVE_CARDANO_PAYMENT.md` §1, §8, §9, §13 (worker exists, Dynamic pricing, configurable windows).
   - `docs/DELEGATION_AND_SPEED.md` says no Masumi agent is called yet.
   - `docs/IDENTITY.md:115` says nothing emits `verification.completed`.
   - README "Honest limits" is correct that the escrow is undeployed.
9. **Cosmetic issues in the shortlist:** `4.9 from 0 reviews`, `$2.22 fixed in 0 days`, and the `"verified":false` flag next to a "Verified HAAS worker" headline.
10. **The boot log can mislead:** `masumi payments: on` shows with only `MASUMI_API_KEY` set, but paid jobs also need `MASUMI_AGENT_IDENTIFIER`.
11. **Node version:** the README says 22 and the Sokosumi CLI says 24. Both work for the repo; use 24 if you also run the CLI.
