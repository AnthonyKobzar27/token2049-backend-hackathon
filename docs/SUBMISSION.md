# Submission: run-of-show and artifact checklist

The Cardano track accepts only a **recording embedded in the deck**. This file
is the script for that recording and the list of every field the deck needs.
Rehearse with `docs/MANUAL_TESTING.md` §3; the demo must already pass before
you press record.

## Run-of-show (target: under 4 minutes)

**Scene 1 — the pitch (20 s).** The landing page (haas-token2049.vercel.app):
"Agents think. We give them hands." AI agents have money and no legs; HAAS is
the exit from the agent world into the human world.

**Scene 2 — an agent hires a human (90 s).** Terminal, or a Sokosumi Task:

```bash
curl -s -X POST localhost:8787/start_job -H 'content-type: application/json' -d '{
  "identifier_from_purchaser":"'$(openssl rand -hex 10)'",
  "input_data":{"task":"Call Tanjong Pagar Polyclinic and book the earliest physio slot this week","location":"Singapore","budget_usd":5}}'
```

Narrate while it runs: HAAS first asks *can an AI do this?* — no, it needs a
phone call — then searches the bounty board and five freelancer platforms.
Show the shortlist (verified workers, scored, with reasons). Confirm one via
`/provide_input`. Point at the Ed25519 signature in the response.

**Scene 3 — the human loop (60 s).** Phone screen recording: the Telegram
worker gets the task, taps **Claim**, "makes the call", submits date / time /
reference. Operator phone: the **Approve** button on the booking, then on the
QA verdict. Dashboard in the background showing the live activity feed.

**Scene 4 — money and proof on Cardano (60 s).**
- `/status` result: `"Booked: Thursday 3pm, ref 88213"` with `verifiedResult.hash`.
- The Masumi escrow: payment locked in test USDM, result hash submitted
  (MIP-004), and the **collection transaction on Cardanoscan Preprod** — the
  money actually arriving. This link is the track's required proof.
- The worker's reputation: `GET /workers/<id>/reputation` with the CIP-68
  credential and the receipt minted for this job.

**Scene 5 — close (15 s).** The agent is registered on the Masumi registry:
any agent on Cardano can hire it. Humans as a service, escrowed, verified,
reputation on chain.

### Bad-path inserts (have clips ready, use one if time allows)
- Submit a past date → QA asks for a revision.
- Deny twice → rejected, escrow refunded automatically.

## Deck fields (fill every one before submitting)

| Field | Value |
|---|---|
| Public repo + run instructions | github.com/oliver-sommer/token2049-origins-hackathon (branch: ___) |
| Landing page | https://haas-token2049.vercel.app |
| Deployed agent URL (`PUBLIC_URL`) | ___ |
| Masumi agent identifier | ___ (printed by `pnpm register:agent`) |
| Seller address | ___ |
| USDM unit | ___ |
| Sokosumi Coworker ID | ___ |
| Rehearsal Task ID (unpaid) | ___ |
| Paid Task ID | ___ |
| Collection transaction hash + Cardanoscan link | ___ |
| Net USDM received (measured) | ___ |
| Recording | embedded in the deck (not an external link) |

## Honesty notes for Q&A

Say these before a judge finds them:
- Bounty payouts to workers are ledger entries unless the worker's wallet is
  the escrow payee; the Masumi escrow settlement itself is fully on chain.
- If the Solana program is not deployed, the demo uses the memory escrow and
  we say so; the Cardano path is the live one.
- Third-party platforms (Fiverr and co.): HAAS searches and drafts, a person
  completes the platform's own checkout — the agent never enters card details.

## Timing

The paid Task's unlock + collection wait is ~60 minutes. Start the paid run
at least 2 hours before the deadline; record Scene 4's collection link last.
