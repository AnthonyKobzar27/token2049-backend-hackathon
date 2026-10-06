---
name: haas
description: "Use this skill WHEN an agent or coding task needs a real person: work an AI cannot do itself (on-site photography, local errands, physical checks, verification by a human, design or writing by a professional freelancer). HAAS (Human as a Service) is a Masumi agent on Cardano Preprod: send a brief, get a ranked shortlist of freelancers across Freelancer.com, RentAHuman, Fiverr and more, confirm one and it is booked after a human approves. Triggers on: 'hire a human', 'find a freelancer', 'someone needs to go to', 'human in the loop', 'verify in person', 'real-world task'. NOT for: tasks the agent can finish itself, hiring employees, or paying a person directly."
---

# HAAS: hire a human from an agent

HAAS is the agent other agents call when a task needs a person. One brief goes in; HAAS searches several freelancer
platforms, ranks the people against the brief (suitability, price, location and time zone, availability, track
record) and returns a shortlist with a score, a one-line reason and what each platform does not publish. Nothing is
booked until a human confirms a candidate and approves the booking.

Network: Cardano **Preprod**. Fee: **1 test USDM** per job (Dynamic pricing), escrowed through Masumi.

## Pick a route

| You have | Use | Pays with |
|---|---|---|
| A Sokosumi account (easiest, no wallet) | Route A: a Sokosumi Task for the HAAS Coworker | Workspace credits |
| Your own Masumi Payment Service, or `masumi-mcp-server` | Route B: the MIP-003 API | test USDM from your purchasing wallet |
| Plain HTTP and a Cardano wallet, no Masumi | Route C: x402 | tADA |

Ask the operator for the IDs you need (HAAS agent identifier, Coworker ID, `HAAS_URL`). Never invent one.

## The brief

Every route takes the same fields. Only `task` is required.

```json
{
  "task": "Photograph the storefront at 10 Bayfront Ave today and send 10 edited photos",
  "skills": "photography, photo editing",
  "budget_usd": 80,
  "deadline_days": 1,
  "location": "Singapore",
  "remote_ok": false,
  "hours_needed": 2,
  "language": "en",
  "timezone": "Asia/Singapore",
  "notes": "Shoot before 11:00 while the shutters are open"
}
```

Set `remote_ok: false` whenever the person must be on site. Give a budget: candidates above it are filtered out.
Keep secrets, passwords and personal data of third parties out of the brief.

## Route A: Sokosumi Task (Coworker)

Uses the Sokosumi CLI (`npm i -g @masumi_network/sokosumi`, then `sokosumi --preprod auth login`). Put the brief JSON
(or plain text) in the description:

```bash
sokosumi --preprod tasks create --personal --coworker-id <HAAS_COWORKER_ID> \
  --name "Find a photographer" --description "$(cat brief.json)" --status READY --json
# inside an event Workspace use --organization-slug <slug> instead of --personal
sokosumi --preprod tasks get <TASK_ID> --json        # poll until COMPLETED or FAILED
sokosumi --preprod tasks events <TASK_ID> --json     # the COMPLETED event's comment is the result
```

HAAS picks the Task up within about 10 s, charges 1 USDM through a `masumiPayment` event (credits), and completes the
Task with the ranked shortlist: readable text, then the same data as JSON in a ```json block. A Task never books
anyone: to book, reply with the candidate you want (`sokosumi --preprod tasks comment <TASK_ID> --comment "..."`)
or use Route B. A `COMPLETED` Task proves delivery, not payment.

## Route B: MIP-003 API

`HAAS_URL` is the agent's `apiBaseUrl` in the Masumi registry.

1. `GET {HAAS_URL}/availability` must say `"available"`. `GET {HAAS_URL}/input_schema` returns the brief schema;
   `GET {HAAS_URL}/demo` a sample input and output.
2. Start the job. `identifier_from_purchaser` must be **14 to 26 hex characters** (payment service rule):

   ```bash
   curl -s -X POST "$HAAS_URL/start_job" -H 'content-type: application/json' \
     -d "{\"identifier_from_purchaser\":\"$(openssl rand -hex 10)\",\"input_data\":$(cat brief.json)}"
   ```

   The response carries `id` and `job_id` (same value), `status: "success"`, `blockchainIdentifier`, `payByTime`,
   `submitResultTime`, `unlockTime`, `externalDisputeUnlockTime`, `agentIdentifier`, `sellerVKey`, `input_hash`,
   and for Dynamic pricing `amounts` (1000000 of the test USDM unit), `paymentSourceType`,
   `supportedPaymentSourceIndex` and `smartContractAddress`. `payment_required: false` means the job runs unpaid.
3. Pay: `POST /purchase` on **your** payment service with those fields unchanged (`masumi-mcp-server`'s `hire_agent`
   does steps 2 and 3 for you). Never edit signed fields; ask for a new job instead.
4. Poll `GET {HAAS_URL}/status?job_id=<id>` every 10-30 s. `awaiting_payment` -> `running` -> `awaiting_input`.
5. **Check-in.** At `awaiting_input`, `result` (a JSON string) and `shortlist` hold the candidates and `input_schema`
   says what to answer. Show the candidates to your human and let them decide. Then answer once:

   ```bash
   # input_schema_hash = sha256 hex of the RFC 8785 canonical JSON of the input_schema /status just returned
   curl -s -X POST "$HAAS_URL/provide_input" -H 'content-type: application/json' -d '{
     "job_id": "<id>", "input_schema_hash": "<sha256>",
     "input_data": { "choice": "<one of the input_schema values, e.g. freelancer:123 | Ana (score 87/100, about $480)>" } }'
   ```

   `choice` takes one value of the `choice` field's `values`: a candidate (its id before ` | ` is enough),
   `different_options` (with an optional `feedback`, for a new round) or `cancel`. A stale or wrong
   `input_schema_hash` is a 400: fetch `/status` again and recompute it.
   The response's `signature` is Ed25519 over the UTF-8 `input_hash`; verify it with `GET {HAAS_URL}/signing_key`.
6. A confirmed candidate is booked only after the HAAS operator approves it. `completed` carries the outcome in
   `result`; `payment.result_hash` and later `payment.collection_tx_hash` show the escrow state.

The result window is 90 minutes from the start and does not pause during the check-in: answer within about an hour.

## Route C: x402

`POST {HAAS_URL}/x402/route` returns HTTP 402 with the price. Its body uses camelCase brief fields (`task`,
`skills` as an array, `budgetUsd`, `deadlineDays`, `location`, `remoteOk`, `hoursNeeded`, `language`, `timezone`,
`notes`). Pay on Cardano Preprod with an x402 client that supports the Cardano scheme (`@x402/fetch` +
`@x402/cardano`) and retry: the answer is `202 { job_id, status_url }`. Poll `GET status_url`; at `awaiting_input`
it lists `candidates`. Answer with `POST {HAAS_URL}/x402/jobs/<job_id>/input` and one of
`{"action":"confirm","profileId":"<profile_id>"}`, `{"action":"refine","feedback":"..."}` or `{"action":"cancel"}`.

## Rules

- A human decides who is hired. Show the shortlist with its reasons and unknowns; do not confirm on your own unless
  your human told you to pick the top candidate.
- Do not claim a person was booked, paid or finished until the job result or the operator says so. A `COMPLETED`
  Task or a `PURCHASED` state is not proof of payment; a confirmed collection transaction is.
- Keys come from your own `.env`; never paste them into briefs, comments or logs.
- On errors, report the HTTP status and message. Do not retry a payment step without first reading its state.

Source and docs: https://github.com/oliver-sommer/token2049-origins-hackathon
