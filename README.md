# HAAS: Human as a Service

**An open router for freelancers, run as an agent on Cardano's Masumi network.**

AI agents are good at digital work and stop at anything that needs a person. HAAS is the agent other agents (and people) call when they need a human: describe the task once, and HAAS searches many freelancer platforms, picks the best person for that specific need, checks the choice with you, and books them.

Built for the TOKEN2049 Origins hackathon.

## The idea

Hiring a freelancer today means choosing a platform first, then searching it by hand. Agents can't do even that: most platforms have no API for it.

HAAS works like OpenRouter does for language models. One request goes in; HAAS fans it out across platforms, normalises every freelancer into one profile shape, and ranks them against the brief:

- **Suitability** for the task at hand
- **Price**, with hourly and fixed quotes made comparable
- **Location and time zone**
- **Availability and hours**
- **Track record**, with ratings weighted by how many reviews stand behind them

Every candidate comes back with a score, a one-line reason, and a plain list of what the platform doesn't publish, so nothing unknown is passed off as known.

## Human in the loop

Nothing is booked until a person agrees.

1. **Check-in before booking.** The job pauses with a shortlist. You confirm a candidate, ask for different options, or change the brief. This uses the `awaiting_input` step built into Masumi's agent API, so any Masumi client gets it for free.
2. **Approval for binding actions.** Booking, paying, accepting a delivery, asking for a revision and cancelling each wait for an explicit approval.
3. **Check-ins after booking.** HAAS keeps both people informed: it answers the freelancer's routine questions from the brief, and when it can't, it asks you and relays the answer.

## How it works

```
Sokosumi / any Masumi agent ─┐
Telegram bot                 ├─> HAAS agent API (MIP-003)
x402 client (Cardano/Solana) ─┘     start_job · status · provide_input
                                        │
                              Scope -> "Can an AI agent do it?"
                                 │ yes                │ no, or the AI attempt fails / times out
                     Hire a Masumi AI agent           │
                     (MIP-003, paid on Cardano)       │
                                                      │
                     Router: search -> normalise -> filter -> rank -> explain
                                                      │
     ┌────────────────┬─────────────────┼──────────────────────────┬───────────────────┐
 Freelancer.com    Upwork          RentAHuman        Fiverr · PeoplePerHour · Guru   Prolific
  official API   GraphQL API      official API     (· Upwork) read in the operator's  participant pool:
                                                     own browser                     draft study, approve to publish
```

- **AI first.** A fast model (with a keyword fallback) decides whether the work is digital. If it is, HAAS hires another Masumi agent: it starts a MIP-003 job, locks the fee through the Masumi payment service (skipped for free/demo agents), polls for the result and checks its MIP-004 hash, all within a time budget (default 60s). Anything that needs a person, or any AI attempt that fails or runs out of time, goes to the human router below. The job result records `path: "ai"` or `"human"`.
- **Front doors.** A standard Masumi agent API (MIP-003), a Telegram bot for people, and an x402 pay-per-request endpoint for agents that don't speak Masumi.
- **Sources.** Official APIs where they exist. Platforms without one are read in the operator's own logged-in Chrome at human pace; if a site asks for a human check, HAAS stops and asks the operator. It does not solve challenges or disguise itself.
- **Payments.**
  - *Job fee*: through the Masumi Payment Service on Cardano, or x402 in stablecoin (USDM on Cardano Preprod or USDC on Solana devnet; one setting picks the chains, see [docs/X402.md](docs/X402.md)).
  - *Booking budget on Solana*: the hirer's budget is held in USDC per booking, released when the delivery is accepted and refunded on cancellation.

| Source | How | Credentials | Booking |
|---|---|---|---|
| Freelancer.com | Official REST API | None for search; `FREELANCER_SANDBOX_TOKEN` for sandbox writes | Hire Me project (sandbox only) |
| RentAHuman | Official REST API | None; `RENTAHUMAN_API_KEY` raises limits | Handoff |
| Upwork | Official GraphQL API (`freelancerProfileSearchRecords`, enriched with `freelancerProfileByProfileKey`) | `UPWORK_ACCESS_TOKEN`, or `UPWORK_CLIENT_ID`/`SECRET` (client credentials, Enterprise only). Needs an Upwork-approved API key | Handoff to the profile; HAAS never sends offers |
| Prolific | Official REST API, as a participant pool: one candidate priced as rewards plus fee, with time to fill and pool size | `PROLIFIC_API_TOKEN` (researcher account) | Draft study; publishing needs a `pay` approval; submissions become the delivery |
| Fiverr, PeoplePerHour, Guru, Upwork | Read in the operator's Chrome (`BROWSER_SITES`, Upwork as `upwork-browser`) | Operator's own logins | Handoff in the browser |

Each source has a search timeout (`SOURCE_TIMEOUT_MS`, and lower ones for Upwork and Prolific), so a slow platform never holds up the shortlist.

## Honest limits

- Freelancer platforms pay their sellers in fiat and forbid paying them elsewhere, so the Solana escrow protects the **hirer's** money; the operator fronts the platform payment and is repaid on release. The escrow is a server-held vault, not an on-chain program.
- Reading Fiverr or Upwork with automation is against their rules and can get an account suspended. It is opt-in, and booking there is always finished by a person.
- Upwork's API is gated: Upwork reviews each API key request, and the client-credentials grant is for Enterprise accounts. The adapter follows Upwork's published GraphQL schema but has not been run against the live API.
- Prolific suits microtasks only (surveys, labeling, user tests, short checks). Answers stay in the hirer's own task tool; HAAS sees submissions and completion codes. The service fee is estimated high; the draft study shows the exact cost before anything is published.
- Coverage of sites without an API depends on that browser session not being blocked. Results are cached so a blocked site degrades to slightly stale listings.

## Status

Work in progress. Each module has unit tests; live search works today on Freelancer.com and RentAHuman without credentials. Upwork and Prolific are written and unit-tested against fixtures in the published API shapes but need credentials to run live. The Telegram bot, the language-model calls, Masumi payments, x402 and Fiverr reading are written but have not yet been run against live services.

## Running it

Requires Node 22 and pnpm.

```bash
pnpm install
```

```bash
pnpm test
```

Copy `.env.example` to `~/.haas/.env` and fill in what you have (everything is optional; missing pieces switch themselves off), then:

```bash
pnpm start
```

Secrets and the database live in `~/.haas/`, outside the repository.

With `SOKOSUMI_COWORKER_ID` and `SOKOSUMI_COWORKER_API_KEY` set, `pnpm start` also runs the Sokosumi Coworker
worker. It can run alone with `pnpm sokosumi:worker` (`--check` verifies the key and lists READY Tasks).
The live Cardano runbook is `docs/LIVE_CARDANO_PAYMENT.md`; the payment service setup is `infra/masumi/README.md`.

### Matching and speed

- Each request is weighed by task type: on-site errands lean on distance and the requested day and time; remote work leans on fit and price. Override with `ROUTER_WEIGHTS`.
- Day and time ("Saturday 2-5pm", "tomorrow morning") are read from the brief and checked against each person's time zone and published schedule. Unknowns cost a little and never drop anyone.
- Without an API key, fit is scored by TF-IDF over title, skills and bio with a synonym map; with one, the model scores in parallel batches within the time budget.
- A search answers within `SEARCH_BUDGET_MS` (6 s): sources still running are marked late and fill the cache for the next search, and expired cache is served at once while it refreshes.

For the stage, warm the cache and pin it:

```bash
pnpm demo:warm
DEMO_MODE=true pnpm start
```

## Layout

| Path | What it holds |
|---|---|
| `src/router/` | Filters, scoring, explanations, suitability |
| `src/sources/` | One adapter per platform, plus the registry and cache |
| `src/engine/` | Job and booking lifecycles |
| `src/masumi/` | MIP-003 API and Masumi payments |
| `src/sokosumi/` | Sokosumi Coworker worker: runs HAAS on Tasks and settles each through Masumi |
| `skills/haas/` | Skill that teaches coding agents to hire a human through HAAS |
| `src/channels/`, `src/agent/` | Telegram bot, brief intake, liaison between hirer and freelancer |
| `src/approvals/` | Approval gate and autonomy policy |
| `src/payments/` | Solana escrow and the x402 paywall |
| `src/domain/` | Shared types and module contracts |
