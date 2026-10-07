"""Notifier: pure policy, no I/O. Event in, Notification out — or None.

Every state change the agent makes becomes a message. Only per-step progress
chatter (job.progress, source.done) stays quiet unless IMESSAGE_VERBOSE is on,
so the phone buzzes for every development without drowning in search noise.
"""

from models import Event, Notification


class Notifier:
    def __init__(self, verbose: bool = False):
        self._verbose = verbose
        # Jobs whose start was already announced; confirm flips a job back to
        # 'running', which must not read as a second task starting.
        self._announced: set[str] = set()

    def render(self, event: Event) -> Notification | None:
        handler = getattr(self, f"_{event.type.replace('.', '_')}", None)
        return handler(event.payload) if handler else None

    # ------------------------------------------------------------- lifecycle

    def _job_updated(self, p: dict) -> Notification | None:
        job = p["job"]
        if job["status"] == "running":
            if job["id"] in self._announced:
                return None
            self._announced.add(job["id"])
            # Bridge-created jobs were acknowledged in-conversation already.
            if str(job.get("clientRef", "")).startswith("imessage:"):
                return None
            return Notification(kind="info", text=f"🔎 On it: {job['brief']['task']}")
        if job["status"] not in ("completed", "failed"):
            return None
        self._announced.discard(job["id"])
        result = job.get("result") or {}
        detail = result.get("summary") or job.get("error") or ""
        if job["status"] == "failed":
            head = "❌ Task failed"
        elif result.get("outcome") == "no_booking":
            # Cancelled or ended without a hire; "completed" would overpromise.
            head = "🛑 Task closed, nobody hired"
        else:
            head = "🏁 Task completed"
        return Notification(kind="result", text=f"{head}: {job['brief']['task']}\n{detail}".rstrip())

    def _job_progress(self, p: dict) -> Notification | None:
        if not self._verbose:
            return None
        return Notification(kind="progress", text=f"⚙️ {p['message']}")

    def _source_done(self, p: dict) -> Notification | None:
        if not self._verbose:
            return None
        s = p["status"]
        state = f"{s['count']} profiles" if s["ok"] else f"failed: {s.get('error', 'unknown')}"
        return Notification(kind="progress", text=f"⚙️ {s['source']}: {state} ({s['ms']} ms)")

    def _shortlist_ready(self, p: dict) -> Notification:
        job, shortlist = p["job"], p["shortlist"]
        candidates = shortlist["candidates"]
        if not candidates:
            return Notification(
                kind="shortlist",
                text=f"🫥 Nobody fit the brief: {job['brief']['task']}\nReply REFINE <feedback> or CANCEL.",
                actions=["refine <feedback>", "cancel"],
            )
        lines = [f"👥 Candidates for: {job['brief']['task']}"]
        for i, c in enumerate(candidates, 1):
            profile = c["profile"]
            price = f" · ${c['quoteUsd']}" if c.get("quoteUsd") else ""
            headline = f" — {profile['headline']}" if profile.get("headline") else ""
            lines.append(f"{i}. {profile['name']} ({round(c['score'])}){price}{headline}")
            lines.append(f"   {c['reason']}")
        lines.append("Reply HIRE <n>, REFINE <feedback>, or CANCEL.")
        return Notification(kind="shortlist", text="\n".join(lines), actions=["hire <n>", "refine <feedback>", "cancel"])

    # -------------------------------------------------------------- bookings

    def _booking_updated(self, p: dict) -> Notification | None:
        b = p["booking"]
        texts = {
            "placed": f"📦 Booked on {b['platform']} for ${b['priceUsd']}.",
            "in_progress": "🛠 The freelancer started working.",
            "delivered": "📬 Delivery arrived — checking it now.",
            "in_revision": "🔁 Asked the freelancer for a revision.",
            "completed": f"📦 Booking completed (${b['priceUsd']}).",
            "cancelled": "📦 Booking cancelled.",
            "refunded": "📦 Booking refunded.",
        }
        if b["status"] == "handoff":
            url = f"\n{b['url']}" if b.get("url") else ""
            return Notification(kind="booking", text=f"🤝 This booking needs you to finish it:{url}")
        text = texts.get(b["status"])
        return Notification(kind="booking", text=text) if text else None

    # ---------------------------------------------------------------- escrow

    def _escrow_updated(self, p: dict) -> Notification | None:
        e = p["escrow"]
        if e["status"] == "awaiting_deposit" and e.get("payUrl"):
            return Notification(kind="escrow", text=f"💰 Fund escrow ({e['amount']} {e['currency']}):\n{e['payUrl']}")
        if e["status"] in ("funded", "released", "refunded"):
            return Notification(kind="escrow", text=f"💰 Escrow {e['status']} ({e['amount']} {e['currency']}).")
        if e["status"] == "failed":
            return Notification(kind="escrow", text=f"💰 Escrow problem: {e.get('error', 'unknown')}")
        return None

    def _escrow_timeout(self, p: dict) -> Notification:
        if p["kind"] == "deposit_expired":
            return Notification(kind="escrow", text="⏰ The deposit window closed, so the booking was cancelled.")
        return Notification(kind="escrow", text="⏰ The delivery was never accepted in time; the budget is being refunded.")

    # ------------------------------------------------------------- approvals

    def _approval_requested(self, p: dict) -> Notification:
        a = p["approval"]
        detail = f"\n{a['detail']}" if a.get("detail") else ""
        return Notification(
            kind="approval",
            text=f"🔔 Approval needed: {a['summary']}{detail}\nReply YES or NO.",
            actions=["yes", "no"],
        )

    def _approval_resolved(self, p: dict) -> Notification | None:
        a = p["approval"]
        # You answered it yourself a second ago; echoing it back is noise.
        if a.get("decidedBy") == "imessage":
            return None
        icon = {"approved": "✅", "denied": "🚫", "expired": "⌛"}.get(a["status"], "ℹ️")
        by = f" by {a['decidedBy']}" if a.get("decidedBy") else ""
        return Notification(kind="approval", text=f"{icon} Approval {a['status']}{by}: {a['summary']}")

    # ------------------------------------------------------------------- QA

    def _verification_started(self, p: dict) -> Notification | None:
        nth = f" (attempt {p['attempt']})" if p.get("attempt", 1) > 1 else ""
        return Notification(kind="qa", text=f"🔍 Checking the delivery{nth}…")

    def _verification_completed(self, p: dict) -> Notification | None:
        r = p["report"]
        if r["verdict"] in ("pass", "passed"):
            return Notification(kind="qa", text=f"✅ Quality check passed ({round(r['score'] * 100)}%): {r['summary']}")
        return None  # fail paths arrive as revision_requested / rejected below

    def _verification_revision_requested(self, p: dict) -> Notification:
        return Notification(kind="qa", text=f"🔁 Quality check failed; asked the freelancer to fix it:\n{p['text']}")

    def _verification_rejected(self, p: dict) -> Notification:
        r = p["report"]
        return Notification(kind="qa", text=f"❌ Delivery rejected after QA ({round(r['score'] * 100)}%): {r['summary']}\nNo payout; the budget comes back to you.")

    # --------------------------------------------------------------- bounty

    def _bounty_updated(self, p: dict) -> Notification | None:
        b = p["bounty"]
        texts = {
            "posted": f"📌 Posted a ${b['rewardUsd']} bounty for a verified worker.",
            "claimed": "🙋 A worker claimed the bounty and is on it.",
            "submitted": "📬 The worker submitted their result — checking it.",
            "verified": "✅ Bounty work verified.",
            "paid": f"💸 Worker paid ${b['rewardUsd']}.",
            "rejected": f"🚫 Bounty work rejected{': ' + b['reason'] if b.get('reason') else ''}.",
            "cancelled": "📌 Bounty cancelled.",
        }
        if b["status"] == "expired":
            stage = "nobody claimed it" if b.get("stage") == "claim" else "the worker never submitted"
            return Notification(kind="bounty", text=f"⏰ Bounty expired ({stage}); escrow refunds.")
        text = texts.get(b["status"])
        return Notification(kind="bounty", text=text) if text else None

    # ---------------------------------------------------------- conversation

    def _conversation_message(self, p: dict) -> Notification | None:
        m = p["message"]
        if m["thread"] == "hirer" and m["from"] == "agent":
            return Notification(kind="question", text=f"🧑‍💼 Agent: {m['text']}")
        if m["thread"] == "freelancer" and m["from"] == "freelancer":
            return Notification(kind="chat", text=f"💬 Freelancer: {m['text']}")
        return None

    def _operator_attention(self, p: dict) -> Notification:
        url = f"\n{p['url']}" if p.get("url") else ""
        return Notification(kind="attention", text=f"⚠️ {p['message']}{url}")
