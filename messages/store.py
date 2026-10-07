"""UserStore: who talks to the public line, and which jobs are theirs.

SQLite, synchronous, one short-lived connection per call (safe across the
bridge's two threads). This class is the seam where a hosted database drops
in: a Supabase-backed implementation with the same five methods (supabase-py
against SUPABASE_URL/SUPABASE_KEY, tables `users`, `job_owners`, `bookings`)
can replace it without touching the rest of the bridge.
"""

import os
import sqlite3
import time

from config import BRIDGE_DB

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  handle     TEXT PRIMARY KEY,
  name       TEXT,
  created_at INTEGER NOT NULL,
  state      TEXT NOT NULL DEFAULT 'new',
  pending    TEXT
);
CREATE TABLE IF NOT EXISTS job_owners (
  job_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  booking_id TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL
);
"""


class UserStore:
    def __init__(self, path: str = BRIDGE_DB):
        self._path = path
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with self._connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self._path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    # ----------------------------------------------------------------- users

    def get_user(self, handle: str) -> dict | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM users WHERE handle = ?", (handle,)).fetchone()
        return dict(row) if row else None

    def upsert_user(self, handle: str, **fields) -> dict:
        """Creates the user on first sight, then merges the given fields."""
        with self._connect() as db:
            db.execute(
                "INSERT INTO users (handle, created_at) VALUES (?, ?) ON CONFLICT(handle) DO NOTHING",
                (handle, int(time.time() * 1000)),
            )
            if fields:
                sets = ", ".join(f"{k} = ?" for k in fields)
                db.execute(f"UPDATE users SET {sets} WHERE handle = ?", (*fields.values(), handle))
            row = db.execute("SELECT * FROM users WHERE handle = ?", (handle,)).fetchone()
        return dict(row)

    # ------------------------------------------------------------ ownership

    def set_job_owner(self, job_id: str, handle: str) -> None:
        with self._connect() as db:
            db.execute("INSERT OR REPLACE INTO job_owners (job_id, handle) VALUES (?, ?)", (job_id, handle))

    def owner_of(self, job_id: str) -> str | None:
        with self._connect() as db:
            row = db.execute("SELECT handle FROM job_owners WHERE job_id = ?", (job_id,)).fetchone()
        return row["handle"] if row else None

    # ------------------------------------------------- booking -> job lookup
    # escrow.updated events carry only a bookingId; the mapping is learned
    # from booking.updated events as they stream past.

    def set_booking_job(self, booking_id: str, job_id: str) -> None:
        with self._connect() as db:
            db.execute("INSERT OR REPLACE INTO bookings (booking_id, job_id) VALUES (?, ?)", (booking_id, job_id))

    def job_of_booking(self, booking_id: str) -> str | None:
        with self._connect() as db:
            row = db.execute("SELECT job_id FROM bookings WHERE booking_id = ?", (booking_id,)).fetchone()
        return row["job_id"] if row else None
