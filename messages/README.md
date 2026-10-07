# messages/ — the iMessage bridge and public agent line

Anyone who texts the Mac's iMessage number talks to the HAAS agent. The
operator gets shortlists, approvals, escrow links and results; the public
gets registered, asked one clarifying question, and then served — each
person sees only their own requests.

The TS core stays the single brain and source of truth. This bridge is a thin
client of its REST + SSE API (`src/api/dashboard.ts`).

## Public line — anyone can text the agent

1. **Unknown sender texts in** → the agent stashes their request and asks
   their name (registration, stored in the bridge's own SQLite DB).
2. **One clarifying question** — budget, deadline, location (or `SKIP`).
3. **A job is created in the core**, tagged `imessage:<handle>`. The core
   tries **Masumi AI agents first** (`AI_DELEGATION=auto`: classify the brief,
   hire an AI agent if one fits) and falls back to **hiring humans** across
   every freelancer source.
4. **Notifications are routed per requester**: each person is texted their own
   shortlist (`HIRE 1`, `REFINE …`, `CANCEL`, `STATUS`), escrow and result
   updates. **Approvals and anything unattributable always go to the
   operator** — spending stays the owner's call.

Owner vs public: the handle in `IMESSAGE_RECIPIENT` is the operator and keeps
the full command set (`YES`/`NO` on approvals included). Every other handle
gets the public flow above and can never see or decide approvals.

### Storage

`store.py` (`UserStore`) holds users, job ownership and booking→job lookups
in SQLite at `BRIDGE_DB` (default `messages/bridge.db`). It is deliberately
five methods wide: a Supabase-backed drop-in (same methods via `supabase-py`,
`SUPABASE_URL`/`SUPABASE_KEY`) replaces it without touching the rest.

### The agent's own phone number

The agent runs on its **own dedicated number via Twilio** (`CHANNEL=twilio`),
so nobody's personal identity is involved. `TwilioChannel` sends through the
Messages REST API and **polls** for inbound — no webhook, tunnel or public URL
needed. Setup:

1. Sign up at twilio.com — the free trial includes ~$15 credit and a real
   number. Trial caveats: outbound only reaches numbers you verify in the
   console first (verify the demo phones), and bodies carry a trial prefix;
   a paid upgrade removes both.
2. Put `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (the new
   number) and `OWNER_PHONE` (your mobile — approvals go there) in the
   environment. Never commit them.
3. `CHANNEL=twilio python client.py`

Free alternatives: `CHANNEL=imessage` serves everyone who texts the Mac's
iMessage identity (operator = `IMESSAGE_RECIPIENT`), and the core's Telegram
bot (`src/channels/telegram.ts`) is live once `TELEGRAM_BOT_TOKEN` is set —
free with no phone number at all.

## Classes

| File | Class | Job |
|---|---|---|
| `models.py` | `Event`, `Notification`, `Inbound` | the three messages passed around (Inbound knows its sender) |
| `haas.py` | `HaasClient` | the only code that knows the API routes |
| `events.py` | `EventStream` | SSE connection: reconnects, resumes from last seq |
| `channels.py` | `Channel`, `TwilioChannel`, `IMessageChannel`, `ConsoleChannel` | transport: send to a recipient, poll everyone's replies |
| `store.py` | `UserStore` | who texted us, whose job is whose (SQLite; Supabase seam) |
| `notifier.py` | `Notifier` | policy: which events buzz a phone, and how they read |
| `conversation.py` | `Conversation` | per-sender brain: registration → clarify → job; owner commands |
| `bridge.py` | `Bridge` | composition root; routes each notification to the right person |
| `client.py` | — | entry point |

## Run

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# the TS core must be running (pnpm start in the repo root, port 8787)
python client.py --console          # try it in the terminal first

export IMESSAGE_RECIPIENT="+14155551234"   # the OPERATOR's handle
python client.py                    # the real thing: all senders served
```

In console mode, type `+1555: hello` to speak as a member of the public and
bare text to speak as `console-user`; the operator is `console-owner`.

Optional env: `HAAS_URL` (default `http://localhost:8787`), `HAAS_TOKEN`
(mint via `POST /api/tokens` if the API is exposed beyond localhost),
`IMESSAGE_VERBOSE=true` for per-step progress texts, `BRIDGE_DB` for the
user registry path.

## macOS setup

- **Full Disk Access** for your terminal (reads `~/Library/Messages/chat.db`).
- Approve the **Automation** prompt for Messages on the first send.
- **The operator should text from a second handle** (another phone / Apple
  ID), not from the Mac's own Apple ID: in a self-conversation every message
  has `is_from_me = 1` and the inbound filter would drop your commands. If you
  must self-text, remove `m.is_from_me = 0` from the query in `channels.py`
  and skip texts that start with the bridge's own emoji prefixes, or it will
  answer itself forever.
