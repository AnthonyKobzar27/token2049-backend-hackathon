"""Entry point. `python client.py` runs the iMessage bridge;
`python client.py --console` runs the same bridge in the terminal."""

import sys

from bridge import Bridge
from channels import ConsoleChannel, IMessageChannel
from config import POLL_SECONDS
from conversation import Conversation
from events import EventStream
from haas import HaasClient
from notifier import Notifier


def main() -> None:
    console = "--console" in sys.argv
    channel = ConsoleChannel() if console else IMessageChannel()
    bridge = Bridge(
        stream=EventStream(),
        channel=channel,
        notifier=Notifier(),
        convo=Conversation(HaasClient()),
        poll_seconds=0.3 if console else POLL_SECONDS,
    )
    try:
        bridge.run()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
