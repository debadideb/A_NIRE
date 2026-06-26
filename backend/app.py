"""A_NIRE Case Console — FastAPI backend (build slice 1).

One process serves both the JSON API and the static frontend, so there is no
CORS and one URL for the whole app. Slice 1 returns a hardcoded case contract
(see fixtures.py); slice 2 swaps the fixture for a real Neo4j build + scoring
pass emitting the same shape.

Run (from the backend/ directory):
    uvicorn app:app --reload --port 8000
Then open http://localhost:8000/  (UI) and http://localhost:8000/api/case/CASE-2026-0001 (API).
"""

import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

# Make sibling modules importable no matter the working directory uvicorn is
# launched from (so `uvicorn app:app` and `uvicorn backend.app:app` both work).
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

from fixtures import HARDCODED_CASE  # noqa: E402  (after sys.path tweak)

FRONTEND_DIR = _HERE.parent / "frontend"

app = FastAPI(title="A_NIRE Case Console", version="0.1.0")


@app.get("/api/health")
def health() -> dict:
    """Liveness probe."""
    return {"status": "ok", "slice": 1}


@app.get("/api/case/{case_id}")
def get_case(case_id: str) -> dict:
    """Return the scored case contract for a case id.

    Slice 1 knows exactly one case. Unknown ids 404 rather than silently
    returning the wrong case — the queue is visual-only, so there is no
    multi-case lookup to fall back on.
    """
    if case_id != HARDCODED_CASE["case"]["case_id"]:
        raise HTTPException(status_code=404, detail=f"Unknown case '{case_id}'")
    return HARDCODED_CASE


# Mount the frontend LAST so /api/* routes always win. html=True serves
# index.html at "/". Until the mockup is copied to frontend/index.html, "/"
# returns 404 by design — the API above is the testable surface for slice 1.
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


if __name__ == "__main__":
    import os
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))
