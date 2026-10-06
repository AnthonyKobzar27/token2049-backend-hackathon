# Masumi Payment Service for HAAS (Cardano Preprod)

Runs `ghcr.io/masumi-network/masumi-payment-service:0.29.0` and Postgres. Polling intervals are 15-30 s and
`BLOCK_CONFIRMATIONS_THRESHOLD` is 1 (service defaults: 3-5 min, 20), so a payment is seen within about a minute.

Not exercised here: Docker was not available when this was written. Expect to fix small things on first start.

## 1. Keys and env

```bash
cd infra/masumi
cp .env.example .env
# ENCRYPTION_KEY=$(openssl rand -hex 24)   ADMIN_KEY=$(openssl rand -hex 16)   (paste into .env)
# BLOCKFROST_API_KEY_PREPROD: create a Preprod project at https://blockfrost.io
```

## 2. Start

```bash
docker compose up -d
docker compose logs -f payment-service     # wait for the server to listen on 3001
curl http://localhost:3001/api/v1/health   # {"status":"success","data":{"status":"ok"}}
```

The first start migrates and seeds the database (admin key, a Web3CardanoV2 Preprod payment source, a purchasing
wallet and a selling wallet). If you left the mnemonics blank they are generated and printed once: copy them
from `docker compose logs payment-service` (or export them from the admin UI) and store them safely.

## 3. Admin UI and wallets

Open http://localhost:3001/admin/ and sign in with `ADMIN_KEY`. Under Wallets find the Selling and Purchasing
wallet addresses. Fund both from the Preprod faucet (https://docs.cardano.org/cardano-testnets/tools/faucet/,
network Preprod): the selling wallet needs about 20 tADA (registry mint and fees), the purchasing wallet about 50 tADA
(it pays the job fee in the spike).

## 4. API key

Admin UI > API Keys > create a key with Read and Pay (not Admin). Or:

```bash
curl -s http://localhost:3001/api/v1/api-key -H "token: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"canRead":true,"canPay":true,"canAdmin":false,"usageLimited":"false","UsageCredits":[]}'
```

Use the returned `data.token` as `MASUMI_API_KEY`.

## 5. Register the agent

The registry needs a public HTTPS URL for the agent API (the Masumi network and marketplaces call
`/start_job` on it). Expose HAAS, for example `cloudflared tunnel --url http://localhost:8787` or
`ngrok http 8787`, and put that URL in `PUBLIC_URL`.

```bash
# ~/.haas/.env needs at least: PUBLIC_URL=https://<tunnel>  MASUMI_API_KEY=<from step 4>
pnpm register:agent
```

The script registers the agent, waits until the mint is confirmed (several minutes on Preprod) and prints the
values to paste. Set `REGISTER_PRICE_LOVELACE` (default 3000000 = 3 ADA) to change the job fee.

## 6. Values for `~/.haas/.env`

```
PUBLIC_URL=https://<tunnel>
MASUMI_API_URL=http://localhost:3001/api/v1
MASUMI_API_KEY=<step 4>
MASUMI_NETWORK=Preprod
MASUMI_AGENT_IDENTIFIER=<printed by register-agent>
MASUMI_SELLER_VKEY=<printed by register-agent>
```

Without `MASUMI_API_KEY` and `MASUMI_AGENT_IDENTIFIER` HAAS starts jobs unpaid. Then restart HAAS and run
`pnpm spike:masumi` for a full paid job.

## Reset

`docker compose down -v` deletes the database, including the wallets. Keep the mnemonics.
