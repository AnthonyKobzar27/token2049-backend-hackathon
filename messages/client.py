"""Entry point. CHANNEL picks the transport for the public line:
  CHANNEL=twilio    the agent's own dedicated number (TWILIO_* + OWNER_PHONE)
  CHANNEL=imessage  the Mac's iMessage identity (IMESSAGE_RECIPIENT = operator)
  --console / CHANNEL=console  terminal simulation ("+1555: hello" speaks as that sender)
"""

import sys

from bridge import Bridge
from channels import ConsoleChannel, IMessageChannel, TwilioChannel
from config import (
    CHANNEL,
    OWNER_PHONE,
    POLL_SECONDS,
    RECIPIENT,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_FROM,
    VERBOSE,
)
from conversation import Conversation
from events import EventStream
from haas import HaasClient
from notifier import Notifier
from store import UserStore


def pick_channel_and_owner(console: bool) -> tuple:
    if console or CHANNEL == "console":
        return ConsoleChannel(), RECIPIENT or "console-owner", 0.3
    if CHANNEL == "twilio":
        if not OWNER_PHONE:
            raise SystemExit("Set OWNER_PHONE to your own mobile (approvals go there) for CHANNEL=twilio")
        return TwilioChannel(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM), OWNER_PHONE, POLL_SECONDS
    if not RECIPIENT:
        raise SystemExit("Set IMESSAGE_RECIPIENT to the operator's handle, e.g. +14155551234")
    return IMessageChannel(), RECIPIENT, POLL_SECONDS


def main() -> None:
    console = "--console" in sys.argv
    channel, owner, poll = pick_channel_and_owner(console)
    store = UserStore()
    haas = HaasClient()
    bridge = Bridge(
        stream=EventStream(),
        channel=channel,
        notifier=Notifier(verbose=VERBOSE or console),
        convo=Conversation(haas, store, owner),
        store=store,
        owner=owner,
        poll_seconds=poll,
    )
    try:
        bridge.run()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
