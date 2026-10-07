"""Bridge: the composition root and the only place with threads and loops.

Flow A (outbound): EventStream -> Notifier -> route to owner or requester -> Channel.send
Flow B (inbound):  Channel.poll_inbound -> Conversation (per sender) -> Channel.send

Routing: a job's notifications go to whoever asked for it (UserStore.owner_of);
approvals and operator.attention always go to the owner; anything unattributable
falls back to the owner too.
"""

import threading
import time

from channels import Channel
from conversation import Conversation
from events import EventStream
from models import Event
from notifier import Notifier
from store import UserStore

OWNER_ONLY = {"approval.requested", "approval.resolved", "operator.attention"}


class Bridge:
    def __init__(self, stream: EventStream, channel: Channel, notifier: Notifier, convo: Conversation,
                 store: UserStore, owner: str, poll_seconds: float = 2.0):
        self._stream = stream
        self._channel = channel
        self._notifier = notifier
        self._convo = convo
        self._store = store
        self._owner = owner
        self._poll_seconds = poll_seconds

    def run(self) -> None:
        threading.Thread(target=self._outbound, daemon=True).start()
        self._channel.send(self._owner, "HAAS bridge online. The public line is open — text me a task, or HELP.")
        self._inbound()

    # -------------------------------------------------------------- outbound

    def _outbound(self) -> None:
        for event in self._stream.listen():
            # Learn booking -> job as bookings stream past; escrow.updated needs it.
            if event.type == "booking.updated":
                b = event.payload["booking"]
                self._store.set_booking_job(b["id"], b["jobId"])
            notification = self._notifier.render(event)
            if notification:
                self._channel.send(self._recipient_of(event), notification.text)

    def _recipient_of(self, event: Event) -> str:
        if event.type in OWNER_ONLY:
            return self._owner
        job_id = self._job_id_of(event)
        if not job_id:
            return self._owner
        owner = self._store.owner_of(job_id)
        if owner is None:
            # A job's first events can beat the ownership write by a moment.
            time.sleep(0.25)
            owner = self._store.owner_of(job_id)
        return owner or self._owner

    def _job_id_of(self, event: Event) -> str | None:
        p = event.payload
        t = event.type
        if t in ("job.updated", "shortlist.ready"):
            return p["job"]["id"]
        if t in ("job.progress", "source.done", "verification.started"):
            return p.get("jobId")
        if t == "booking.updated":
            return p["booking"]["jobId"]
        if t in ("escrow.timeout", "verification.completed", "verification.revision_requested", "verification.rejected"):
            return (p.get("booking") or {}).get("jobId")
        if t == "escrow.updated":
            return self._store.job_of_booking(p["escrow"].get("bookingId", ""))
        if t == "bounty.updated":
            return p["bounty"].get("jobId")
        if t == "conversation.message":
            return p["message"].get("jobId")
        return None

    # --------------------------------------------------------------- inbound

    def _inbound(self) -> None:
        while True:
            for msg in self._channel.poll_inbound():
                print(f"[bridge] inbound from {msg.sender}: {msg.text!r}")
                self._channel.send(msg.sender, self._convo.handle(msg))
            time.sleep(self._poll_seconds)
