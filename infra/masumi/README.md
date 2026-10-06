# Masumi Payment Service for HAAS (Cardano Preprod)

Runs `ghcr.io/masumi-network/masumi-payment-service:0.29.0` and Postgres. Polling intervals are 15-30 s and
`BLOCK_CONFIRMATIONS_THRESHOLD` is 1 (service defaults: 3-5 min, 20), so a payment is seen within about a minute.

Set up for the TOKEN2049 agent guide:

- `AUTO_WITHDRAW_PAYMENTS=true`: after `unlockTime` the service collects the escrow for the seller by itself.
- `COLLECTION_WALLET_V2_PREPROD_ADDRESS` is not set at all (an empty string is not the same as unset).
- The seed output is discarded, because it can print wallet mnemonics. Read public addresses in the admin UI.

Not exercised here: Docker was not available when this was written. Expect to fix small things on first start.
If Docker fails, use the guide's local install instead (`docs/LIVE_CARDANO_PAYMENT.md` section 5, option B).

The service must run from the paid Task until the collection transaction is confirmed. A sleeping laptop breaks it.

## 1. Keys and env

```bash
cd infra/masumi
cp .env.example .env
# ENCRYPTION_KEY=$(openssl rand -hex 24)   never change it after the first start
# ADMIN_KEY=$(openssl rand -hex 24)        32+ characters
# BLOCKFROST_API_KEY_PREPROD: a Preprod project at https://blockfrost.io
```

## 2. Start

```bash
docker compose up -d
docker compose logs -f payment-service     # wait for the server to listen on 3001
curl http://localhost:3001/api/v1/health   # {"status":"success","data":{"status":"ok"}}
curl http://localhost:3001/api-docs -o mps-openapi.json
```

The first start migrates and seeds the database: a Web3CardanoV2 Preprod payment source, a purchasing wallet and a
selling wallet. Blank mnemonics are generated and stored encrypted with `ENCRYPTION_KEY`.

## 3. Admin UI and wallets

Open http://localhost:3001/admin/ and sign in with `ADMIN_KEY` yourself (not through a coding agent).

1. Check there is one **Web3CardanoV2 Preprod** payment source, one Selling and one Purchasing wallet.
2. Selling wallet: `collectionAddress` must be `null`. If it is `""`, set it to null with the wallet update API
   (`newCollectionAddress: null`) and request fresh payment terms afterwards. Do not reseed.
3. Fund the selling wallet with test ADA from https://dispenser.masumi.network (it also sends the separate **5 ADA
   collateral**, which can take a few minutes) or the Preprod faucet. It pays the registry mint, submit-result and
   collection fees. Check the real balance; do not assume a figure.
4. The purchasing wallet only needs ADA and test USDM for `pnpm spike:masumi` (our own buyer). Sokosumi Tasks are
   paid by Sokosumi Core from Workspace credits.

## 4. API key

Admin UI > API Keys > a key with **Read and Pay** (not Admin), Preprod only. Or:

```bash
curl -s http://localhost:3001/api/v1/api-key -H "token: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"canRead":true,"canPay":true,"canAdmin":false,"usageLimited":"false","UsageCredits":[]}'
```

0.29.0 may name the permission differently; check `mps-openapi.json` for `POST /api-key`. Use the returned
`data.token` as `MASUMI_API_KEY`. It is not the Sokosumi Coworker key.

## 5. Register the agent

The registry needs the final public HTTPS URL of the HAAS API (Railway), not a quick tunnel: a tunnel URL changes on
every restart and breaks the entry.

```bash
# ~/.haas/.env: PUBLIC_URL=https://<haas>  MASUMI_API_URL=http://localhost:3001/api/v1  MASUMI_API_KEY=<step 4>
pnpm register:agent --dry-run   # shows the request body
pnpm register:agent
```

The entry uses `{"pricingType":"Dynamic"}`; each payment request quotes 1 test USDM (`MASUMI_PRICE_AMOUNT=1000000`
of unit `16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d`). The script waits for the mint
(3-15 min) and prints the agent identifier, policy id, contract address, seller vkey and the `.env` lines.
`RegistrationFailed` almost always means the selling wallet has no ADA or no collateral yet.

## 6. Values for `~/.haas/.env`

```
PUBLIC_URL=https://<haas>
MASUMI_API_URL=http://localhost:3001/api/v1
MASUMI_API_KEY=<step 4>
MASUMI_NETWORK=Preprod
MASUMI_AGENT_IDENTIFIER=<printed by register-agent>
MASUMI_SELLER_VKEY=<printed by register-agent>
MASUMI_PRICING_TYPE=Dynamic
MASUMI_SUPPORTED_PAYMENT_SOURCE_INDEX=0
MASUMI_SMART_CONTRACT_ADDRESS=<printed by register-agent>

# Sokosumi Coworker worker (docs/LIVE_CARDANO_PAYMENT.md section 4)
SOKOSUMI_COWORKER_ID=<coworker id>
SOKOSUMI_COWORKER_API_KEY=<coworker_* runtime key>
SOKOSUMI_PAID_TASKS=true
```

Without `MASUMI_API_KEY` and `MASUMI_AGENT_IDENTIFIER` HAAS starts jobs unpaid. Check the worker with
`pnpm sokosumi:worker --check`.

Payment deadlines: MIP-003 jobs default to pay 20 min, result 90 min, unlock +16, dispute +16
(`MASUMI_*_WINDOW_MIN`, `MASUMI_*_DELAY_MIN`); Sokosumi Tasks to 15 / 25 / +16 / +16 (`SOKOSUMI_*`), so collection
lands about 45 min after a Task starts, plus the service's collection poll.

## Reset

`docker compose down -v` deletes the database, including the wallets. Export or keep the mnemonics first.
