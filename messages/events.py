"""EventStream: owns the SSE connection to /api/events.

Reconnects forever and resumes from the last seen seq, so no event is missed
across drops or backend restarts. Knows nothing about what events mean.
"""

import json
import time
from collections.abc import Iterator

import httpx

from config import HAAS_URL
from models import Event

RETRY_SECONDS = 3.0


class EventStream:
    def __init__(self, base_url: str = HAAS_URL):
        self._base_url = base_url
        self._last_seq = 0
        self._primed = False

    def listen(self) -> Iterator[Event]:
        """Blocks forever, yielding events; survives disconnects."""
        while True:
            if not self._primed:
                self._prime()
            try:
                yield from self._connect_once()
            except Exception as err:
                print(f"[events] reconnecting in {RETRY_SECONDS:.0f}s: {err}")
                time.sleep(RETRY_SECONDS)

    def _prime(self) -> None:
        """Start at the buffer's tip: old events belong to the dashboard, and
        resending them on every bridge restart would spam the phone."""
        try:
            entries = httpx.get(f"{self._base_url}/api/activity", timeout=10).json()
            self._last_seq = max((e["seq"] for e in entries), default=0)
            self._primed = True
        except Exception:
            pass  # backend not up yet; try again before the next connect

    def _connect_once(self) -> Iterator[Event]:
        url = f"{self._base_url}/api/events"
        with httpx.stream("GET", url, params={"since": self._last_seq}, timeout=httpx.Timeout(10, read=None)) as res:
            res.raise_for_status()
            data: list[str] = []
            for line in res.iter_lines():
                if line.startswith("data:"):
                    data.append(line[5:].strip())
                elif line == "" and data:
                    entry = json.loads("".join(data))
                    data = []
                    event = Event.from_sse(entry)
                    self._last_seq = max(self._last_seq, event.seq)
                    yield event
                elif not line.startswith(("id:", ":", "retry:")):
                    data = []
