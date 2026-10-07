# Getting HAAS listed and hired on Masumi and Sokosumi

How to make HAAS findable so other agents, including other hackathon teams, can hire it live, and what to fix in the repo first.

Written 2026-10-06. Marked **(unverified)** where not checked against a live system.

---

## 1. There are three different "listings"

| Listing | What it is | Who finds HAAS through it | How they pay | How to get it |
|---|---|---|---|---|
| **Masumi registry entry** | An on-chain record (minted by our MPS) with our `apiBaseUrl`, pricing and metadata | Any Masumi buyer: `masumi-mcp-server`, the registry service search, scripts like ours | Their own MPS and purchasing wallet, escrow straight to us | `pnpm register:agent` (POST `/registry` on our MPS). 3–15 min for the mint. |
| **Sokosumi agent** (classic, MIP-003) | Sokosumi's marketplace calls our `/start_job` and pays from the buyer's Workspace credits | Sokosumi web users, `sokosumi agents hire`, Sokosumi MCP `create_job` | Sokosumi credits; Sokosumi's node pays our escrow | Sokosumi docs: "Register on Sokosumi… adding your agent's endpoint with pricing details". The review and lead time are not published (unverified). |
| **Sokosumi Coworker** (Tasks) | A Coworker owned by our Vendor; our worker polls for Tasks | Members of a Workspace where the Coworker is approved, e.g. the TOKEN2049 event Workspace | Workspace credits; Core funds escrow through `masumiPayment` | `docs/LIVE_CARDANO_PAYMENT.md` §4 and §11. Approval by an event admin; lead time unknown. |

The **Cardano track proof** uses the Coworker. **Other teams' agents** will most likely hire through the registry (MCP) or Sokosumi. Do all three, in this order: registry (needed anyway), Coworker plus event approval, then the Sokosumi agent listing.

The agent guide calls public discovery "a later milestone". Approval into the event Workspace makes HAAS visible to the event's members, not to the public.

## 2. Registry metadata that gets HAAS found

The search filters on `tags`, `capability` and a fuzzy `query` over the text. Fill every field. Changing metadata later means updating the registration (one more transaction).

| Field | Today in `scripts/register-agent.ts` | Recommended |
|---|---|---|
| `name` | `HAAS: Human as a Service` | keep |
| `description` | one sentence | Lead with the words a buyer agent would search for: "Hire a human freelancer for any task an AI can't do. Send a brief; get a ranked shortlist from Freelancer.com, RentAHuman, Fiverr and more, with price, time zone and track record; confirm one and it is booked." |
| `Tags` | `freelancers, hiring, marketplace, human-in-the-loop` | add `human-tasks`, `outsourcing`, `recruiting`, `gig-work`, `physical-world`, `token2049` |
| `Capability` | `{ name: 'haas', version: '0.1.0' }` | Many entries use the model name here (`masumi-skills` shows `gpt-4`). Use `{ name: 'human-router', version: '0.2.0' }`, or the main model name if the search UI groups by model (unverified which helps more). |
| `ExampleOutputs` | `[]` | At least one `{ name, url, mimeType }`: a real sample shortlist as JSON (`application/json`), served from a stable URL. Add a static route such as `GET /examples/shortlist.json`, or link a file in the public repo. |
| `Author` | `{ name: 'HAAS' }` | add the team or organization name and a contact address the team chooses |
| `apiBaseUrl` | `PUBLIC_URL` | the **final** Railway HTTPS URL, not a quick tunnel |
| Pricing | `Fixed`, 3 ADA | `{"pricingType":"Dynamic"}` per the TOKEN2049 guide, quoted as 1 test USDM per job (see §4.6) |
| Access model | default (`Standard`) | `Standard`. `OpenApi` or `X402` need other URLs; leave them for later. |

## 3. How another team hires HAAS

Give other teams this section. Each route needs HAAS's **agent identifier** or Sokosumi agent or Coworker ID, which we post in the event chat once we have them.

### Route A: `masumi-mcp-server` (agent to agent, on chain)

For teams that run their own MPS. Repo: https://github.com/masumi-network/masumi-mcp-server.

- Settings: `MASUMI_NETWORK=Preprod`, `MASUMI_REGISTRY_BASE_URL`, `MASUMI_REGISTRY_TOKEN`, `MASUMI_PAYMENT_BASE_URL` (their MPS), `MASUMI_PAYMENT_TOKEN` (a Pay key on their MPS).
- Install for Claude Desktop: `uv run mcp install server.py --name "Masumi Agent Manager" -f .env`.
- Tools: `list_agents` (registry), `get_agent_input_schema`, `hire_agent` (calls our `/start_job`, then purchases through their MPS), `check_job_status` (polls our `/status`), `get_job_full_result`.
- They need a purchasing wallet with test ADA and test USDM (https://dispenser.masumi.network).

### Route B: Sokosumi MCP or CLI (credits, no wallet)

The easiest route: no MPS and no wallet, just Sokosumi credits (Stripe test card on Preprod).

- MCP: repo https://github.com/masumi-network/Sokosumi-MCP. A hosted endpoint `https://mcp.sokosumi.com/mcp` uses OAuth. The network is set by `SOKOSUMI_NETWORK` (`mainnet` by default, or `preprod`, API `https://api.preprod.sokosumi.com`). For Preprod, run it locally with `SOKOSUMI_NETWORK=preprod` and `SOKOSUMI_API_KEY` (unverified whether the hosted endpoint can reach Preprod).
  - Classic agent: `list_agents()`, `get_agent_input_schema()`, `create_job(agent_id, max_accepted_credits, input_data, name)`, `get_job()`.
  - Coworker: `list_coworkers()`, `create_coworker_task()`, `get_task()`.
- CLI:
  ```sh
  sokosumi --preprod agents hire <AGENT_ID> --input-file brief.json --max-credits 25 --json
  # or, inside the event Workspace once HAAS's Coworker is approved:
  sokosumi --preprod tasks create --organization-slug token2049-origins-hackathon-2026-nws2r7 \
    --coworker-id <HAAS_COWORKER_ID> --name "Find a human" --description "<brief>" --status READY --json
  ```

### Route C: x402 (any HTTP client, no Masumi at all)

`POST {PUBLIC_URL}/x402/route` with a JSON brief returns HTTP 402 with the price. The client pays on Cardano Preprod and retries. See `src/payments/x402.ts`. The client needs `@x402/fetch` with the Cardano scheme and a wallet with tADA.

### A sample brief for other teams

```json
{ "task": "Photograph the storefront at 10 Bayfront Ave today", "skills": "photography",
  "budget_usd": 80, "deadline_days": 1, "location": "Singapore", "remote_ok": false }
```

## 4. Compatibility fixes in the repo (do before telling anyone)

`feat/masumi-compliance` exists for this and has no commits yet. Ordered by how likely each one is to break a live hire.

1. **Return `job_id` as well as `id` from `/start_job`.** MIP-003 names the field `id`, and HAAS returns `id`. The team lead reports that `masumi-mcp-server` reads `job_id`. I could not confirm that from the README; the source file was not checked. Sending both costs nothing and also covers clients built from older docs. Also add `status: "awaiting_payment"` (or `"running"` when unpaid) to the response.
2. **Add `GET /demo`.** MIP-003 lists `/demo` as one of the six endpoints for full compatibility; HAAS does not have it. Return a sample input and output (the same data as `ExampleOutputs`).
3. **Let non-interactive buyers finish without a check-in.** HAAS pauses at `awaiting_input` with a shortlist. MCP buyers and Sokosumi may not answer `awaiting_input` (unverified). Add an optional brief field, for example `auto_confirm: "shortlist_only"`, that ends the job with the ranked shortlist as the result. Make it the default for Sokosumi Tasks. Otherwise the job sits until `CHECKIN_TIMEOUT_MIN` (120 min) and ends with "no booking".
4. **Return `job_id` in `/status` too**, and accept the id from `?job_id=` (today) as well as `?id=`.
5. **`identifier_from_purchaser` must be 14–26 hex characters** when payments are on (an MPS rule). A client that sends a UUID gets a 400. Keep the check, but make the error message say exactly what to send, and put this rule in `/demo` and the README.
6. **Dynamic pricing in `createPayment`.** Under Dynamic pricing, `POST /payment` must carry the amount: 1 USDM = `1000000` of unit `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d`. Check the field name in the MPS OpenAPI (unverified). Also check that `masumi-mcp-server` and Sokosumi classic agents can buy from a Dynamic-priced agent (unverified). If they cannot, register a second entry with Fixed 1 USDM for MCP buyers and keep the Dynamic one for the track.
7. **`/provide_input` signature.** MIP-003 calls `signature` required (Ed25519). HAAS returns `""`, like the reference implementation. Strict clients may reject it. Low priority; note it in the README.
8. **Keep results small.** `masumi-mcp-server` has `get_job_full_result` for large outputs. Keep the shortlist under a few KB so `check_job_status` shows it inline.
9. **Stable public URL**, `/availability` returning `"available"` while the worker and MPS are healthy and `"unavailable"` when MPS is down, so buyers do not pay for a job that cannot start.
10. **Fix the x402 README.** `infra/x402-facilitator/README.md` says "There is no hosted Cardano facilitator". developers.cardano.org/x402 lists a Cardano Foundation Preprod facilitator: `https://x402.preprod.dev.ecosyseng.cf-deployments.org`.

## 5. Order of work and lead times

| Step | Lead time | Notes |
|---|---|---|
| Fix §4 items 1–6 | 2–3 h of code | before registering, so the first public entry already works |
| Deploy on Railway with the final URL | 30–60 min | `docs/LIVE_CARDANO_PAYMENT.md` §7 |
| Register on the Masumi registry | 10 min + 3–15 min mint | with full metadata (§2) |
| Coworker into the event Workspace | 5 min + a human approval of unknown length | ask early; ping the Masumi team at the venue |
| Sokosumi classic agent listing | unknown | ask the Masumi team how the Preprod listing is reviewed |
| Smoke test from outside | 30 min | from another laptop: `list_agents` finds HAAS, `hire_agent` gets a shortlist, the payment locks |
| Tell other teams | — | post the agent id, Coworker id, the sample brief, and route B as the easy path |

## 6. Outside smoke test

- [ ] `curl https://<haas>/availability` gives `available`
- [ ] `curl https://<haas>/input_schema` returns the brief schema
- [ ] the registry search for `freelancer` or `human` returns HAAS on Preprod
- [ ] `masumi-mcp-server` `hire_agent` returns a job and `check_job_status` reaches `completed` with a shortlist
- [ ] a Sokosumi Task in the event Workspace is picked up by the hosted worker within 10 s
- [ ] the payment for each reaches `FundsLocked`, and later a collection tx
