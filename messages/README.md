# messages/ — the iMessage bridge

Talk to your HAAS agent over iMessage: it texts you shortlists, approval
requests, escrow links and results; you text back tasks, `HIRE 2`, `YES`,
`REFINE cheaper please`, `STATUS`.

The TS core stays the single brain and source of truth. This bridge is a thin
client of its REST + SSE API (`src/api/dashboard.ts`).

## Classes

| File | Class | Job |
|---|---|---|
| `models.py` | `Event`, `Notification`, `Inbound` | the three messages passed around |
| `haas.py` | `HaasClient` | the only code that knows the API routes |
| `events.py` | `EventStream` | SSE connection: reconnects, resumes from last seq |
| `channels.py` | `Channel`, `IMessageChannel`, `ConsoleChannel` | transport: send text, poll replies |
| `notifier.py` | `Notifier` | policy: which events buzz the phone, and how they read |
| `conversation.py` | `Conversation` | inbound brain: text → intent → API call → reply |
| `bridge.py` | `Bridge` | composition root; the only loops/threads |
| `client.py` | — | entry point |

## Run

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# the TS core must be running (pnpm start in the repo root, port 8787)
python client.py --console          # try it in the terminal first

export IMESSAGE_RECIPIENT="+14155551234"   # the handle you text from
python client.py                    # the real thing
```

Optional env: `HAAS_URL` (default `http://localhost:8787`), `HAAS_TOKEN`
(mint via `POST /api/tokens` if the API is exposed beyond localhost).

## macOS setup

- **Full Disk Access** for your terminal (reads `~/Library/Messages/chat.db`).
- Approve the **Automation** prompt for Messages on the first send.
- **Text from a second handle** (another phone / Apple ID), not from the Mac's
  own Apple ID: in a self-conversation every message has `is_from_me = 1` and
  the inbound filter would drop your commands. If you must self-text, remove
  `m.is_from_me = 0` from the query in `channels.py` and skip texts that start
  with the bridge's own emoji prefixes, or it will answer itself forever.
