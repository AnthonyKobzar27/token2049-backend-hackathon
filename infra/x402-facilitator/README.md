# x402 facilitator for Cardano Preprod

There is no hosted Cardano facilitator, so HAAS runs its own. It verifies the payer's signed
transaction, broadcasts it, and waits for the confirmation policy. It holds no keys and pays no
fees; the payer funds the transaction. Based on `cardano-foundation/x402-cardano-demo/facilitator`
(demo pins `@x402/*` 2.26.0; this folder pins 2.28.0, the version the HAAS repo uses, same API).

## Run

```sh
cd infra/x402-facilitator
pnpm install --ignore-workspace      # or: npm install   (own dependencies, separate from the repo root)
cp .env.example .env                  # then set BLOCKFROST_PROJECT_ID
pnpm start                            # listens on http://127.0.0.1:4022
curl localhost:4022/supported         # must list scheme "exact" on "cardano:preprod"
curl localhost:4022/health
```

Then in `~/.haas/.env` for HAAS:

```
X402_PAY_TO=<preprod address that receives the payments, addr_test1...>
X402_FACILITATOR_URL=http://localhost:4022
X402_NETWORK=cardano:preprod
X402_PRICE_LOVELACE=2000000
```

The HAAS server asks `/supported` the first time someone calls `POST /x402/route`; if the
facilitator is down that call fails with 502 (no 402 challenge can be built without it).

## Env vars (this folder's `.env`)

| Variable | Default | Meaning |
|---|---|---|
| `BLOCKFROST_PROJECT_ID` | required | Blockfrost project id for Cardano **Preprod** |
| `BLOCKFROST_BASE_URL` | `https://cardano-preprod.blockfrost.io/api/v0` | Blockfrost endpoint |
| `PORT` | `4022` | Listen port (bound to 127.0.0.1) |
| `ACCEPT_MEMPOOL` | `false` | Allow confirmation level -1 (own broadcast accepted; can be rolled back) |
| `CONFIRMATION_TIMEOUT_MS` | `75000` | Wait per `/settle`; core retries once, so keep it below the HAAS client timeout (120000) |

## Behaviour to know

- HAAS asks for confirmation level `0` (the payment is in a block): the paid request's response is
  held until then, about 20 s on average, up to about 150 s worst case (two 75 s waits).
- The facilitator advertises levels 0 to 20 (and -1 only with `ACCEPT_MEMPOOL=true`).
- Settlement state is in memory: restarting while a payment is pending loses the retry guard.
- The payer needs preprod tADA from https://docs.cardano.org/cardano-testnets/tools/faucet/ ; the
  facilitator needs no funds.
- Test with `pnpm spike:x402` from the repo root (needs `X402_CLIENT_MNEMONIC` and the same
  `BLOCKFROST_PROJECT_ID` in `~/.haas/.env`).
