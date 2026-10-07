"""Channel: the transport boundary between the bridge and people.

Multi-user: every inbound message carries its sender's handle, and sends are
addressed per recipient. IMessageChannel talks through Messages.app (osascript
out, chat.db in) and hears EVERYONE who texts the Mac's iMessage identity —
that is what makes the Mac's own number the agent's public line.
ConsoleChannel simulates several senders over stdin for testing.
"""

import re
import select
import sqlite3
import subprocess
import sys
from abc import ABC, abstractmethod

from config import CHAT_DB
from models import Inbound

SEND_SCRIPT = """
on run {handle, msg}
    tell application "Messages"
        set svc to 1st account whose service type = iMessage
        send msg to participant handle of svc
    end tell
end run
"""


class Channel(ABC):
    @abstractmethod
    def send(self, recipient: str, text: str) -> None: ...

    @abstractmethod
    def poll_inbound(self) -> list[Inbound]:
        """New messages since the last call; the channel owns its own cursor."""


class IMessageChannel(Channel):
    def __init__(self, db_path: str = CHAT_DB):
        self._db_path = db_path
        self._cursor = self._latest_rowid()  # skip history, only react to new texts

    def send(self, recipient: str, text: str) -> None:
        subprocess.run(["osascript", "-e", SEND_SCRIPT, recipient, text], check=False, capture_output=True)

    def poll_inbound(self) -> list[Inbound]:
        q = """SELECT m.ROWID, m.text, m.attributedBody, h.id FROM message m
               JOIN handle h ON m.handle_id = h.ROWID
               WHERE m.ROWID > ? AND m.is_from_me = 0
               ORDER BY m.ROWID"""
        with self._connect() as db:
            rows = db.execute(q, (self._cursor,)).fetchall()
        out = []
        for rowid, text, blob, sender in rows:
            self._cursor = rowid
            body = text or _decode_attributed_body(blob)
            if body and body.strip() and sender:
                out.append(Inbound(id=str(rowid), text=body.strip(), sender=sender))
        return out

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(f"file:{self._db_path}?mode=ro", uri=True)

    def _latest_rowid(self) -> int:
        with self._connect() as db:
            return db.execute("SELECT COALESCE(MAX(ROWID), 0) FROM message").fetchone()[0]


def _decode_attributed_body(blob: bytes | None) -> str | None:
    """Newer macOS leaves message.text NULL; the string then sits in the
    attributedBody typedstream after an 'NSString' marker and a '+' length byte."""
    if not blob:
        return None
    i = blob.find(b"NSString")
    if i < 0:
        return None
    i = blob.find(b"+", i)
    if i < 0:
        return None
    i += 1
    length = blob[i]
    i += 1
    if length == 0x81:
        length = int.from_bytes(blob[i : i + 2], "little")
        i += 2
    return blob[i : i + length].decode("utf-8", "ignore")


class TwilioChannel(Channel):
    """The agent's own dedicated phone number (SMS via Twilio).

    Outbound goes through the Messages REST API; inbound is POLLED from the
    same API filtered to our number, so no webhook, tunnel or public URL is
    needed — it slots into the bridge's poll loop exactly like chat.db does.
    Trial-account note: outbound only reaches numbers verified in the Twilio
    console, and bodies carry a trial prefix.
    """

    API = "https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"

    def __init__(self, sid: str, token: str, from_number: str):
        if not (sid and token and from_number):
            raise SystemExit("Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM for CHANNEL=twilio")
        import httpx  # deferred so the other channels work without it

        self._http = httpx.Client(auth=(sid, token), timeout=30)
        self._url = self.API.format(sid=sid)
        self._from = from_number
        self._seen: set[str] = set()
        self._started = self._now_utc()
        # Prime the dedupe set so history is not replayed on restart.
        for m in self._fetch():
            self._seen.add(m["sid"])

    @staticmethod
    def _now_utc():
        from datetime import datetime, timezone

        return datetime.now(timezone.utc)

    def send(self, recipient: str, text: str) -> None:
        try:
            res = self._http.post(self._url, data={"From": self._from, "To": recipient, "Body": text})
            if res.status_code >= 400:
                print(f"[twilio] send to {recipient} failed: {res.status_code} {res.text[:200]}")
        except Exception as err:
            print(f"[twilio] send to {recipient} failed: {err}")

    def poll_inbound(self) -> list[Inbound]:
        out = []
        try:
            messages = self._fetch()
        except Exception as err:
            print(f"[twilio] poll failed: {err}")
            return out
        for m in reversed(messages):  # API is newest-first; deliver oldest-first
            if m["sid"] in self._seen or m.get("direction") != "inbound":
                continue
            self._seen.add(m["sid"])
            body = (m.get("body") or "").strip()
            sender = m.get("from") or ""
            if body and sender:
                out.append(Inbound(id=m["sid"], text=body, sender=sender))
        if len(self._seen) > 5000:
            self._seen = set(list(self._seen)[-2500:])
        return out

    def _fetch(self) -> list[dict]:
        res = self._http.get(self._url, params={"To": self._from, "PageSize": 50})
        res.raise_for_status()
        return res.json().get("messages", [])


class ConsoleChannel(Channel):
    """Testing transport. A line like "+1555: hello" speaks as that sender;
    a bare line speaks as "console-user"."""

    SENDER = re.compile(r"^(\+\d+|console-[\w-]+|[\w.+-]+@[\w.-]+):\s+(.*)$")

    def send(self, recipient: str, text: str) -> None:
        print(f"\n\033[1m[agent -> {recipient}]\033[0m {text}")

    def poll_inbound(self) -> list[Inbound]:
        out = []
        n = 0
        while select.select([sys.stdin], [], [], 0)[0]:
            line = sys.stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            n += 1
            match = self.SENDER.match(line)
            sender, text = match.groups() if match else ("console-user", line)
            out.append(Inbound(id=f"console-{n}", text=text, sender=sender))
        return out
