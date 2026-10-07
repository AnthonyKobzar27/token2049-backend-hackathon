# Initial test audit of the live HAAS agent

Date: 2026-10-07 (afternoon SGT). Target: the registered public deployment at
`https://b50e-158-140-149-130.ngrok-free.app`, agent identifier
`67ab0c92…133000000`, registered on Cardano Preprod
([mint tx](https://preprod.cardanoscan.io/transaction/d68d3ae050d562859a6264a99c5a40d50ad656a7a4f883a4df37d20cbfc4be8e)).
Local baseline at the same time: `main` @ `59c3cd6`, `pnpm typecheck` clean,
**538/538 tests pass**, clinic demo (`pnpm demo:bounty`) passes end to end.

## Results by surface

| # | Probe | Result | Verdict |
|---|---|---|---|
| 1 | `GET /health` | 200; rentahuman, fiverr, freelancer, peopleperhour, guru enabled; 0.7 s via tunnel | ✅ |
| 2 | `GET /availability` | `{"status":"available","type":"masumi-agent",…}` | ✅ |
| 3 | `GET /input_schema` | 13 fields (task … task_type) | ✅ |
| 4 | `GET /signing_key`, `GET /demo` | both 200 | ✅ |
| 5 | `POST /start_job` (paid) | **200 with full payment terms**: `payment_required:true`, price "1 USDM", correct `agentIdentifier`, `sellerVKey`, escrow contract `addr_test1wzs4e6wc…`, pay-by/submit/unlock/dispute times, MIP-004 `input_hash` | ✅ **paid path works** |
| 6 | `POST /start_job` missing task | 400 `task: Invalid input: expected string…` (JSON) | ✅ |
| 7 | `POST /start_job` malformed JSON | **HTML `SyntaxError` stack-trace page** | ❌ old code (see D1) |
| 8 | `POST /x402/route` unpaid | **HTTP 402** with well-formed v2 `payment-required` offer | ✅ (resource URL is `http://…` — see D3) |
| 9 | `GET /api/overview` with **no token** | **200, full operator data** (12 jobs, approvals, booking counts) | ❌ **critical** (see D2) |
| 10 | `GET /status?job_id=unknown` | connection dropped (ngrok hiccup after burst) | ⚠ retest |

An earlier probe the same day had `start_job` → 500 "could not create the
payment request" (agent could not reach the MPS). That is fixed in the current
deployment; noted in case it recurs — the knobs are `MASUMI_API_URL` /
`MASUMI_API_KEY` / `MASUMI_AGENT_IDENTIFIER` in the agent's environment.

## Diagnosis

**D1 — the deployment runs outdated code.** Probe 7 is the fingerprint: current
`main` answers `{"error":"invalid JSON body"}` via the global JSON error
handler; HTML stack-trace pages only exist in older builds. The live process
predates the API hardening (JSON errors, 404 mapping, input validation,
bearer-scheme fix, x402 resource URL) and today's router/intake work.
**Fix:** on the host machine `git pull` (main) → `pnpm install` → restart.
The ngrok URL — and therefore the on-chain registration — is unaffected by
restarts. Keep that exact tunnel process alive; a new URL would force a
re-registration and a new agent identifier.

**D2 — CRITICAL: the operator API is public through the tunnel.** `/api/*`
trusts loopback callers, and ngrok delivers every request *from* loopback —
so the trust check passes for the whole internet. Anyone with the URL can
read all jobs/messages and `POST /api/approvals/:id/decide` — i.e. approve
spending. **Fix (already on main):** set `DASHBOARD_REQUIRE_TOKEN=true` in the
agent's environment after updating (D1), then mint a token from the host:
`curl -s -X POST localhost:8787/api/tokens -H 'content-type: application/json' -d '{"name":"operator"}'`
and use its `secret` as a Bearer token for operator calls. The agent-facing
surfaces (MIP-003, x402, bounty `/w/` pages) are public by design and
unaffected. Until the restart, treat the URL as sensitive.

**D3 — minor:** the x402 offer's resource URL says `http://` — set
`PUBLIC_URL=https://b50e-158-140-149-130.ngrok-free.app` (with the scheme) in
the agent env so payment offers carry the https URL.

**D4 — not remotely verifiable:** Telegram. The operator should confirm the
boot log shows `[telegram] polling as @<bot>` and **no** `HEADLESS MODE`
warning, then run one hirer flow and one worker `/claim` from phones.

## Re-test checklist after the restart

1. Probe 7 returns `{"error":"invalid JSON body"}` (proves new code).
2. Probe 9 returns 401 without a token (proves D2 closed).
3. Probe 5 still returns payment terms (MPS env survived the restart).
4. x402 resource URL is https (D3).
5. A real paid purchase (`pnpm spike:masumi` from a funded buyer wallet), then
   the ~60 min collection tx — the submission artifact.
