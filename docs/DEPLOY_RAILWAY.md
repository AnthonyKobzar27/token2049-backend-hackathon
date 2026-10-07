# Deploying the HAAS core to Railway

The repo-root `Dockerfile` builds the TypeScript backend only (no frontend, no
iMessage bridge) on node:22-slim, with Python/uv and the Fiverr MCP server
pre-installed. `railway.json` points Railway at it and sets the health check
(`/health`) and the on-failure restart policy.

## Backend (Railway)

1. **Create the service.** Railway dashboard > New Project > Deploy from GitHub
   repo > pick this repo. Railway reads `railway.json`, builds the Dockerfile
   and health-checks `/health`.
2. **Attach a volume at `/data`.** Service > Settings > Volumes > Add Volume,
   mount path `/data`. The image sets `DB_PATH=/data/haas.db` (and
   `HAAS_HOME=/data`); without the volume the SQLite database is lost on every
   deploy. The server creates the file and parent directory itself.
3. **Keep the service always on.** Settings > Deploy > **App Sleeping /
   Serverless must be OFF**. HAAS runs pollers (jobs, bookings, bounties,
   Masumi, Telegram long-polling) that stop working if the instance sleeps.
4. **Generate a domain** (Settings > Networking > Generate Domain). `PUBLIC_URL`
   defaults to `https://$RAILWAY_PUBLIC_DOMAIN` automatically; set it explicitly
   only if you use a custom domain.
5. **Set environment variables** (Variables tab). Minimum useful set:

   | Variable | Why |
   | --- | --- |
   | `SOURCES` | Comma-separated sources to enable (e.g. `rentahuman,freelancer,fiverr`; `fake` for demos). Unset = every configured source. |
   | `ANTHROPIC_API_KEY` | Optional; intake conversation, extraction and QA scoring degrade to heuristics without it. |
   | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OPERATOR_ID` | Optional; approvals and operator alerts over Telegram. |
   | `MASUMI_API_URL`, `MASUMI_API_KEY`, `MASUMI_AGENT_IDENTIFIER`, `MASUMI_SELLER_VKEY` | Optional; unset `MASUMI_API_KEY` means MIP-003 jobs start without payment. The default `MASUMI_API_URL` is `http://localhost:3001/...`, so set it when payments are on. |
   | `DASHBOARD_ORIGINS` | The Vercel dashboard origin(s), see below. |
   | Source keys as desired | `RENTAHUMAN_API_KEY`, `FREELANCER_SANDBOX_TOKEN` / `FREELANCER_TOKEN`, `SERPER_API_KEY`, `UPWORK_*`, `PROLIFIC_*`, ... |

   No `.env` file is needed: Railway injects plain env vars and `src/config.ts`
   only loads `~/.haas/.env` when it exists. Browser-read sources and browser
   contact are already off in the image (`BROWSER_SOURCES=false`,
   `BROWSER_CONTACT=false`) because a server has no operator Chrome.
6. **Deploy** and check `https://<domain>/health` returns
   `{"ok":true,"sources":[...]}`.

## Frontend (Vercel) pointing at Railway

1. Deploy `frontend/` to Vercel (root directory `frontend`).
2. In Vercel, set `NEXT_PUBLIC_API_URL=https://<your-railway-domain>` (no
   trailing slash; it is prefixed directly onto `/api/...` paths).
3. In Railway, set `DASHBOARD_ORIGINS=https://<your-vercel-app>.vercel.app`.
   This must match the browser `Origin` header **exactly** (scheme + host, no
   trailing slash, no path); several origins are comma-separated, e.g. preview
   deployments: `https://haas.vercel.app,https://haas-git-main-you.vercel.app`.

   Why it matters: `src/api/dashboard.ts` rejects any browser request whose
   `Origin` is neither localhost nor in `DASHBOARD_ORIGINS` with 403, and an
   allow-listed origin also stands in for a Bearer token (the dashboard's
   `fetch`/`EventSource` send none, and on a PaaS requests never arrive from
   loopback). Non-browser clients (agents, curl from another machine) still
   need a Bearer token: `POST /api/tokens`.

## Notes

- `restartPolicyType: ON_FAILURE` in `railway.json` restarts crashed deploys;
  SIGTERM is handled in `src/index.ts`, so redeploys shut down cleanly.
- The server listens on `PORT` (image default 8787); Railway routes to it via
  the Dockerfile `EXPOSE`. Overriding `PORT` is fine.
- Logs on boot print the enabled sources, escrow provider and payment wiring —
  the quickest way to verify the env vars took effect.

## ⚠️ Do not deploy headless

Without `TELEGRAM_BOT_TOKEN` + `TELEGRAM_OPERATOR_ID` (or `MANUAL_APPROVALS=true`)
the approval gate auto-grants **everything** — bookings, freelancer outreach
messages, escrow releases. That is rehearsal behavior. A public deployment MUST
set one of the two, or the agent will spend and message on its own. The boot
log prints a HEADLESS MODE warning when this is the case; if you see it on
Railway, stop and fix the variables.

Also set `PUBLIC_URL=https://<your-railway-domain>` — x402 payment offers and
status links, Solana Pay QRs, and bounty worker links all embed it.
