"""SQLite persistence for analyst decisions + the audit trail.

Append-only: every recorded decision inserts a new row, so the table IS the
audit trail (full history of who decided what, on what score, when). The
"current" decision is simply the most recent row. Uses the stdlib `sqlite3`
(no extra dependency). The DB file (config.DB_PATH) is gitignored.
"""

import sqlite3
from datetime import datetime, timezone

from config import DB_PATH

_SCHEMA = """
CREATE TABLE IF NOT EXISTS decisions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id          TEXT NOT NULL,
    action           TEXT NOT NULL,
    decided_by       TEXT NOT NULL,
    notes            TEXT NOT NULL DEFAULT '',
    score_total      REAL,
    band             TEXT,
    rationale_source TEXT,
    created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_case ON decisions(case_id, id);
"""


def _conn() -> sqlite3.Connection:
    # One connection per call → thread-safe under FastAPI's sync threadpool.
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _conn() as conn:
        conn.executescript(_SCHEMA)


def record_decision(case_id: str, action: str, decided_by: str, notes: str,
                    score_total: float, band: str, rationale_source: str) -> dict:
    """Append one decision row (immutable) and return it."""
    created_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with _conn() as conn:
        cur = conn.execute(
            "INSERT INTO decisions "
            "(case_id, action, decided_by, notes, score_total, band, rationale_source, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (case_id, action, decided_by, notes, score_total, band, rationale_source, created_at),
        )
        row = conn.execute("SELECT * FROM decisions WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


def list_decisions(case_id: str) -> list[dict]:
    """All decisions for a case, oldest first (the audit trail)."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM decisions WHERE case_id = ? ORDER BY id ASC", (case_id,)
        ).fetchall()
    return [dict(r) for r in rows]
