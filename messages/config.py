import os

HAAS_URL = os.environ.get("HAAS_URL", "http://localhost:8787")
HAAS_TOKEN = os.environ.get("HAAS_TOKEN", "")  # optional, mint one via POST /api/tokens
# Which transport carries the public line: imessage | twilio | console.
CHANNEL = os.environ.get("CHANNEL", "imessage").lower()
# The handle you text the agent from (phone number or iMessage email).
RECIPIENT = os.environ.get("IMESSAGE_RECIPIENT", "")
CHAT_DB = os.path.expanduser("~/Library/Messages/chat.db")

# Twilio: the agent's own dedicated number (CHANNEL=twilio). Put the three
# TWILIO_* values in the environment yourself; never commit them.
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM = os.environ.get("TWILIO_FROM", "")  # e.g. +18445551234
# The operator's own mobile (gets approvals) when the line runs on Twilio.
OWNER_PHONE = os.environ.get("OWNER_PHONE", "")
POLL_SECONDS = 2.0
# Bridge-local user registry (who texted us, whose job is whose).
BRIDGE_DB = os.environ.get("BRIDGE_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge.db"))
# Also forward per-step progress chatter (searching, scoring, per-source timing).
VERBOSE = os.environ.get("IMESSAGE_VERBOSE", "").lower() in ("1", "true", "yes")
