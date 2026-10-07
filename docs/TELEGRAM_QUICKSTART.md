# Telegram quickstart

One page for the demo pivot: run HAAS through Telegram instead of headless. Five minutes of setup.

## 1. Create the bot and get your id

1. Message **@BotFather** on Telegram, send `/newbot`, pick a name and a username. It replies with the **bot token**.
2. Message **@userinfobot** from your own account. It replies with your **numeric user id**.

## 2. Configure and restart

Add both to `~/.haas/.env` (the file HAAS loads on start; `HAAS_HOME` moves it):

```
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_OPERATOR_ID=<your numeric id>
```

Restart `pnpm start`. The boot log shows `[telegram] polling as @<your bot>`. If you see `[telegram] Telegram disabled (TELEGRAM_BOT_TOKEN not set)` instead, the env file was not picked up.

Set **both** values. With the token but no `TELEGRAM_OPERATOR_ID`, approval requests have nowhere to go and bookings sit waiting.

## 3. Hirer flow

1. Open a chat with your bot and send the task as **plain text** ("Find someone to call the Tanjong Pagar clinic and book a slot tomorrow").
2. With `ANTHROPIC_API_KEY` set, the bot asks short **clarifying questions** (budget, deadline, on-site location) before it searches; answer in plain text. Without the key it builds the brief from what you wrote.
3. The **shortlist** arrives as one card per candidate with a `Choose <name>` button. Pick one, or describe what to change and it searches again.
4. Anything that needs the operator (book, accept a delivery) lands in the operator chat as **Approve / Deny buttons**.

## 4. Worker flow

1. `pnpm seed:workers` registers the demo pool and prints each worker's link code (`send /link <code> to the bot`).
2. Each worker messages the bot:
   - `/link <code>` — connect this chat to the registered worker
   - `/tasks` — list tasks offered to me
   - `/claim <code>` — claim a task (first claim wins)
   - `/submit <code> key=value … | notes` — deliver the result
   - `/ask <code> <text>` — ask the client a question

## Warning: no token means auto-approve

Without `TELEGRAM_BOT_TOKEN` (and with `TELEGRAM_OPERATOR_ID` and `MANUAL_APPROVALS` unset) the approval gate runs **headless**: every approval — booking, acceptance, payment release — is **granted automatically** and logged as `[approvals] headless: auto-approving …`. Fine for rehearsals; say so out loud if you demo that way.
