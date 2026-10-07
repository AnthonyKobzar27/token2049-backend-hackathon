"""Notifier: pure policy, no I/O. Event in, Notification out — or None,
which means the event stays on the dashboard and the phone stays quiet."""

from models import Event, Notification


class Notifier:
    def render(self, event: Event) -> Notification | None:
        handler = getattr(self, f"_{event.type.replace('.', '_')}", None)
        return handler(event.payload) if handler else None

    def _approval_requested(self, p: dict) -> Notification:
        a = p["approval"]
        detail = f"\n{a['detail']}" if a.get("detail") else ""
        return Notification(
            kind="approval",
            text=f"🔔 Approval needed: {a['summary']}{detail}\nReply YES or NO.",
            actions=["yes", "no"],
        )

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

    def _escrow_updated(self, p: dict) -> Notification | None:
        e = p["escrow"]
        if e["status"] == "awaiting_deposit" and e.get("payUrl"):
            return Notification(kind="escrow", text=f"💰 Fund escrow ({e['amount']} {e['currency']}):\n{e['payUrl']}")
        if e["status"] in ("funded", "released", "refunded"):
            return Notification(kind="escrow", text=f"💰 Escrow {e['status']}.")
        return None

    def _booking_updated(self, p: dict) -> Notification | None:
        b = p["booking"]
        if b["status"] == "handoff":
            url = f"\n{b['url']}" if b.get("url") else ""
            note = f"\n{b['note']}" if b.get("note") else ""
            return Notification(
                kind="booking",
                text=f"🤝 Booking on {b['platform']} (${b['priceUsd']}):{note}{url}\nReply ACCEPT once the work is delivered.",
                actions=["accept"],
            )
        if b["status"] in ("placed", "delivered", "completed", "cancelled"):
            return Notification(kind="booking", text=f"📦 Booking {b['status']} on {b['platform']} (${b['priceUsd']}).")
        return None

    def _job_updated(self, p: dict) -> Notification | None:
        job = p["job"]
        if job["status"] not in ("completed", "failed"):
            return None
        detail = (job.get("result") or {}).get("summary") or job.get("error") or ""
        icon = "🏁" if job["status"] == "completed" else "❌"
        return Notification(kind="result", text=f"{icon} Task {job['status']}: {job['brief']['task']}\n{detail}".rstrip())

    def _conversation_message(self, p: dict) -> Notification | None:
        m = p["message"]
        if m["thread"] == "hirer" and m["from"] == "agent":
            return Notification(kind="question", text=f"🧑‍💼 Agent: {m['text']}")
        return None

    def _operator_attention(self, p: dict) -> Notification:
        url = f"\n{p['url']}" if p.get("url") else ""
        return Notification(kind="attention", text=f"⚠️ {p['message']}{url}")
