"""Conversation: the inbound brain, now one dialogue per sender.

The OWNER (the operator's own handle) keeps the full command set, including
approvals. Everyone else goes through the public flow: register (name),
one clarifying question per request, then a job of their own — scoped so
they only ever see and steer their own work. Rule-based for now; an LLM
slots into handle() later without anything else changing.
"""

import re

from haas import HaasClient
from models import Inbound
from store import UserStore

YES = {"yes", "y", "approve", "ok", "👍"}
NO = {"no", "n", "deny", "👎"}

OWNER_HELP = (
    "I can do these:\n"
    "• text me any task to start a search\n"
    "• HIRE <n> — book candidate n from the last shortlist\n"
    "• REFINE <feedback> — search again with your notes\n"
    "• CANCEL — drop the current search\n"
    "• YES / NO — answer an approval\n"
    "• STATUS — what I'm up to"
)

USER_HELP = (
    "Text me what you need done and I'll handle it:\n"
    "• HIRE <n> — book candidate n from your shortlist\n"
    "• REFINE <feedback> — search again with your notes\n"
    "• CANCEL — drop your current search\n"
    "• STATUS — where your requests stand"
)

GREETING = "Hi, I'm the HaaS agent — I get real-world errands done with verified humans. What's your name?"
CLARIFY = "Got it. Any budget, deadline or location I should know? (reply SKIP if not)"


class Conversation:
    def __init__(self, haas: HaasClient, store: UserStore, owner: str):
        self._haas = haas
        self._store = store
        self._owner = owner

    def handle(self, msg: Inbound) -> str:
        try:
            if msg.sender == self._owner:
                return self._handle_owner(msg.text.strip())
            return self._handle_user(msg.sender, msg.text.strip())
        except Exception as err:
            return f"That didn't work: {err}"

    # ------------------------------------------------------------- the owner

    def _handle_owner(self, text: str) -> str:
        low = text.lower()
        if low in YES or low in NO:
            return self._decide(low in YES)
        if match := re.fullmatch(r"hire\s+(\d+)", low):
            return self._hire(int(match.group(1)), handle=None)
        if low.startswith("refine ") and len(text) > 7:
            return self._refine(text[7:], handle=None)
        if low == "cancel":
            return self._cancel(handle=None)
        if low == "status":
            return self._status(handle=None)
        if low in ("help", "?"):
            return OWNER_HELP
        return self._free_text(text, handle=None)

    def _decide(self, approved: bool) -> str:
        pending = self._haas.pending_approvals()
        if not pending:
            return "Nothing is waiting for approval."
        approval = pending[0]  # newest first
        self._haas.decide(approval["id"], approved)
        return f"{'✅ Approved' if approved else '🚫 Denied'}: {approval['summary']}"

    # ----------------------------------------------------------- the public

    def _handle_user(self, sender: str, text: str) -> str:
        user = self._store.get_user(sender) or self._store.upsert_user(sender)
        state = user.get("state") or "new"

        if state == "new":
            pending = text if len(text) >= 12 else None
            self._store.upsert_user(sender, state="awaiting_name", pending=pending)
            return GREETING

        if state == "awaiting_name":
            name = text[:40].strip() or "friend"
            if user.get("pending"):
                self._store.upsert_user(sender, name=name, state="awaiting_details")
                return f"Nice to meet you, {name}! About your request — any budget, deadline or location I should know? (reply SKIP if not)"
            self._store.upsert_user(sender, name=name, state="ready")
            return f"Nice to meet you, {name}! Text me what you need done."

        if state == "awaiting_details":
            pending = user.get("pending") or ""
            task = pending if text.strip().lower() == "skip" else f"{pending} ({text.strip()})"
            job = self._haas.create_job(task, client_ref=f"imessage:{sender}")
            self._store.set_job_owner(job["id"], sender)
            self._store.upsert_user(sender, state="ready", pending=None)
            return "On it — I'll text you as things happen. 🔎"

        # state == "ready"
        low = text.lower()
        if match := re.fullmatch(r"hire\s+(\d+)", low):
            return self._hire(int(match.group(1)), handle=sender)
        if low.startswith("refine ") and len(text) > 7:
            return self._refine(text[7:], handle=sender)
        if low == "cancel":
            return self._cancel(handle=sender)
        if low == "status":
            return self._status(handle=sender)
        if low in ("help", "?"):
            return USER_HELP
        if low in YES or low in NO:
            return "You're all set — spending approvals are the operator's call, I'll keep you posted."
        return self._free_text(text, handle=sender)

    # ---------------------------------------------------------------- shared
    # handle=None means the owner: unscoped, as before. A user handle scopes
    # every lookup to jobs tagged clientRef "imessage:<handle>".

    def _jobs_for(self, handle: str | None) -> list[dict]:
        jobs = self._haas.jobs()
        if handle is None:
            return jobs
        ref = f"imessage:{handle}"
        return [j for j in jobs if j.get("clientRef") == ref]

    def _awaiting_input(self, handle: str | None) -> dict | None:
        return next((j for j in self._jobs_for(handle) if j["status"] == "awaiting_input"), None)

    def _hire(self, n: int, handle: str | None) -> str:
        job = self._awaiting_input(handle)
        if not job:
            return "No shortlist is waiting on you."
        candidates = (self._haas.job_detail(job["id"]).get("shortlist") or {}).get("candidates", [])
        if not candidates:
            return "The current shortlist is empty — reply REFINE <feedback> or CANCEL."
        if not 1 <= n <= len(candidates):
            return f"Pick a number from 1 to {len(candidates)}."
        chosen = candidates[n - 1]
        self._haas.provide_input(job["id"], {"action": "confirm", "profileId": chosen["profile"]["id"]})
        return f"On it — booking {chosen['profile']['name']}. I'll come back as soon as there's news."

    def _refine(self, feedback: str, handle: str | None) -> str:
        job = self._awaiting_input(handle)
        if not job:
            return "No shortlist is waiting on you."
        self._haas.provide_input(job["id"], {"action": "refine", "feedback": feedback})
        return "Searching again with that in mind."

    def _cancel(self, handle: str | None) -> str:
        job = self._awaiting_input(handle)
        if not job:
            return "Nothing to cancel."
        self._haas.provide_input(job["id"], {"action": "cancel"})
        return "Cancelled."

    def _status(self, handle: str | None) -> str:
        if handle is None:
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
        mine = self._jobs_for(handle)
        if not mine:
            return "No requests yet — text me what you need done."
        lines = ["📊 Your requests:"]
        for j in mine[:5]:
            lines.append(f"• {j['brief']['task']} — {j['status'].replace('_', ' ')}")
        return "\n".join(lines)

    def _free_text(self, text: str, handle: str | None) -> str:
        # A reply while a shortlist waits is feedback; anything else starts a
        # task. The owner's free text only ever touches the owner's OWN jobs —
        # explicit HIRE/REFINE/CANCEL remain the operator's global override.
        job = self._awaiting_input(handle if handle is not None else self._owner)
        if job:
            self._haas.send_job_message(job["id"], text)
            return "Got it — refining the search with that."
        if handle is None:
            job = self._haas.create_job(text, client_ref=f"imessage:{self._owner}")
            self._store.set_job_owner(job["id"], self._owner)
            return "Got it — searching now. I'll text you a shortlist."
        self._store.upsert_user(handle, state="awaiting_details", pending=text)
        return CLARIFY
