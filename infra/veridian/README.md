# KERIA for HAAS Veridian credentials

KERIA is the KERI agent server from the Veridian / WebOfTrust stack. HAAS's issuer identifier (AID) lives in a KERIA agent. HAAS drives that agent with signify-ts and keeps the keys client-side, derived from `VERIDIAN_PASSCODE`. The worker's Veridian wallet has its own agent, either the hosted Veridian one or another KERIA.

This folder runs upstream `weboftrust/keria:0.4.0`, which pairs with `signify-ts@0.4.0` in `package.json`. It adds one thing: an entrypoint that writes the agency config file from env vars. KERIA 0.4 does not build agent OOBIs from `KERIA_CURLS` alone; `/identifiers/{name}/oobis?role=agent` came back empty until a config file set `curls`.

Verified on 2026-10-06 with Docker 29 on Linux. The full flow ran against this compose file: `pnpm veridian:demo`, plus HAAS with `pnpm veridian:wallet`.

## Ports

| Port | Name  | Who connects                                          | Exposure                                                        |
|------|-------|-------------------------------------------------------|-----------------------------------------------------------------|
| 3901 | admin | Signify clients (HAAS)                                | Private. Every request is signed, but keep it off the internet. |
| 3902 | http  | Other agents and wallets: OOBIs, KERI messages, IPEX  | **Public.** Wallets must be able to reach it.                   |
| 3903 | boot  | Creates agents (HAAS boots its agent once)            | Private. Anyone who reaches it can create agents.               |

## Local

```bash
cd infra/veridian
docker compose up -d --build
curl http://localhost:3903/health      # {"message": "Health is okay. ..."}
```

Environment (all optional):

- `KERIA_PUBLIC_URL`, default `http://127.0.0.1:3902/`. The URL that goes into the OOBIs HAAS hands out. To test with the Veridian app on a phone, set it to your LAN IP (`http://192.168.x.y:3902/`) or a tunnel URL.
- `KERIA_IURLS` / `KERIA_DURLS`: `;`-separated introduction and data OOBIs that every agent resolves at start.
- `KERIA_LOG_LEVEL`, default `INFO`.

HAAS serves the credential schema at `GET /oobi/{schemaSaid}`. KERIA resolves it during issuer init, which is why the compose file maps `host.docker.internal` to the host. In HAAS's `.env`:

```bash
VERIDIAN_KERIA_URL=http://127.0.0.1:3901
VERIDIAN_KERIA_BOOT_URL=http://127.0.0.1:3903
VERIDIAN_PASSCODE=...                                   # 21+ chars: pnpm tsx -e "import('signify-ts').then(async s=>{await s.ready();console.log(s.randomPasscode())})"
VERIDIAN_OOBI_BASE_URL=http://host.docker.internal:8787 # how KERIA (in Docker) reaches HAAS
```

Data lives in the `keria-data` volume. If you delete the volume while keeping the same passcode, HAAS boots a fresh agent and creates a new issuer AID. Credentials issued before that can no longer be verified against a registry this agent holds.

## Railway

Deploy this folder as its own service (root directory `infra/veridian`; Railway builds the Dockerfile):

1. Add a volume mounted at `/usr/local/var/keri`.
2. Give the service a public domain that targets port **3902**. Set `KERIA_PUBLIC_URL=https://<that domain>/`.
3. Leave 3901 and 3903 on private networking. In the HAAS service, set:
   - `VERIDIAN_KERIA_URL=http://<keria service>.railway.internal:3901`
   - `VERIDIAN_KERIA_BOOT_URL=http://<keria service>.railway.internal:3903`
   - `VERIDIAN_OOBI_BASE_URL=https://<haas public domain>`
   - `VERIDIAN_ADMIN_TOKEN=<random>`

Not verified: the Railway deploy itself. Railway's private network has been IPv6-only. If HAAS cannot reach KERIA on `.railway.internal`, fall back to TCP proxies for 3901 and 3903, protected by a long passcode and an unguessable proxy port, and treat that as a demo-only setup.

## Witnesses

The default compose file runs no witnesses. HAAS's issuer AID is then a non-witnessed (`toad 0`) identifier, which is fine for a demo. HAAS can take witnesses through `VERIDIAN_WITNESS_OOBIS` / `VERIDIAN_WITNESS_AIDS`, and that path is covered by mocked tests only.

The live attempt failed: KERIA 0.4.0 with `weboftrust/keri:1.2.13` `kli witness demo`, on both bridge and host networking, with witness OOBIs resolved per agent and through `KERIA_IURLS`. Inception never collected receipts, and KERIA logged `unable to query witness …, no http endpoint`. Use the Veridian sandbox witnesses, or debug this before relying on witnesses.
