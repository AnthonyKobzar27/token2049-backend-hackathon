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
x402 client (Cardano)        ─┘     start_job · status · provide_input
                                        │
                                   Router: search -> normalise -> filter -> rank -> explain
                                        │
        ┌──────────────┬────────────────┼─────────────────┐
   Freelancer.com   RentAHuman     Fiverr · PeoplePerHour · Guru
    official API    official API   read in the operator's own browser
```

- **Front doors.** A standard Masumi agent API (MIP-003), a Telegram bot for people, and an x402 pay-per-request endpoint for agents that don't speak Masumi.
- **Sources.** Official APIs where they exist. Platforms without one are read in the operator's own logged-in Chrome at human pace; if a site asks for a human check, HAAS stops and asks the operator. It does not solve challenges or disguise itself.
- **Payments.**
  - *Job fee on Cardano*: through the Masumi Payment Service, or x402 on Cardano Preprod.
  - *Booking budget on Solana*: the hirer locks the budget in USDC in an on-chain escrow per booking, released when the delivery is verified and refunded on cancellation or timeout. See [Booking budget on Solana](#booking-budget-on-solana).

## Honest limits

- Freelancer platforms pay their sellers in fiat and forbid paying them elsewhere, so the Solana escrow protects the **hirer's** money; the operator fronts the platform payment and is repaid on release. A worker who publishes a Solana wallet (RentAHuman) is paid directly instead.
- The escrow program compiles and its IDL is checked against the compiler output, but it has not been deployed from this repository yet: see `programs/haas-escrow/README.md`.
- Reading Fiverr with automation is against Fiverr's rules and can get an account suspended. It is opt-in, and booking there is always finished by a person.
- Coverage of sites without an API depends on that browser session not being blocked. Results are cached so a blocked site degrades to slightly stale listings.

## Status

Work in progress. Each module has unit tests; live search works today on Freelancer.com and RentAHuman without credentials. The Telegram bot, the language-model calls, Masumi payments, x402 and Fiverr reading are written but have not yet been run against live services.

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

## Booking budget on Solana

`ESCROW_PROVIDER` picks how the hirer's budget is held:

| Value | What holds the money |
|---|---|
| `solana-program` | The `haas-escrow` Anchor program (`programs/haas-escrow`): one PDA per booking, USDC in a vault the PDA owns. |
| `solana-vault` (or `solana`) | A wallet derived per booking from the operator key, held by the server. Fallback. |
| `memory` | Nothing; deposits are instant. Development only. |

With `solana-program` the flow is:

1. **Lock.** When a booking is created, HAAS shows a Solana Pay QR (`escrow.payUrl`, also served as `/solana-pay/qr/<bookingId>.png`). It is a [transaction request](https://docs.solanapay.com/spec#specification-transaction-request): the hirer's wallet POSTs its address to `/solana-pay/escrow/<bookingId>` and receives one `initialize_and_deposit` transaction to sign. The escrow fixes the amount, the payee and a deadline.
2. **Detect.** `BookingService.tick` reads the escrow account. A full deposit in the right mint, to the right payee, with at least the agreed deadline moves the booking on to the `book` approval; anything else is refunded.
3. **Release.** The QA step calls `bookings.releaseOnVerified(bookingId, resultHash)` once a delivery is verified. HAAS (the escrow's `authority`) signs `release(result_hash)`, which pays the payee and records the hash of the delivery on chain. The payee is the worker's wallet when their profile publishes one; otherwise the operator, who pays the platform in fiat on the hirer's behalf and is reimbursed by the escrow.
4. **Timeouts** (`tick`). Not funded within `ESCROW_DEPOSIT_TIMEOUT_MIN`: booking cancelled, nothing to return. Funded but no accepted delivery by the deadline: refunded to the hirer. After the deadline the program lets **anyone** refund, so the hirer's money does not depend on the HAAS server.
5. **Record.** Every transaction is kept on the escrow record (`txs`, with devnet explorer links), and `escrow.updated` / `escrow.timeout` events reach the channels.

The deadline is the brief's delivery window (or `ESCROW_DELIVERY_DAYS`) plus `ESCROW_GRACE_HOURS` for review; `ESCROW_DEADLINE_MIN` overrides it for demos. `pnpm spike:solana` runs lock, release, cancel and timeout refund on devnet against the deployed program (`--vault` for the vault).

## Layout

| Path | What it holds |
|---|---|
| `src/router/` | Filters, scoring, explanations, suitability |
| `src/sources/` | One adapter per platform, plus the registry and cache |
| `src/engine/` | Job and booking lifecycles |
| `src/masumi/` | MIP-003 API and Masumi payments |
| `src/channels/`, `src/agent/` | Telegram bot, brief intake, liaison between hirer and freelancer |
| `src/approvals/` | Approval gate and autonomy policy |
| `src/payments/` | Solana escrow (program client, Solana Pay endpoint, vault fallback) and the x402 paywall |
| `programs/haas-escrow/` | The on-chain escrow program (Anchor) and its IDL |
| `src/domain/` | Shared types and module contracts |
