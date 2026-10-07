# HAAS: Human as a Service

**The escalation layer for the agent economy. Identity on Cardano, settlement on Solana.**

AI agents are good at digital work and stop at anything that needs a person: calling a clinic, checking an item in person, picking something up. HAAS is the agent other agents (and people) call when they get stuck. It finds the right human across many freelancer platforms, checks the choice with you, locks the budget in escrow on Solana, verifies the work, pays the human, and records their reputation on Cardano.

Built for the TOKEN2049 Origins hackathon.

## The idea

- **One call, best human.** HAAS works like OpenRouter does for language models. One brief goes in. HAAS fans it out to Freelancer.com, RentAHuman, Upwork, Prolific, Fiverr, PeoplePerHour, Guru and its own bounty board for local microtasks, then ranks every person on fit, price, rating, availability, day and time, and distance.
- **Downstream of every agent.** HAAS is listed on the Masumi agent marketplace. Any Masumi agent that can't finish a task hires HAAS through the standard agent API. HAAS also tries another AI agent first when the work turns out to be digital.
- **Trust built in.** Workers carry a verifiable credential and an on-chain record of past jobs. Money sits in escrow until the result is checked, and is refunded automatically if nobody delivers.

## Two chains, two jobs

| | Cardano: identity | Solana: settlement |
|---|---|---|
| What lives there | Who the agent is and who the workers are | Where the money moves |
| HAAS uses it for | Masumi registry listing and the MIP-003 agent API; a CIP-68 "HAAS Verified Worker" credential per worker; a reputation update and receipt NFT per completed job; Veridian (KERI) credentials | A USDC escrow per booking (the `haas-escrow` program); release bound to the hash of the verified result; automatic refund at the deadline; the worker paid in USDC; x402 pay-per-request in USDC |
| Why that chain | Masumi's identity, registry and agent marketplace are Cardano's agent story | Fast, cheap stablecoin transfers and most x402 volume |

**One payment stays on Cardano.** When another Masumi agent hires HAAS, it pays a small job fee in USDM through Masumi's own escrow on Cardano. That is how Masumi agents pay each other, and the Cardano track asks for that transaction as proof. The human's budget and the human's pay settle on Solana.

## How it works

```
Callers: any Masumi agent (MIP-003 / Sokosumi Coworker) · x402 (USDC on Solana) · Telegram
                                     │  Masumi job fee in USDM on Cardano (agent-to-agent only)
                                     ▼
 1  Scope the brief ............... task, skills, budget, place, day/time
 2  Can an AI agent do it? ........ yes: hire a Masumi AI agent ─────────────────────────┐
                                     │ no, or the AI attempt fails or times out          │
 3  Open router ................... Freelancer.com · RentAHuman · Upwork · Prolific ·    │
                                     Fiverr/PeoplePerHour/Guru (browser) · bounty board  │
                                     + "verified" boost from the Cardano credential      │
 4  Check-in (awaiting_input) ..... you pick; signed provide_input                       │
 5  Lock the budget ............... USDC into the Solana escrow, with payee and deadline │
 6  The human does it ............. platform booking, or bounty: claim -> submit         │
 7  Verify ........................ rule checks + AI QA: pass / one revision / reject    │
 8  Settle on Solana .............. release pays the worker, bound to the result hash;   │
                                     rejection or deadline -> automatic refund           │
 9  Reputation on Cardano ......... CIP-68 update + receipt NFT; Veridian credential     │
10  Result to the caller .......... /status; Masumi submit-result ◄──────────────────────┘
```

1. **Scope.** A brief arrives through MIP-003 `start_job`, the Sokosumi Coworker worker, the x402 endpoint or Telegram. Day and time ("Saturday 2-5pm"), place and on-site need are read from the text.
2. **AI first.** A fast model (keyword rules without an API key) decides whether the work is digital. If so, HAAS hires another Masumi agent within `AI_TIME_BUDGET_MS` and checks its result hash. Anything that needs a person, or any AI attempt that fails, goes to the human router.
3. **Open router.** Every enabled source is searched within `SEARCH_BUDGET_MS`. Profiles are scored per task type. Workers holding a HAAS credential get a small, capped boost and a `verified` label.
4. **Check-in.** The job pauses in `awaiting_input` with the shortlist. The caller's choice must carry `input_schema_hash`, and HAAS signs its reply with Ed25519.
5. **Lock.** The hirer deposits the budget in USDC into the `haas-escrow` program through a Solana Pay QR. The escrow fixes the amount, the payee and an on-chain deadline. Nothing is booked until the deposit lands and the booking is approved.
6. **Do the work.** Platform bookings are placed or handed off. Bounty tasks go to nearby verified workers, who claim and submit structured results on a mobile page or in Telegram.
7. **Verify.** Every delivery is checked: rule checks first, then a Claude rubric against the brief. Pass: the hirer approves the release, or it is automatic under `AUTO_RELEASE_MAX_USD`. Fail: one revision request, then rejection.
8. **Settle.** The release records the result hash on Solana and pays the payee. A rejection, a cancellation or a passed deadline refunds the hirer. After the deadline anyone can trigger the refund, so the hirer's money never depends on the HAAS server.
9. **Reputation.** A completed, verified job updates the worker's CIP-68 credential on Cardano and mints a receipt NFT linking the job, the result hash and the Solana payment.
10. **Result.** `/status` returns the result, for example "Booked: Thursday 3pm, ref 88213", plus the verified result hash. For a paid Masumi job, HAAS submits the MIP-004 hash of that result to Masumi.

## Human in the loop

Nothing binding happens without a person.

- **Check-in before booking.** You confirm a candidate, ask for other options, or change the brief.
- **Approval for binding actions.** Booking, paying, accepting a delivery, asking for a revision and cancelling each wait for approval.
- **Quality check before payment.** No escrow is released until the delivery passes QA. When the model is slow, unavailable or unsure, a person decides.
- **Check-ins after booking.** HAAS answers the worker's routine questions from the brief and relays the rest to you.

## Sources

| Source | How | Credentials | Booking |
|---|---|---|---|
| Freelancer.com | Official REST API | None for search | Hire Me project (sandbox only) |
| RentAHuman | Official REST API | None; `RENTAHUMAN_API_KEY` raises limits | Handoff |
| Upwork | Official GraphQL API | `UPWORK_ACCESS_TOKEN`; Upwork must approve the key | Handoff to the profile |
| Prolific | Official REST API, as a participant pool | `PROLIFIC_API_TOKEN` | Draft study, published only after approval |
| Fiverr, PeoplePerHour, Guru, Upwork | Read in the operator's own Chrome (`BROWSER_SITES`) | Operator's logins | Handoff in the browser |
| Bounty board | HAAS's own pool of verified local workers | None | Claim and submit on `/w/<token>` or Telegram |

Each source has its own timeout, so a slow platform never holds up the shortlist.

## Bounty board

Some jobs are five minutes of a person's time: a phone call, an errand, a photo of a noticeboard.

```
"Call Tanjong Pagar Polyclinic and book the earliest physio slot this week"
  -> bounty "Phone call, ~5 min, S$3" with result fields: date, time, reference
  -> offered to nearby verified workers (first claim wins)
  -> claimed -> submitted -> verified -> released on Solana
  -> /status: "Booked: Thursday 3pm, ref 88213"
```

- **Lifecycle.** `posted -> claimed -> submitted -> verified -> paid`, or `rejected`, `expired` or `cancelled`. An unclaimed or unsubmitted bounty expires and the escrow is refunded.
- **No app for workers.** A mobile page per bounty and Telegram commands (`/link`, `/tasks`, `/claim`, `/submit`, `/ask`).
- **Legitimate work only.** Briefs that ask for CAPTCHA solving, getting around a site's controls, bulk accounts or fake reviews are refused.

## Identity on Cardano

- **HAAS Verified Worker credential.** A CIP-68 token pair on Cardano Preprod. Each completed, verified job updates its on-chain record (jobs completed, average rating, total earned) and mints a receipt NFT. See [docs/IDENTITY.md](docs/IDENTITY.md).
- **Veridian.** Workers can also hold a KERI ACDC credential in their Veridian wallet, checked against KERIA. See [docs/VERIDIAN.md](docs/VERIDIAN.md).
- **The agent itself.** HAAS is registered on the Masumi registry with tags such as `human-in-the-loop` and `hire-human`, so other agents can find it. See [docs/MASUMI_MARKETPLACE.md](docs/MASUMI_MARKETPLACE.md).
- `GET /workers/:id/reputation` returns a worker's asset ids and Cardanoscan links.

## Settlement on Solana

`ESCROW_PROVIDER` picks how the hirer's budget is held:

| Value | What holds the money |
|---|---|
| `solana-program` | The `haas-escrow` Anchor program: one PDA per booking, USDC in a vault the PDA owns. Use this for the demo. |
| `solana-vault` | A wallet derived per booking from the operator key, held by the server. Fallback. |
| `memory` | Nothing; deposits are instant. Development only, and the default. |

With `solana-program`:

1. **Lock.** A Solana Pay transaction request (`/solana-pay/escrow/<bookingId>`) returns one `initialize_and_deposit` transaction for the hirer to sign.
2. **Detect.** HAAS reads the escrow account. A full deposit in the right mint, to the right payee, with the agreed deadline moves the booking on.
3. **Release.** Once QA passes, HAAS signs `release(result_hash)`. The payee is the worker's Solana wallet when they publish one; otherwise the operator, who pays the platform in fiat and is reimbursed.
4. **Timeouts.** Not funded in time: cancelled. Funded but not accepted by the deadline: refunded to the hirer.
5. **Record.** Every transaction is kept on the escrow record with devnet explorer links.

x402 pay-per-request takes USDC on Solana devnet. The default `X402_NETWORK` also accepts USDM on Cardano; set `X402_NETWORK=solana:devnet` to settle on Solana only. See [docs/X402.md](docs/X402.md). `pnpm spike:solana` runs lock, release, cancel and refund on devnet.

## Running it

Requires Node 24 (Node 22.5+ works for the app; the Sokosumi CLI wants 24) and pnpm.

```bash
pnpm install
pnpm test              # 497 tests
pnpm typecheck
```

Copy `.env.example` to `~/.haas/.env` and fill in what you have. Every key is optional; missing pieces switch themselves off and say so at boot. Then:

```bash
pnpm start
```

No keys at all:

```bash
pnpm demo:bounty                    # the clinic story end to end, in one process
pnpm identity:demo                  # Cardano reputation on an in-memory chain
pnpm demo:warm && DEMO_MODE=true pnpm start   # ~2 s shortlists for the stage
```

**Testing by hand, and everything that still needs a person:** [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md).

Secrets and the database live in `~/.haas/`, outside the repository.

## Status

Every step of the flow is built and covered by unit and end-to-end tests, with fakes standing in for outside services. Run by hand without keys: the MIP-003 API, routing with day, time and location, the signed check-in, the bounty board and rule-based QA.

Not yet run against the live service:

- **Solana escrow program.** It compiles and its IDL is checked, but it is not deployed yet, so `SOLANA_ESCROW_PROGRAM_ID` is a placeholder. See `programs/haas-escrow/README.md`.
- **The paid Masumi job.** The payment service setup in `infra/masumi` has not been run. The live runbook is [docs/LIVE_CARDANO_PAYMENT.md](docs/LIVE_CARDANO_PAYMENT.md).
- **Others.** Hiring a real Masumi AI agent, the Telegram bot, the language-model paths, x402, Upwork, Prolific, Veridian, and reputation minting on Preprod.

## Honest limits

- **Bounty payouts are ledger entries today.** A bounty worker is paid on chain only when their Solana wallet is the escrow payee. Otherwise the payout is recorded but no USDC moves.
- **Platform workers are paid in fiat.** Freelancer platforms pay their sellers themselves and forbid paying them elsewhere. For those bookings the Solana escrow protects the hirer's money, and the operator fronts the platform payment and is repaid on release.
- **Automated reading of Fiverr or Upwork is against their rules.** It is opt-in, and booking there is always finished by a person.
- **Upwork's API is gated.** Upwork reviews each key request.
- **Prolific suits microtasks only:** surveys, labeling, user tests, short checks.
- **Without Telegram, approvals pass automatically.** Fine for rehearsals; configure the bot for anything real.

## Docs

| Doc | What it covers |
|---|---|
| [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md) | Manual checklist, per-step tests, demo rehearsal |
| [docs/LIVE_CARDANO_PAYMENT.md](docs/LIVE_CARDANO_PAYMENT.md) | One live paid Task on Cardano Preprod |
| [docs/MASUMI_MARKETPLACE.md](docs/MASUMI_MARKETPLACE.md) | Listing and discovery on Masumi and Sokosumi |
| [docs/DELEGATION_AND_SPEED.md](docs/DELEGATION_AND_SPEED.md) | Agent and human delegation, latency, demo speed |
| [docs/IDENTITY.md](docs/IDENTITY.md) | CIP-68 credential and reputation |
| [docs/VERIDIAN.md](docs/VERIDIAN.md) | Veridian KERI credentials |
| [docs/X402.md](docs/X402.md) | x402 pay-per-request |
| `programs/haas-escrow/README.md` | Building and deploying the Solana escrow |
| `skills/haas/SKILL.md` | Teaches coding agents to hire a human through HAAS |

## Layout

| Path | What it holds |
|---|---|
| `src/router/` | Filters, scoring, explanations, suitability |
| `src/sources/` | One adapter per platform, plus the registry and cache |
| `src/bounty/` | Bounty board: workers, lifecycle, result checks, worker page, Telegram commands |
| `src/delegate/` | AI-or-human decision and hiring other Masumi agents |
| `src/engine/` | Job and booking lifecycles |
| `src/masumi/` | MIP-003 API, Masumi payments, buyer client, signing |
| `src/sokosumi/` | Sokosumi Coworker worker |
| `src/verify/` | Result QA and the shared result hash |
| `src/payments/` | Solana escrow client, Solana Pay endpoint, vault fallback, x402 |
| `programs/haas-escrow/` | The Solana escrow program (Anchor) and its IDL |
| `src/identity/` | Cardano CIP-68 credential and reputation; Veridian in `src/identity/veridian/` |
| `src/channels/`, `src/agent/` | Telegram bot, brief intake, hirer-worker liaison |
| `src/approvals/` | Approval gate and autonomy policy |
| `src/e2e/` | End-to-end tests of the whole flow |
| `src/domain/` | Shared types and module contracts |
