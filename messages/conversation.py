"""Conversation: the inbound brain. Human text in, reply text out, acting
through HaasClient. Rule-based for now; an LLM slots into handle() later
without anything else changing."""

import re

from haas import HaasClient
from models import Inbound

YES = {"yes", "y", "approve", "ok", "👍"}
NO = {"no", "n", "deny", "👎"}

HELP = (
    "I can do these:\n"
    "• text me any task to start a search\n"
    "• HIRE <n> — book candidate n from the last shortlist\n"
    "• REFINE <feedback> — search again with your notes\n"
    "• CANCEL — drop the current search\n"
    "• YES / NO — answer an approval\n"
    "• STATUS — what I'm up to"
)


class Conversation:
    def __init__(self, haas: HaasClient):
        self._haas = haas

    def handle(self, msg: Inbound) -> str:
        text = msg.text.strip()
        low = text.lower()
        try:
            if low in YES or low in NO:
                return self._decide(low in YES)
            if match := re.fullmatch(r"hire\s+(\d+)", low):
                return self._hire(int(match.group(1)))
            if low.startswith("refine ") and len(text) > 7:
                return self._refine(text[7:])
            if low == "cancel":
                return self._cancel()
            if low == "status":
                return self._status()
            if low in ("help", "?"):
                return HELP
            return self._free_text(text)
        except Exception as err:
            return f"That didn't work: {err}"

    # ---------------------------------------------------------------- intents

    def _decide(self, approved: bool) -> str:
        pending = self._haas.pending_approvals()
        if not pending:
            return "Nothing is waiting for approval."
        approval = pending[0]  # newest first
        self._haas.decide(approval["id"], approved)
        return f"{'✅ Approved' if approved else '🚫 Denied'}: {approval['summary']}"

    def _hire(self, n: int) -> str:
        job = self._awaiting_input()
        if not job:
            return "No shortlist is waiting on you."
        candidates = (self._haas.job_detail(job["id"]).get("shortlist") or {}).get("candidates", [])
        if not 1 <= n <= len(candidates):
            return f"Pick a number from 1 to {len(candidates)}."
        chosen = candidates[n - 1]
        self._haas.provide_input(job["id"], {"action": "confirm", "profileId": chosen["profile"]["id"]})
        return f"On it — booking {chosen['profile']['name']}. I'll come back for the escrow and final approval."

    def _refine(self, feedback: str) -> str:
        job = self._awaiting_input()
        if not job:
            return "No shortlist is waiting on you."
        self._haas.provide_input(job["id"], {"action": "refine", "feedback": feedback})
        return "Searching again with that in mind."

    def _cancel(self) -> str:
        job = self._awaiting_input()
        if not job:
            return "Nothing to cancel."
        self._haas.provide_input(job["id"], {"action": "cancel"})
        return "Cancelled."

    def _status(self) -> str:
        o = self._haas.overview()
        jobs = o["jobs"]
        parts = [
            f"{jobs['running']} running",
            f"{jobs['awaitingInput']} waiting on you",
            f"{o['pendingApprovals']} approvals pending",
            f"{o['openBookings']} open bookings",
        ]
        current = [j["brief"]["task"] for j in self._haas.jobs() if j["status"] in ("running", "awaiting_input")]
        tail = ("\nNow: " + "; ".join(current[:3])) if current else ""
        return "📊 " + ", ".join(parts) + "." + tail

    def _free_text(self, text: str) -> str:
        # A reply while a shortlist waits is feedback; anything else starts a task.
        job = self._awaiting_input()
        if job:
            self._haas.send_job_message(job["id"], text)
            return "Got it — refining the search with that."
        job = self._haas.create_job(text)
        return f"🔎 On it: {job['brief']['task']}\nI'll text you a shortlist."

    def _awaiting_input(self) -> dict | None:
        return next((j for j in self._haas.jobs() if j["status"] == "awaiting_input"), None)
