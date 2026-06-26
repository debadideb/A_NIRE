"""A_NIRE Case Console — FastAPI backend.

One process serves both the JSON API and the static frontend, so there is no
CORS and one URL for the whole app.

Slice 2: the case contract is now built from a real Neo4j graph + Cypher
detectors + rule-based scoring (graphdb.py + scoring.py), replacing slice 1's
hardcoded fixture. The graph is (re)built once at startup and the contract is
cached (the synthetic data is static); restart to reload.

Run (from the backend/ directory, with Neo4j running):
    uvicorn app:app --reload --port 8000
Then open http://localhost:8000/  (UI) and http://localhost:8000/api/case/CASE-2026-0001 (API).
"""

import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

# Make sibling modules importable regardless of uvicorn's working directory.
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

from graphdb import build_graph, get_driver  # noqa: E402
from llm import generate_rationale            # noqa: E402
from scoring import build_case_contract       # noqa: E402

FRONTEND_DIR = _HERE.parent / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Connect to Neo4j, build the graph, and cache the scored contract.

    If Neo4j is unreachable we still start (so the UI/static layer is testable)
    but the case endpoint reports 503 with the underlying error.
    """
    app.state.contract = None
    app.state.error = None
    driver = None
    try:
        driver = get_driver()
        driver.verify_connectivity()
        report = build_graph(driver)
        contract = build_case_contract(driver, report)
        # Fill the recommendation rationale with a server-side LLM call (Opus 4.8).
        # generate_rationale never raises — it degrades to a deterministic summary.
        text, source = generate_rationale(contract)
        contract["recommendation"]["rationale"] = text
        contract["recommendation"]["rationale_source"] = source
        app.state.contract = contract
    except Exception as exc:  # noqa: BLE001 — keep the app up; report 503 from endpoints
        # Full detail stays server-side (may contain hostnames/URIs); clients
        # only ever see a generic "graph not ready".
        app.state.error = f"{type(exc).__name__}: {exc}"
        print(f"[startup] graph build failed: {app.state.error}", file=sys.stderr)
    try:
        yield
    finally:
        if driver is not None:
            driver.close()


app = FastAPI(title="A_NIRE Case Console", version="0.2.0", lifespan=lifespan)


@app.get("/api/health")
def health() -> dict:
    """Liveness + graph-readiness probe."""
    return {"status": "ok", "slice": 2, "graph_ready": app.state.contract is not None}


@app.get("/api/case/{case_id}")
def get_case(case_id: str) -> dict:
    """Return the scored case contract built from the Neo4j graph."""
    contract = app.state.contract
    if contract is None:
        raise HTTPException(status_code=503, detail="Graph not ready (see server logs)")
    if case_id != contract["case"]["case_id"]:
        raise HTTPException(status_code=404, detail=f"Unknown case '{case_id}'")
    return contract


# Mount the frontend LAST so /api/* routes always win. html=True serves
# index.html at "/". Until the mockup is copied to frontend/index.html, "/"
# returns 404 by design — the API above is the testable surface.
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


if __name__ == "__main__":
    import os

    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))
