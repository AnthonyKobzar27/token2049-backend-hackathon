"""Channel: the transport boundary between the bridge and the human.

IMessageChannel sends through Messages.app (osascript) and reads replies from
the chat.db SQLite file. ConsoleChannel does the same job over stdin/stdout so
the whole bridge can be exercised without touching iMessage.
"""

import select
import sqlite3
import subprocess
import sys
from abc import ABC, abstractmethod

from config import CHAT_DB, RECIPIENT
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
    def send(self, text: str) -> None: ...

    @abstractmethod
    def poll_inbound(self) -> list[Inbound]:
        """New messages since the last call; the channel owns its own cursor."""


class IMessageChannel(Channel):
    def __init__(self, recipient: str = RECIPIENT, db_path: str = CHAT_DB):
        if not recipient:
            raise SystemExit("Set IMESSAGE_RECIPIENT to the handle you text from, e.g. +14155551234")
        self._recipient = recipient
        self._db_path = db_path
        self._cursor = self._latest_rowid()  # skip history, only react to new texts

    def send(self, text: str) -> None:
        subprocess.run(["osascript", "-e", SEND_SCRIPT, self._recipient, text], check=False, capture_output=True)

    def poll_inbound(self) -> list[Inbound]:
        q = """SELECT m.ROWID, m.text, m.attributedBody FROM message m
               JOIN handle h ON m.handle_id = h.ROWID
               WHERE m.ROWID > ? AND m.is_from_me = 0 AND h.id = ?
               ORDER BY m.ROWID"""
        with self._connect() as db:
            rows = db.execute(q, (self._cursor, self._recipient)).fetchall()
        out = []
        for rowid, text, blob in rows:
            self._cursor = rowid
            body = text or _decode_attributed_body(blob)
            if body and body.strip():
                out.append(Inbound(id=str(rowid), text=body.strip()))
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


class ConsoleChannel(Channel):
    def send(self, text: str) -> None:
        print(f"\n\033[1m[agent]\033[0m {text}")

    def poll_inbound(self) -> list[Inbound]:
        out = []
        n = 0
        while select.select([sys.stdin], [], [], 0)[0]:
            line = sys.stdin.readline()
            if not line:
                break
            if line.strip():
                n += 1
                out.append(Inbound(id=f"console-{n}", text=line.strip()))
        return out
