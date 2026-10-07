"""Bridge: the composition root and the only place with threads and loops.

Flow A (outbound): EventStream -> Notifier -> Channel.send
Flow B (inbound):  Channel.poll_inbound -> Conversation -> Channel.send
"""

import threading
import time

from channels import Channel
from conversation import Conversation
from events import EventStream
from notifier import Notifier


class Bridge:
    def __init__(self, stream: EventStream, channel: Channel, notifier: Notifier, convo: Conversation,
                 poll_seconds: float = 2.0):
        self._stream = stream
        self._channel = channel
        self._notifier = notifier
        self._convo = convo
        self._poll_seconds = poll_seconds

    def run(self) -> None:
        threading.Thread(target=self._outbound, daemon=True).start()
        self._channel.send("HAAS bridge online. Text me a task, or HELP.")
        self._inbound()

    def _outbound(self) -> None:
        for event in self._stream.listen():
            notification = self._notifier.render(event)
            if notification:
                self._channel.send(notification.text)

    def _inbound(self) -> None:
        while True:
            for msg in self._channel.poll_inbound():
                print(f"[bridge] inbound: {msg.text!r}")
                self._channel.send(self._convo.handle(msg))
            time.sleep(self._poll_seconds)
