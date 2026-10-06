# Delegation and speed

How HAAS hands work to another AI agent or to a person, how long each hop takes on Cardano Preprod, and how to make the demo fast without faking anything.

Written 2026-10-06. Figures marked **(unverified)** are estimates not measured on a live system. Measure them in the rehearsal and update this file.

---

## 1. Two kinds of delegation

```
                     ┌── (a) AI agent on Masumi ── registry ─ start_job ─ purchase ─ status ─ verify hash
buyer ──pays──> HAAS ┤
                     └── (b) human ── open router (Freelancer, RentAHuman, browser sites) ─ check-in ─ book
                                   └─ bounty board (RentAHuman bounty, handed off to the operator)
```

Today the repo has (b). (a) is designed here; nothing in `main` calls another Masumi agent yet. `feat/ai-first-delegation` has started on it: a classifier that decides "AI or human" plus config, nothing on payments yet.

## 2. (a) Delegating to another AI agent on Masumi

HAAS is then the **buyer**. It needs its own MPS (we have one), a **funded purchasing wallet** (ADA for fees plus USDM or ADA for the price), and an MPS key with **Pay** permission (our `MASUMI_API_KEY` has Read and Pay).

### The steps

1. **Find the agent.**
   - Our own MPS: `GET /registry?network=Preprod` lists entries. `scripts/register-agent.ts` already calls it.
   - Network-wide: the Masumi registry service search takes `network`, a fuzzy `query` (up to 120 characters) and filters on `tags`, `status`, `policyId` and `capability`, with paging by `cursorId`, 1–50 results per page (from `masumi-skills` api-debug-recipes). The public registry API also has `GET /api/v1/agents` filtered by status (`VERIFIED` by default).
   - Sokosumi: `sokosumi agents list --json`, or the Sokosumi MCP `list_agents()`.
   - Keep from the entry: `agentIdentifier`, `apiBaseUrl`, the seller vkey, and the pricing (unit and amount).
2. **Check it is alive.** `GET {apiBaseUrl}/availability` must say `"available"`. Then `GET /input_schema` to build `input_data`.
3. **Start the job.** `POST {apiBaseUrl}/start_job` with `identifier_from_purchaser` (14–26 **hex** characters, an MPS rule) and `input_data`. MIP-003 names the job id `id` in the reply. Some clients and servers use `job_id`; read both.
4. **Check the terms before paying.**
   - Our own `inputHash(input_data, identifier)` (`src/masumi/hash.ts`) equals the returned `input_hash`.
   - `agentIdentifier` and `sellerVKey` match the registry entry.
   - The deadlines make sense: `payByTime` is in the future, and `submitResultTime` leaves time for the work.
   - The price matches what we expected.
5. **Lock the money.** `POST /purchase` on **our** MPS with the terms passed back unchanged. `scripts/masumi-spike.ts` already shows the exact body. Our MPS builds and submits the transaction to the escrow contract.
6. **Wait for the result.** Poll `GET {apiBaseUrl}/status?job_id=<id>` every 5 s. The seller only starts after **its** MPS sees `FundsLocked`. If it reaches `awaiting_input`, answer with `POST /provide_input`.
7. **Verify the result.** On `completed`, compute `resultHash(result, identifier)` and compare it with the hash the seller put on chain (our MPS's purchase record shows it once the seller submits; field names in `/api-docs`). If they differ, or nothing arrives before `submitResultTime`, **request a refund before `unlockTime`**. After unlock the seller can collect.

We can **use the result as soon as `/status` returns it**. The on-chain hash check can finish in the background before unlock.

### Latency budget on Preprod (one hop)

Cardano makes a block about every **20 s** on average, but the gaps vary. Several blocks a minute apart are normal.

| Hop | Best (tuned nodes) | Typical (default nodes) | Who controls it |
|---|---|---|---|
| Registry lookup | 0 s (cached) to 1 s | 1 s | us (cache it) |
| `/availability` + `/input_schema` | 0.5–2 s | 2 s | seller |
| `start_job` (seller asks its MPS for terms) | 1–3 s | 3 s | seller |
| Our MPS picks up the purchase (`BATCH_PAYMENT_INTERVAL`) | 0–15 s | up to 3–5 min | us (15 s in our compose) |
| Transaction in a block | ~20 s | 20–60 s | the chain |
| Confirmations the seller's MPS waits for (`BLOCK_CONFIRMATIONS_THRESHOLD`) | 1 block, ~20 s | 20 blocks, ~7 min | **seller** |
| Seller's MPS notices (`CHECK_TX_INTERVAL`) | 15 s | 3–5 min | **seller** |
| Seller's agent notices `FundsLocked` (HAAS: `POLL_MS` 15 s) | 5–15 s | 15–60 s | seller |
| Seller does the work | depends | depends | seller |
| Our status poll | ≤ 5 s | ≤ 5 s | us |
| **Paid to result in hand, excluding the work** | **~1.5–2 min** | **~10–15 min** | |
| Seller submits the result hash (one transaction) | +20–60 s | +1–5 min | seller, does not block us |
| `unlockTime` to seller collection | ≥ 15 min after `submitResultTime`, plus the V2 delay (unverified) | as signed | seller |

Default intervals come from `infra/masumi/README.md` ("service defaults: 3–5 min, 20"). Other teams' nodes will usually run defaults. **Delegating to another team's agent live on stage can take 10+ minutes before they even start.** Never put an untested external agent on the critical path of the recording.

## 3. (b) Delegating to a human

### Through the open router (what HAAS does today)

1. **Brief in.** MIP-003 `start_job`, Telegram, or x402 `POST /x402/route`.
2. **Payment for HAAS's own fee** (if on): Masumi escrow (as in the table above, with HAAS as seller), or x402 (one block, ~20 s on average, at most about 150 s; see `infra/x402-facilitator/README.md`).
3. **Fan-out search** across sources in parallel (`src/sources/registry.ts`). Each has a `SOURCE_TIMEOUT_MS` (60 s), a profile cache (`PROFILE_CACHE_TTL_MIN` 360 min) and falls back to stale results.

   | Source | Time (unverified) |
   |---|---|
   | Freelancer.com API | 1–5 s |
   | RentAHuman API | 1–3 s |
   | Browser sites (Fiverr, PeoplePerHour, Guru) at human pace | 10–60 s each; hits the timeout if a human check appears |
   | Cache hit | under 50 ms |

4. **Rank and explain.** The fast model scores suitability: a few seconds for 5–25 profiles (unverified).
5. **Check-in.** The job waits in `awaiting_input` until a person confirms (`CHECKIN_TIMEOUT_MIN` 120). **This takes as long as the person takes.**
6. **Booking approval.** Approval gate in Telegram (`APPROVAL_TIMEOUT_MIN` 60). Again human time.
7. **The freelancer replies.** Minutes to days. Nothing we can speed up.
8. **Solana escrow** for the booking budget (devnet): one transaction confirms in about 1–2 s, finalized in about 13 s (unverified for our RPC).

### Through the bounty board

RentAHuman bounties cost real money plus a fee and have no sandbox, so `src/sources/rentahuman.ts` **hands off** to the operator: open the profile, post a bounty, accept the application. `feat/bounty-board` is reserved for this and has no commits yet. Time: minutes of operator work, then minutes to hours for applications. For the demo, show it as a handoff, not as instant.

## 4. The slowest steps, worst first

| # | Step | How long | Hide or shorten it honestly |
|---|---|---|---|
| 1 | Unlock and collection | **4 h 20 min+ with today's `defaultTimes`**; ~45–60 min with the shortened times in `docs/LIVE_CARDANO_PAYMENT.md` §13, plus the V2 delay (unverified) | Shorten the times. Do the proof run early. In the video, cut the wait and caption it ("+47 min"), then show the real collection tx on the explorer. |
| 2 | Sokosumi event approval | unknown, a human | Ask right after the rehearsal. Do the paid Task in the Personal Workspace without waiting. |
| 3 | Freelancer reply and delivery | hours to days | Out of scope for a 3-minute video. Show the booking handoff and say so plainly. |
| 4 | Human check-in and approvals | as long as the person takes | On stage the operator approves at once in Telegram. Or use the autonomy policy (`src/approvals/policy.ts`) to auto-approve small, reversible steps. Never auto-approve payment. |
| 5 | Escrow funding seen by the seller | 1.5 min (tuned) to 10+ min (default) | Tuned MPS (already in our compose). Do the work speculatively while it confirms (§5.3). |
| 6 | Registry mint | 3–15 min, once | Do it once, early, with the final URL. |
| 7 | Browser-site search | 10–60 s | Pre-warm the cache for the demo briefs. |

## 5. Making the demo fast

### 5.1 Pre-warm (all honest; it is just setup)

- MPS, Postgres, HAAS and the worker are running and healthy, Railway serverless is **off**, and nothing is cold-starting.
- **Wallets funded with several UTXOs.** Cardano spends whole UTXOs. One big UTXO means a second payment waits for the first to confirm. Send yourself 5–10 small outputs (for example 10 tADA each) plus the 5 ADA collateral, so payments can run in parallel.
- Registry lookups cached: agent ids, URLs, input schemas.
- Profile cache filled for the exact demo briefs: run them within `PROFILE_CACHE_TTL_MIN` (6 h) of recording, or raise it for the recording day. The Chrome profile is logged in, with no pending human checks.
- The model is warmed with one small call. Telegram bot running, operator on standby.

### 5.2 Tune the polling (small code and config changes)

| Knob | Today | Demo value | Note |
|---|---|---|---|
| MPS `BLOCK_CONFIRMATIONS_THRESHOLD` | 1 (compose) | 1 | keep; Preprod |
| MPS `CHECK_TX_INTERVAL`, `BATCH_PAYMENT_INTERVAL` | 15 s | 10–15 s | lower values cost Blockfrost requests; watch the free-tier limit (unverified number) |
| MPS `CHECK_COLLECTION_INTERVAL` | 30 s | 15–30 s | only matters after unlock |
| HAAS watcher `POLL_MS` (`src/masumi/watcher.ts`) | 15 s | 5 s | make it configurable |
| Sokosumi worker Task poll | not built | 5 s | per Coworker, one executor |
| Payment times (`defaultTimes`) | unlock +4 h 20 min | unlock +45 min | the biggest single win |
| x402 `L1_CONFIRMATIONS` | 0 (in a block) | 0 | already the fastest safe setting |

### 5.3 Parallelism and speculative work

- **Search while the payment confirms.** Searching public listings costs nothing and gives away nothing. Start the fan-out at `start_job`, but **release** the shortlist (`/status` result, Task completion) only after `FundsLocked`. This hides 1–3 min of search behind the escrow wait. Today `jobs.startJob({ awaitPayment: true })` waits before routing; change it to route right away and hold the result.
- Delegating to several agents: send all purchases at once (needs several UTXOs, see 5.1) and poll them together.
- The search sources already run in parallel; keep `SOURCE_TIMEOUT_MS` low (20–30 s) for the demo so one slow site cannot hold up the shortlist.

### 5.4 What runs in rehearsal mode and what runs paid

| Use rehearsal (execution-only) Tasks for | Use paid Tasks for |
|---|---|
| Iterating on prompts, ranking and output format | The one proof run for the submission (early) |
| Testing the worker loop, restarts and failures | One fresh run to record the payment part of the video |
| Recording the "agent does the work" segment many times | (Optional) one live stage run, if top 5 |

Each paid Task costs credits and waits for unlock. Keep them few and planned.

### 5.5 What to record (the judged demo is a recording embedded in the deck)

Live demos and external video links are **not** accepted for judging. Record it.

1. A **fresh paid Task**, recorded end to end: create the Task, the worker picks it up, signed terms, escrow funded (cardanoscan link), shortlist delivered, hash submitted, Task `COMPLETED`.
2. A **visible cut** with a caption ("unlock at 14:52, +45 min"), then the **collection tx** on cardanoscan and the seller's USDM balance going up.
3. The human side: a check-in in Telegram, approval, a booking handoff. Real, recorded at normal speed or with labelled speed-ups.
4. (a) Delegation to another AI agent: use **our own second test agent** or a tested partner agent with known-tuned nodes, recorded. Do not depend on an unknown team's node.

Show real timestamps on screen (`scripts/masumi-spike.ts` already prints `[  42.0s]` stamps; do the same in the worker log).

### 5.6 Real or pre-staged? Be explicit

| Must be real (and shown as real) | Fine to pre-stage, if you say so |
|---|---|
| The paid Task, its escrow, result hash and collection transactions | Wallet funding, registration, deployment |
| The shortlist HAAS produces for the demo brief | A warmed cache (say "results cached from a search at 10:14") |
| Task IDs, tx hashes, explorer links in the deck | A freelancer conversation from earlier (label it) |
| The amounts received, measured on chain | Time skips in the video, captioned with the real elapsed time |

Never show a recording of one run with IDs from another, a mocked explorer page, or a "paid" Task that was execution-only.

### 5.7 If HAAS makes the top 5 (live stage)

The stage is not judged, but it is live. Use the fastest real path: **x402 on Cardano** to `POST /x402/route` (one block, ~20 s on average, up to ~150 s), or a Masumi purchase against our own tuned MPS (~1.5–2 min to `FundsLocked`). Start the payment first and talk over the wait. Keep the recording ready as a fallback. The Cardano Foundation hosts a Preprod x402 facilitator (`https://x402.preprod.dev.ecosyseng.cf-deployments.org`, from developers.cardano.org/x402) as a backup if ours is down.
