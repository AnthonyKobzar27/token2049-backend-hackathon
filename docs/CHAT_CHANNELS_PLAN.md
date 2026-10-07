# Chat channels plan: Telegram and iMessage

A plan for the teammates who own the Telegram bot and the iMessage front end. Nothing here is built yet unless it says "today". Line numbers are as of commit `70df036`.

## Summary

- **Telegram stays the primary channel.** It already runs the hirer flow, the operator approvals and the worker commands, and it has buttons, message edits and photos.
- **iMessage is added as a second transport for the same controller,** not as a second bot. It runs on the operator's Mac through the `imsg` CLI (`imsg rpc`, JSON-RPC over stdio). Cost is zero.
- **iMessage has no buttons.** Every button becomes a numbered or keyword reply ("1", "YES A7", "CLAIM UH8X").
- **On stage:** Telegram for the hirer and the operator. iMessage for the worker, who gets the bounty offer as a text and claims it by replying. Hirer-on-iMessage is a stretch goal.
- **Top gaps today:** the hirer never approves the release (only the operator does), there is no tappable Solana Pay link next to the QR, release and refund messages lack amounts and payees, Cardano reputation receipts never reach any chat, and the approval gate only knows about Telegram.

## 1. Roles and channels

| Role | Who | Channel today | Channel in this plan | Why |
|---|---|---|---|---|
| Hirer | A person who wants a human hired | Telegram chat (`job.client === 'telegram'`, `clientRef` = chat id) | Telegram, or iMessage (new `JobClient` value `'imessage'`) | Telegram has buttons and QR photos. iMessage needs no app install for an iPhone user. |
| Hirer (agent) | A Masumi agent, Sokosumi Coworker or x402 caller | MIP-003 `/status`, no chat | No change | Agents poll the API. They get no chat messages. Their approvals still go to the operator. |
| Operator | The HAAS owner who approves binding actions | Telegram user `TELEGRAM_OPERATOR_ID` (`src/config.ts:32-34`) | Telegram (primary), iMessage handle `IMESSAGE_OPERATOR` (fallback) | Approvals must reach one person reliably. Telegram buttons make this one tap. |
| Worker | A verified local bounty worker | Telegram slash commands (`src/bounty/telegram.ts`) and the `/w/<token>` page (`src/bounty/web.ts`) | iMessage text (offer and claim), `/w/<token>` page (submit), Telegram as before | Workers should not need an app. A text with a link is the lowest bar. The page handles the structured result form. |
| Platform freelancer | Someone on Freelancer.com, Upwork, etc. | The platform's own messages, via the liaison (`src/agent/liaison.ts`) | No change | The platform owns that channel. The operator sees a mirror in Telegram. |

## 2. How the code works today

### 2.1 Telegram controller and transport

- `src/channels/telegram.ts:31-37` defines `TgApi`: `send(chat, text, buttons?)`, `edit`, `photo`, `answer`, `clearKeyboard`. The real one wraps grammY (`:431-465`); tests fake it (`src/channels/telegram.test.ts:26`).
- `createController(deps, api)` (`:64-403`) holds all behaviour and never imports grammY. This is the seam iMessage reuses.
- Per-chat state lives in the kv store under `tg:state:<chat>` and intake history under `tg:intake:<chat>` (`:70-79`).
- A job belongs to a chat only when `job.client === 'telegram'` (`chatOf`, `:92`).
- All text is Telegram HTML built in `src/channels/format.ts` (`esc`, `<b>`, `<i>`, `<a href>`, `<code>`). Long text is split at 4096 chars (`chunk`, `:190`).
- Button payloads are short strings (`c:`, `r:`, `x:`, `a:`, `d:`, `p:`) built by `callbackData` and read by `parseCallback` (`format.ts:15-53`).

### 2.2 What the hirer bot does today

| Step | Code | What the hirer sees |
|---|---|---|
| `/start` | `telegram.ts:101-104` | The welcome text |
| Intake | `onText`, `:106-164`; `src/agent/intake.ts` (up to 2 clarifying questions, `MAX_ASK_ROUNDS`) | Questions, then "Got it." plus a summary, then "Searching now." Starts `jobs.startJob({ client: 'telegram', clientRef: chat })` (`:160`) |
| Progress | `job.progress` handler, `:297-300`; `progress()`, `:251-273` | One `⏳` message, edited at most every 1.5 s |
| Shortlist | `onShortlist`, `:275-293` | A header, one card per candidate with a `Choose <name>` button, then `Different options` / `Cancel` |
| Refine | callback `refine`, `:182-190`, then `awaiting_refine_feedback` in `onText`, `:109-121` | "What should be different?" |
| Escrow deposit | `escrow.updated` with `awaiting_deposit`, `:329-337` | A QR photo of `escrow.payUrl` and `escrowInstructions` (amount, devnet note, deadline) |
| Escrow change | `escrowLine`, `format.ts:152-156` | "Escrow funded / released to the freelancer side / refunded" with one explorer link |
| Escrow timeout | `escrowTimeoutLine`, `format.ts:146-150` | Deposit expired, or delivery expired and refunded |
| Booking change | `bookingStatusLine`, `format.ts:108-131` | One line per status change (deduped, `telegram.ts:314-322`) |
| QA result | `verification.completed`, `:376-379`; `verificationLine`, `format.ts:179-185` | Verdict, score, attempt, failed checks |
| Questions from the freelancer | `conversation.message` with `thread: 'hirer'`, `:349-358` | The question; the next text is relayed back (`relay_pending:` state, `:123-135`) |
| Result | `job.updated` completed or failed, `:304-312`; `jobResult`, `format.ts:97-106` | Summary, freelancer, price, booking link |

### 2.3 Operator commands and alerts today

- Approvals: every `approval.requested` goes to `TELEGRAM_OPERATOR_ID` with `Approve` / `Deny` buttons (`telegram.ts:370-374`). Only the operator may press them (`:197-203`).
- Commands: `/bookings`, `/accept <id>`, `/revise <id> <text>`, `/cancelbooking <id> <reason>` (`:220-243`, registered at `:471-476`).
- Mirrors: auto-replies to platform freelancers with a `Pause auto-replies` button, and the freelancer's own messages (`:360-367`).
- `operator.attention`, e.g. a browser challenge to solve (`:381-385`).

### 2.4 Event subscription

`createTelegram` subscribes the controller with `bus.on(c.onEvent)` (`telegram.ts:468`). `onEvent` never throws (`:397`). Events are defined in `src/domain/types.ts:528-550`.

Events Telegram ignores today: `source.done`, `approval.resolved`, `verification.started`, `verification.revision_requested`, `verification.rejected`, `bounty.updated` (`telegram.ts:386`, `default`).

### 2.5 Workers today

- Telegram worker commands: `/link`, `/tasks`, `/claim`, `/submit <code> key=value … | notes`, `/ask` (`src/bounty/telegram.ts:43-94`). They plug into the same bot as a `TelegramExtension` (`src/channels/telegram.ts:43-52`, registered in `src/index.ts:54`).
- Worker lookup is Telegram-only: `board.workerByTelegram(chatId)` and `board.linkTelegram` (`src/bounty/board.ts:148-158`).
- Notices go through `WorkerNotifier` (`src/bounty/notifier.ts:33-39`). The board calls `tell()` (`board.ts:227-234`) for `offer`, `claimed`, `taken`, `revision`, `paid`, `rejected`, `expired`, `cancelled`, `message` (`board.ts:284-415`).
- `createBountyModule` always builds console + Telegram notifiers and accepts extra ones through `deps.notifiers` (`src/bounty/index.ts:39`, `:47-48`). The file header already names iMessage as the next channel (`notifier.ts:1-2`).
- `Worker.contact.imessage` already exists, unused (`src/bounty/types.ts:18`). Seeding reads `WORKER_<ID>_TELEGRAM` (`src/bounty/seed.ts:65`).
- The `/w/<token>` page shows the task, a Claim button, the result form, a question box, and "Paid … on <chain>" (`web.ts:31-87`). It auto-refreshes while posted, submitted or verified (`:85`).

### 2.6 Approvals without Telegram

`src/approvals/gate.ts:14`: `headless = !TELEGRAM_OPERATOR_ID && !TELEGRAM_BOT_TOKEN`. When headless, every approval is granted at once (`:52-56`). Otherwise it waits up to `APPROVAL_TIMEOUT_MIN` (60) and then expires (`:58-62`). The policy auto-approves only routine messages, the one QA revision, and small releases under `AUTO_RELEASE_MAX_USD` (off by default) (`src/approvals/policy.ts:11-31`).

### 2.7 Wiring

`src/index.ts`: bounty module and extension `:52-54`; gate `:69`; `createTelegram(...)` `:89`; `telegram.start()` `:129`; `telegram.stop()` `:141`.

## 3. The flow, step by step, per channel

Telegram replies are buttons unless noted. iMessage replies are typed text. Keywords are case-insensitive. Every iMessage menu ends with a line such as `Reply 1, 2 or 3. MORE for other options. STOP to cancel.`

| # | Step | Hirer: Telegram | Hirer: iMessage | Operator | Worker (bounty) | Reply that moves the flow |
|---|---|---|---|---|---|---|
| 1 | Scope the brief | Free text, up to 2 questions, "Got it" summary (today) | Same text, plain. Summary as short lines | Nothing (new: one line "New job from <channel>: <task>" is optional) | Nothing | Telegram: any text. iMessage: any text. Typing `RESTART` clears intake |
| 2 | AI or human | One `⏳` message edited with "Checking whether an AI agent can do this…", "Trying an AI agent: X…" (today, from `src/delegate/delegate.ts:51-90`) | No edits in iMessage. Send only 2 milestones: "Checking if an AI agent can do this." and the outcome ("An AI agent is on it" / "This needs a person, searching") | Nothing | Nothing | None. On the AI path the flow jumps to step 10 |
| 3 | Open router | Same `⏳` message: per-source progress (today, `src/sources/registry.ts:188`) | One message when searching starts. No per-source messages | Nothing | Nothing | None |
| 4 | Check-in | Header plus one card per candidate with `Choose <name>`, then `Different options` / `Cancel` (today) | One message: numbered list, each with name, platform, price, rating, `✓ verified`, one-line reason, profile link | Nothing | Nothing | Telegram: tap `Choose`. iMessage: `1`..`N`, `MORE` (refine, then a free-text answer), `STOP` (cancel) |
| 5 | Lock the budget (Solana) | QR photo of the Solana Pay transaction request plus instructions (today). New: add the tapable `solana:` link and an https page link | QR image as an attachment (for scanning from a second device), the `solana:` link, the amount, the deadline, the devnet note | Approval `book`: "Book X on P for $N", with `Approve` / `Deny`. Comes after the deposit lands | Nothing yet | Hirer: sign in the wallet. HAAS sees the deposit and sends "Escrow funded. View transaction <Solana explorer link>". Operator: `Approve` or, on iMessage, `YES A7` / `NO A7 <reason>` |
| 6 | The human does it | "Booked. The freelancer has the order." or a handoff link (today). Freelancer questions relayed (today) | Same, plain. Relayed questions end with "Reply to answer." | Mirrors of auto-replies with `Pause auto-replies`; on iMessage `PAUSE <booking>` | Offer: "New task: Phone call, ~5 min, S$3 [UH8X]" plus the `/w/<token>` link. After claim: instructions and the submit format | Worker: Telegram `/claim UH8X` (new: a `Claim` button); iMessage `CLAIM UH8X` or tap the link. Submit on the page, or `/submit` / `SUBMIT UH8X date=… time=… reference=…` |
| 7 | Verify (AI QA) | QA line: verdict, score, failed checks (today). New: a revision notice and a rejection notice | Same, plain, max 3 failed checks | Approval `accept` with the QA summary ("QA passed: accept delivery and release $N"). `revise` approval when auto-revision is off | `revision`: "Please fix task UH8X: …" (today). `paid` or `rejected` later | New (hirer): `Release` / `Ask for a fix` buttons; iMessage `RELEASE` / `FIX <what>`. Today only the operator can answer the `accept` approval |
| 8 | Settle on Solana | New: "Released 25 USDC to <payee short>. Result hash ab12…. View transaction <link>" or "Refunded 25 USDC to your wallet. View transaction <link>" | Same text, plain, with the full explorer URL | Same notice, plus booking id | `paid`: "Thanks! Task UH8X accepted. 3 USDC is on its way to <address>." New: add the release transaction link | None. A refund after the deadline needs no reply |
| 9 | Reputation on Cardano | New: "Recorded on Cardano: <worker> now has N verified jobs. Receipt NFT: <cardanoscan token link>. Tx: <cardanoscan tx link>" | Same, plain | Same, one line | New: "Your HAAS record on Cardano was updated: N jobs, rating R. <link>" | None |
| 10 | Result to the caller | `jobResult`: summary, freelancer, price, booking link (today). New: the work result (e.g. "Booked: Thursday 3pm, ref 88213"), the verified result hash, and on the AI path the agent name and output | Same, plain. Long AI output is cut to ~1,500 chars with a link to the full result | Nothing | Nothing | None. Telegram may add a `Rate 1-5` row; iMessage `RATE 5` |

Notes on the Solana Pay step:

- `escrow.payUrl` is `solana:<PUBLIC_URL>/solana-pay/escrow/<bookingId>` (`src/payments/solana-pay.ts:2`). The wallet fetches that URL, so `PUBLIC_URL` must be a public HTTPS tunnel during the demo.
- A hirer on a phone cannot scan a QR on the same phone. Both channels must also send the `solana:` link as text. Phantom and Solflare open it when tapped on iOS. If iMessage does not make `solana:` tappable, add a small `GET /pay/<bookingId>` page with a button that links to it (core task C3).

## 4. Gaps in the Telegram integration

| # | Gap | Where | Change |
|---|---|---|---|
| G1 | The hirer never approves the release. `askRelease` says "the hirer sees the QA report and approves" (`src/engine/bookings.ts:333`), but every approval goes only to the operator (`telegram.ts:370-374`) and only the operator may press it (`:199`) | `telegram.ts:197-203`, `:370-374` | For `accept` and `revise` approvals with a `jobId` whose job has a chat, also send the approval to the hirer with `Release` / `Ask for a fix`. Accept the hirer's press when `chatOf(job) === chat`. Keep the operator's buttons too: first answer wins (`gate.resolve` ignores a second answer, `gate.ts:21-23`) |
| G2 | `Deny` carries no reason, so a denied release becomes a revision with the default text (`telegram.ts:200`; `bookings.ts:349-357`) | `telegram.ts:200` | After `Deny`, set state `deny_note:<approvalId>` and take the next text as `note` |
| G3 | No tappable payment link. `escrowInstructions` does not print `payUrl` (`format.ts:133-144`) | `format.ts:133-144` | Add the `solana:` link line, and the `/pay/<bookingId>` page link once C3 exists |
| G4 | Release and refund lines say nothing about amount, payee or result hash, and show only `explorerUrl` (`format.ts:152-156`). `EscrowRecord.txs[]` has one explorer URL per transaction (`types.ts:513`) and is unused | `format.ts:152-156` | Render amount, currency, short payee, short `resultHash`, and the URL of the latest `txs` entry of that kind. "Released to the freelancer side" becomes "Released 25 USDC to 7xKp…3f" |
| G5 | Cardano reputation receipts reach no chat. The minter only logs (`src/identity/minter.ts:244`); there is no event | `minter.ts:239-244`, `types.ts:528-550` | Core: add `{ type: 'reputation.recorded'; workerId; bookingId; jobId; txHash; receiptUnit?; jobsCompleted; avgRating? }` to `HaasEvent` and emit it after `registry.recordJob`. Telegram: render with `explorer(network).tx()` / `.token()` (`src/identity/cip68.ts:201-206`) |
| G6 | Revision and rejection are silent. `verification.revision_requested` and `verification.rejected` fall to `default` (`telegram.ts:386`). `in_revision` has no status text (`format.ts:108-120`) | `telegram.ts:376-386`, `format.ts:108` | Handle both events: "The work needs a fix: …" and "The work was rejected twice. Your deposit is being refunded." Add `in_revision` to `STATUS_TEXT` |
| G7 | The result hides most of the result. `jobResult` ignores `path`, `agent`, `output`, `work`, `verifiedResult` (`format.ts:97-106`; fields at `types.ts:265-288`) | `format.ts:97-106` | Lead with `work.summary` when present. Add "Verified result hash: ab12…". On the AI path add "Done by AI agent <name>" and the output (chunked) |
| G8 | Approvals from Masumi, Sokosumi and x402 jobs reach the operator without job context, and the operator gets no start or result notice for them | `telegram.ts:370-374`, `format.ts:158-163` | Add the client and the brief's task line to `approvalRequest`. Optional: a one-line operator feed for `job.updated` on non-chat jobs |
| G9 | Worker notices are fully escaped text with no buttons (`notifier.ts:69-70`), and `paid` has no transaction link (`board.ts:366`) | `notifier.ts:59-73`, `board.ts:360-367` | Telegram: add a `Claim UH8X` inline button to `offer`. Core: pass the release explorer URL into the `paid` text |
| G10 | Telegram names are hard-wired into shared logic: `job.client === 'telegram'` (`telegram.ts:92`, `:110`, `:160`), `tg:` kv keys (`:70-79`), the module-level extensions list (`:49`), and the gate's headless check (`gate.ts:14`) | listed | Parameterise by channel name (section 5). Gate: headless only when no channel has an operator |
| G11 | `job.progress` edits a message. That works on Telegram only | `telegram.ts:251-273` | Behind a capability flag: channels without `edit` get milestone messages only (section 5.3) |

## 5. iMessage architecture

### 5.1 Generalise the controller

Rename `TgApi` to `ChannelApi` and move it with the controller to `src/channels/controller.ts`. Keep a `TgApi` type alias so tests compile.

```ts
export interface ChannelCaps { buttons: boolean; edit: boolean; html: boolean; maxLen: number }
export interface ChannelApi {
  readonly name: 'telegram' | 'imessage';
  readonly caps: ChannelCaps;
  send(chat: string, text: string, buttons?: Button[][]): Promise<string | undefined>;
  photo(chat: string, png: Buffer, caption?: string): Promise<void>;
  edit?(chat: string, messageId: string, text: string): Promise<void>;
  answer?(callbackId: string, text?: string): Promise<void>;
  clearKeyboard?(chat: string, messageId: string): Promise<void>;
}
```

- `createController(deps, api)` uses `api.name` as the `JobClient` and the kv prefix (`telegram:` keeps `tg:` for existing data).
- `chatOf(job)` checks `job.client === api.name`.
- **Buttons without buttons.** When `!caps.buttons`, the controller does not drop the buttons. It numbers them, appends `Reply 1, 2 …` to the text, and saves a menu in kv: `<prefix>:menu:<chat>` = `{ "1": "c:sl_x:0", "2": "c:sl_x:1", "more": "r:job_y", "stop": "x:job_y" }`. `onText` checks the menu first and calls the existing `onCallback` with the saved data. One code path for both channels.
- **Approvals without buttons.** Approvals can be pending in parallel, so each gets a short code (`A7`), kept in kv `approval:code:A7` → approval id. The operator replies `YES A7` or `NO A7 reason`. With only one pending, a bare `YES` / `NO` works.
- **Operator commands.** Map `BOOKINGS`, `ACCEPT <id>`, `REVISE <id> <text>`, `CANCEL <id> <reason>`, `PAUSE <id>` onto `onOperatorCommand` (`telegram.ts:220`) when the sender is the iMessage operator.

### 5.2 Plain-text renderer for format.ts

Keep `format.ts` as the one source of wording. Add `toPlain(html)`:

- `<a href="u">t</a>` → `t: u` (iMessage previews links on its own).
- Drop `<b>`, `<i>`, `<code>` tags.
- Unescape `&lt; &gt; &amp; &quot;`.
- Strip the `⏳` emoji if the team prefers.

The transport applies it when `!caps.html`. Add `shortlistPlain(shortlist)` that builds the single numbered message for step 4 (cards one per message would be spammy in iMessage). Add tests next to `format.test.ts`.

### 5.3 Progress without edits

When `!caps.edit`, `progress()` (`telegram.ts:251-273`) sends at most 3 messages per job: the first one, the AI or human decision, and nothing more until the shortlist. Filter by prefix of the `delegate.ts` messages, or add an optional `milestone: true` flag on `job.progress` (core).

### 5.4 iMessage transport

`src/channels/imessage/transport.ts`, using `imsg rpc` (MIT, macOS 14+, Homebrew).

- Spawn `imsg rpc` as a child process. Speak JSON-RPC 2.0, one JSON object per line.
- On start: `initialize`, then `status` (fail fast and log if Full Disk Access is missing), then `watch.subscribe` with `since_rowid` from kv `im:rowid`.
- Inbound: the `message` notification. Skip messages from me. Dedupe by guid or rowid, then save the rowid. Route by sender handle (5.6).
- Outbound text: `send` with `to` = phone in E.164 or Apple ID email, `service: 'imessage'`, no SMS fallback. Split at ~1,500 chars.
- Outbound QR: write the PNG to the scratch directory, then `send.attachment` (or `send` with `file`).
- First contact: if a worker or hirer has never written, `chats.create` with `addresses` and `text`, after `handles.check`.
- Restart the child with backoff if it exits. Log every RPC error with the method name.
- `imsg` also exposes `poll.send`. Do not rely on it for the demo: it needs recent iOS and may need its bridge mode.

Fallback transport: `@photon-ai/imessage-kit` (MIT, Node 20+, needs Full Disk Access). `sdk.send({ to, text, attachments })` and `sdk.startWatching({ onDirectMessage })`. Same interface; pick with a config flag.

### 5.5 JobClient and types

- `src/domain/types.ts:200`: `JobClient` gains `'imessage'`. `clientRef` is the sender handle.
- Check every `switch` on `client` (`grep -rn "client ===" src`). The Masumi watcher and Sokosumi code only look for their own values, so this should be additive.

### 5.6 Inbound routing on one Apple ID

One iMessage account receives everything. Route each message by sender:

1. Sender is `IMESSAGE_OPERATOR`: approval code replies and operator keywords. Anything else falls through to the hirer flow, so the operator can test as a hirer.
2. Sender matches a worker's `contact.imessage`: worker keywords (`TASKS`, `CLAIM`, `SUBMIT`, `ASK`, `LINK`).
3. Sender is in `IMESSAGE_ALLOWLIST`, or the list is empty and `IMESSAGE_OPEN=true`: hirer controller `onText`.
4. Anyone else: ignore, log once. Without this, any stranger texting the demo Apple ID would start jobs.

### 5.7 Worker notifier and worker commands

- `createIMessageWorkerNotifier(transport)` in `src/bounty/notifier.ts`, same shape as the Telegram one (`:59-73`): `channel: 'imessage'`, `canReach: w => Boolean(bound && w.contact.imessage)`, plain text plus `notice.url`, and tails: `Reply CLAIM UH8X to take it.` / `When done, open the link or reply SUBMIT UH8X date=… time=… reference=…`.
- Pass it in through `createBountyModule({ notifiers: [im] })` (`src/bounty/index.ts:39`).
- Worker commands: refactor `createWorkerCommands` (`src/bounty/telegram.ts:32`) to take a `resolveWorker(ctx)` instead of calling `board.workerByTelegram`. Add `board.workerByContact('imessage', handle)` and `board.linkContact('imessage', code, handle)` next to `board.ts:148-158`.
- Replies come back as HTML; run `toPlain` before sending.
- Seeding: read `WORKER_<ID>_IMESSAGE` in `src/bounty/seed.ts:65`.
- A worker reachable on both Telegram and iMessage gets both (composite notifier, `notifier.ts:81-94`). First claim wins on the board, so double delivery is safe.

### 5.8 Config flags (`src/config.ts`)

| Flag | Default | Meaning |
|---|---|---|
| `IMESSAGE_ENABLED` | `false` | Start the iMessage channel |
| `IMESSAGE_TRANSPORT` | `imsg` | `imsg`, `imessage-kit` (later: `sendblue`, `photon`) |
| `IMSG_BIN` | `imsg` | Path to the CLI |
| `IMESSAGE_OPERATOR` | unset | Operator handle for approvals and alerts |
| `IMESSAGE_ALLOWLIST` | unset | Comma-separated hirer handles |
| `IMESSAGE_OPEN` | `false` | Accept hirers not on the list |
| `IMESSAGE_HIRER` | `false` | Run the hirer flow on iMessage. Off means workers and operator only (the demo default) |

### 5.9 Plug into index.ts

```ts
const imWorker = createIMessageWorkerNotifier();                       // bound on start
const bounty = createBountyModule({ store, bus, config, notifiers: [imWorker] });   // index.ts:52
...
const imessage = createIMessage({ jobs, bookings, gate, policy, store, bus, config, board: bounty.board, workerNotifier: imWorker }); // next to :89
imessage.start().catch(...);                                            // next to :129
await imessage.stop().catch(() => {});                                  // next to :141
```

And in `src/approvals/gate.ts:14`:

```ts
const headless = !config.TELEGRAM_OPERATOR_ID && !config.TELEGRAM_BOT_TOKEN && !config.IMESSAGE_OPERATOR;
```

Both channels subscribe to the bus. Each only speaks for jobs with its own `client`, so they do not double-post to hirers. Approvals go to every configured operator channel; the first answer wins.

### 5.10 Options compared

Facts checked October 2026. Prices change; check before paying.

| Option | How | Cost | Inbound | Outbound to new contacts | Setup | Fit |
|---|---|---|---|---|---|---|
| **`imsg` CLI** (github.com/openclaw/imsg) | Local, `imsg rpc` JSON-RPC over stdio, reads `chat.db`, sends through Messages.app | Free, MIT | Yes (`watch.subscribe`) | Yes (`chats.create`, checks the handle first) | Homebrew, Full Disk Access, Automation → Messages. macOS 14+ | **Recommended** |
| **`@photon-ai/imessage-kit`** | Local TypeScript SDK, AppleScript send, `chat.db` watch | Free, MIT | Yes | Yes | npm, Full Disk Access. Node 20+ | Fallback, in-process |
| **BlueBubbles server** | Local Mac app with REST API and webhooks; Private API mode for tapbacks | Free, open source | Yes (webhooks) | Yes | Heavier: app install, server password, optional SIP changes for the Private API | Overkill for 2 days |
| **Photon (hosted)** | Hosted API on Photon's lines | Free up to 10 users; Pro $25/mo for 100 users; Business $250/line/mo for dedicated lines | Yes | Shared line; cold outreach only on Business | Sign-up, API key | Good backup if the Mac route fails; shared number |
| **Sendblue** | Hosted API | Free sandbox: up to 10 verified contacts, no dedicated number, no outbound, no webhooks. AI Agent tier $100/mo per line, still inbound-first | Paid tier only | Enterprise only | Sign-up | Poor fit: worker offers are outbound |
| **LoopMessage** | Hosted API | Sandbox free for 5 contacts; shared sender $20/mo; dedicated from $59.99/mo; +$30/mo to start conversations | Yes (webhooks) | Paid add-on | Sign-up | Possible paid backup |
| **Apple Messages for Business** | Apple's business chat via an MSP | Apple approval and a business account | Yes | No (customer starts) | Weeks | Not viable here |

Facts common to every iMessage option: no inline buttons, so replies are numbered or keywords. Hosted options give a shared or rented number, not the team's own.

### 5.11 Recommendation

1. Build the `ChannelApi` refactor and the plain-text renderer first. It benefits Telegram tests too, and it is the only way iMessage reuses the hirer flow.
2. Use `imsg rpc` on the operator's Mac. This Mac runs macOS 14.4 and Node 24.19, which meets both `imsg` (macOS 14+) and the app (Node 22.5+). Install with Homebrew.
3. Use a dedicated Apple ID for HAAS, signed in to Messages on that Mac. Hirer, worker and operator phones must be other Apple IDs. iMessage cannot message itself cleanly, and `is_from_me` filtering would hide the replies.
4. Ship iMessage for **workers first** (offer, `CLAIM`, link to the page, `paid` notice), then the operator fallback, then the hirer flow behind `IMESSAGE_HIRER`.
5. Keep Photon's free tier as the hosted fallback if Full Disk Access or Automation cannot be granted on the demo Mac.

## 6. Demo plan

### What runs where

| Screen | Channel | Who holds it |
|---|---|---|
| Hirer phone | Telegram | Presenter |
| Operator phone | Telegram (approvals with buttons) | Second teammate |
| Worker phone (iPhone) | iMessage, then the `/w/<token>` page in Safari | Third teammate |
| Laptop | Server log, Solana explorer tab, Cardanoscan tab | Presenter |

Script (the clinic story, `docs/MANUAL_TESTING.md` section 3, level 3):

1. Hirer types "Call Tanjong Pagar Polyclinic and book the earliest physio slot this week" in Telegram.
2. Progress, then the shortlist with the bounty board on top. Hirer taps `Choose`.
3. QR plus link. Hirer signs in Phantom (devnet). "Escrow funded" with the Solana explorer link.
4. Operator taps `Approve` on the `book` approval.
5. Worker's iPhone buzzes: an iMessage offer. Worker replies `CLAIM UH8X`, gets the page link, submits date, time and reference.
6. QA passes. Hirer taps `Release` (after G1) or the operator approves.
7. "Released 3 USDC … View transaction". Then "Recorded on Cardano … Receipt NFT".
8. Telegram shows "Booked: Thursday 3pm, ref 88213" with the result hash.

### Pre-stage (the day before)

- Tunnel up and `PUBLIC_URL` set to it (Solana Pay and the worker page both need it).
- `pnpm seed:workers` with `WORKER_<ID>_TELEGRAM` and `WORKER_<ID>_IMESSAGE` set. Each worker has texted the HAAS Apple ID once, so the thread exists and the first message is not filtered.
- On the Mac: Full Disk Access granted to the terminal app that runs `pnpm start` (and to `imsg`); Automation → Messages allowed. Trigger the prompt once with `imsg send` so it does not appear on stage. Disable Focus and notification previews on the Mac.
- Phantom on the hirer phone in devnet with devnet USDC. The escrow program deployed and `SOLANA_ESCROW_PROGRAM_ID` set (README "Status": not deployed yet).
- Cardano identity configured, or `pnpm identity:demo` ready to show the receipt.
- `pnpm demo:warm` and `DEMO_MODE=true` for fast shortlists.
- One full dry run with real phones, timed.

### Fallbacks

| Failure | Fallback |
|---|---|
| iMessage does not deliver within ~10 s | The worker opens the `/w/<token>` link from the console log (or Telegram `/claim`). Say "the worker can also use the page". |
| Telegram 409 (another poller on the token) | Stop the other process; keep a second bot token in a spare `.env` |
| Solana Pay wallet cannot fetch the transaction | `ESCROW_PROVIDER=solana-vault` with the address flow, or `memory` for an instant deposit |
| Escrow program not deployed | Same as above. Say so; show `pnpm spike:solana` output |
| Cardano mint slow | Show the receipt from a rehearsal on Cardanoscan |
| Wi-Fi drops | Phone hotspot; Level 1 `pnpm demo:bounty` in the terminal |

### Risks

- **macOS permission prompts.** Full Disk Access and Automation prompts appear for the process that runs the server. Grant them in advance for the exact terminal app.
- **Apple ID flagged for spam.** Sending many messages to new numbers from a fresh Apple ID can get it limited. Keep volume tiny, use contacts who have texted first, and do not loop on errors.
- **Threads must exist.** First messages to unknown handles may land in "Unknown Senders" on the worker's iPhone. Pre-create every thread.
- **No buttons.** Typos in `CLAIM UH8X` are likely on stage. Accept `CLAIM` with no code when only one task is offered, and accept lowercase.
- **Echo loops.** The watcher sees outgoing messages. Filter `is_from_me` and dedupe by rowid.
- **Same person on two channels.** A worker on both Telegram and iMessage gets the offer twice. Fine (first claim wins), but say so.
- **Headless approvals.** If neither operator is configured, every approval passes on its own (`gate.ts:52-56`). Check the boot log before going on stage.

## 7. Task list

Hours are rough. "Done when" is the acceptance check.

### Core (whoever owns `src/engine`, `src/identity`, `src/domain`)

| # | Task | Hours | Done when |
|---|---|---|---|
| C1 | Add `'imessage'` to `JobClient` (`types.ts:200`); add the `reputation.recorded` event and emit it in `minter.ts` after `registry.recordJob` (`:226`, `:242`) | 1.5 | `pnpm typecheck` passes; a unit test in `identity.test.ts` sees the event with `txHash` |
| C2 | Gate headless check includes `IMESSAGE_OPERATOR` (`gate.ts:14`) | 0.25 | Test: with only `IMESSAGE_OPERATOR` set, an approval stays pending |
| C3 | `GET /pay/<bookingId>`: a page with amount, deadline and an "Open in wallet" link to `escrow.payUrl` | 1 | Opening the link on an iPhone with Phantom opens the signing screen |
| C4 | Add the release transaction URL to the bounty `paid` notice (`board.ts:366`) | 0.5 | `flow.test.ts` asserts the URL in the notice |
| C5 | Optional `milestone` flag on `job.progress` in `delegate.ts:39` and `router.ts:32` | 0.5 | Existing tests pass; flag present on the decision messages |

### Telegram teammate

| # | Task | Hours | Done when |
|---|---|---|---|
| T1 | Extract `createController` to `src/channels/controller.ts` with `ChannelApi` and `ChannelCaps`; keep `TgApi` as an alias; parameterise `client` and the kv prefix (G10) | 2 | `src/channels/telegram.test.ts` passes unchanged; the bot works as before (`MANUAL_TESTING.md` 2.2) |
| T2 | Hirer release approval: send `accept` / `revise` approvals to the hirer's chat too, accept the hirer's press (G1). Deny asks for a reason (G2) | 2 | Test: hirer taps `Release`, booking completes; operator's later press is ignored |
| T3 | Escrow messages: `solana:` link and `/pay` link in instructions (G3); amount, payee, hash and per-tx link in release and refund lines (G4) | 1 | `format.test.ts` covers funded, released and refunded with `txs` |
| T4 | Handle `verification.revision_requested`, `verification.rejected`, `in_revision` (G6) and `reputation.recorded` (G5) | 1.5 | Tests: each event produces one message to the hirer chat, and the receipt line has a Cardanoscan link |
| T5 | Richer `jobResult`: work summary, result hash, AI agent and output (G7); job context in `approvalRequest` (G8) | 1 | `format.test.ts` for AI path and bounty path results |
| T6 | `Claim` inline button on worker offers (G9): callback `k:<bountyCode>` routed to the worker commands | 1 | Worker taps `Claim` and gets "It's yours" |
| T7 | Live run of the bot end to end with real phones (README "Status" says it has not run live) | 1.5 | `MANUAL_TESTING.md` 2.2 and 2.9 pass on real phones |

### iMessage teammate

| # | Task | Hours | Done when |
|---|---|---|---|
| I1 | Spike: install `imsg`, grant permissions, send and receive from a Node script through `imsg rpc` | 1 | A text to the HAAS Apple ID prints in the script; a reply arrives on the phone |
| I2 | `toPlain(html)` and `shortlistPlain()` in `format.ts` (needs nothing from T1) | 1 | Unit tests: links become `text: url`, entities unescaped, the shortlist is one numbered message |
| I3 | Transport `src/channels/imessage/transport.ts` implementing `ChannelApi` with `caps: { buttons: false, edit: false, html: false }`; child restart; rowid dedupe; attachment send | 3 | Fake-process test: inbound line → handler called once; restart resumes from saved rowid |
| I4 | Worker notifier and keyword commands: `createIMessageWorkerNotifier`, `resolveWorker` refactor of `createWorkerCommands`, `workerByContact` / `linkContact` on the board, `WORKER_<ID>_IMESSAGE` in seeding | 2.5 | `flow.test.ts`-style test: offer → `CLAIM UH8X` → `SUBMIT …` → paid notice, all over a fake transport |
| I5 | Menu and approval-code mapping in the controller for `!caps.buttons` (after T1) | 2 | Test with a fake no-button transport: reply `2` chooses candidate 2; `YES A7` approves |
| I6 | `createIMessage` entry, sender routing (5.6), config flags (5.8), wiring in `index.ts` (5.9) | 1.5 | Boot log shows `[imessage] watching as <handle>`; a stranger's text is ignored |
| I7 | Real-phone rehearsal of the worker path, then (stretch) the hirer path with `IMESSAGE_HIRER=true` | 2 | Demo steps 5-8 work with the worker on iMessage, three times in a row |

### Order

1. C1, C2, I1, I2 in parallel (no dependencies).
2. T1 (unblocks I5 and makes I3 plug in).
3. T2-T5 and I3-I4 in parallel.
4. I5, I6, then C3-C5 and T6.
5. T7 and I7 together on real phones. Then the timed dry run.

Total: core ~4 h, Telegram ~10 h, iMessage ~13 h.

## Sources

- imsg: https://github.com/openclaw/imsg and its `docs/rpc.md`
- iMessage Kit: https://github.com/photon-hq/imessage-kit
- Photon pricing: https://photon.codes/pricing
- Sendblue pricing: https://www.sendblue.com/pricing
- LoopMessage pricing (third-party breakdown): https://bluereacher.com/blog/loopmessage-pricing-2026
- BlueBubbles server docs: https://docs.bluebubbles.app/server
