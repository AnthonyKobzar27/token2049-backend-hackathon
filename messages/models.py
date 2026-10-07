"""The three messages the bridge passes around.

Event        a fact from the agent's world (one entry of GET /api/events)
Notification a decision to interrupt the human, with the replies that make sense
Inbound      one message the human sent us
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Event:
    seq: int
    at: int
    type: str
    payload: dict

    @classmethod
    def from_sse(cls, entry: dict) -> "Event":
        event = dict(entry["event"])
        return cls(seq=entry["seq"], at=entry["at"], type=event.pop("type"), payload=event)


@dataclass(frozen=True)
class Notification:
    text: str
    kind: str  # "approval" | "shortlist" | "escrow" | "booking" | "result" | "question" | "attention"
    actions: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Inbound:
    id: str
    text: str
