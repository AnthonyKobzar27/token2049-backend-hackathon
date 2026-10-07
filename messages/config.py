import os

HAAS_URL = os.environ.get("HAAS_URL", "http://localhost:8787")
HAAS_TOKEN = os.environ.get("HAAS_TOKEN", "")  # optional, mint one via POST /api/tokens
# The handle you text the agent from (phone number or iMessage email).
RECIPIENT = os.environ.get("IMESSAGE_RECIPIENT", "")
CHAT_DB = os.path.expanduser("~/Library/Messages/chat.db")
POLL_SECONDS = 2.0
