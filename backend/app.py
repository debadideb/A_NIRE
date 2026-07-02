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

import csv
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# Make sibling modules importable regardless of uvicorn's working directory.
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import providers                              # noqa: E402
import store                                  # noqa: E402
from config import DATA_DIR                   # noqa: E402
from graphdb import DB, build_graph, get_driver  # noqa: E402
from llm import generate_rationale            # noqa: E402
from scoring import build_case_contract, build_entity_detail, build_graph_view  # noqa: E402

FRONTEND_DIR = _HERE.parent / "frontend"

# Graph time-window control: how far back from the dataset's most recent day each
# duration option reaches (edges carry an ordinal `day`). "12m" is served as the
# full network (minday=None), so it exactly equals the cached contract graph.
WINDOW_DAYS = {"1m": 30, "3m": 91, "6m": 182, "12m": 365}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Connect to Neo4j, build the graph once, and cache a scored contract per case.

    Five cases share one graph. Every contract is built at startup (fast — no
    LLM); the recommendation rationale is generated lazily on first view (see
    _ensure_rationale) so boot stays quick and a slow/unreachable LLM provider
    can't block it. If Neo4j is unreachable we still start (the UI/static layer
    stays testable) but the case endpoints report 503 with the underlying error.
    """
    app.state.contracts = None
    app.state.error = None
    app.state.driver = None          # kept for the windowed-graph endpoint
    app.state.as_of_day = None       # dataset's most recent ordinal day (window anchor)
    store.init_db()  # decisions/audit table — independent of Neo4j, so it's always ready
    driver = None
    try:
        driver = get_driver()
        driver.verify_connectivity()
        report = build_graph(driver)
        with open(DATA_DIR / "cases.csv", newline="", encoding="utf-8") as f:
            cases = list(csv.DictReader(f))
        app.state.contracts = {
            c["case_id"]: build_case_contract(driver, report, c) for c in cases
        }
        # Anchor the duration windows on the latest transaction in the dataset, so
        # "last 1 month" means the month ending at the most recent activity.
        rows = driver.execute_query(
            "MATCH ()-[r:SENT]->() RETURN max(r.day) AS d", database_=DB).records
        app.state.driver = driver
        app.state.as_of_day = rows[0]["d"] if rows else None
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


# Short timeout on the lazy/startup rationale path so an unreachable provider
# degrades to the deterministic fallback fast; the interactive regenerate
# endpoint uses a generous timeout instead (the analyst is actively waiting).
_RATIONALE_TIMEOUT = 12.0


def _ensure_rationale(contract: dict) -> None:
    """Generate + cache the recommendation rationale on first access (lazy).

    Kept out of startup so boot stays fast. Publishes atomically (a fresh
    recommendation dict swapped in with one assignment), exactly like
    regenerate_rationale, so readers never see a torn rationale/source pair.
    """
    rec = contract["recommendation"]
    if rec.get("rationale_source") != "placeholder":
        return
    text, source = generate_rationale(contract, timeout=_RATIONALE_TIMEOUT)
    _provider, model, ready, _ = providers.status()
    new_rec = dict(rec)
    new_rec["rationale"] = text
    new_rec["rationale_source"] = source
    new_rec["model"] = model if ready else None
    contract["recommendation"] = new_rec


app = FastAPI(title="A_NIRE Case Console", version="0.4.0", lifespan=lifespan)


@app.get("/api/health")
def health() -> dict:
    """Liveness + graph-readiness probe."""
    contracts = app.state.contracts
    return {"status": "ok", "slice": 4, "graph_ready": contracts is not None,
            "cases": sorted(contracts) if contracts else []}


@app.get("/api/models")
def list_models() -> dict:
    """The LLM models the UI may offer for the rationale, for the configured provider.

    `models` is the server-side allowlist; `current` is the model behind the
    rationale right now. When no provider is ready (e.g. Ollama down) the list is
    empty and the frontend hides the selector.
    """
    provider, default, ready, _reason = providers.status()
    # `current` is the configured default model. The rationale model is now
    # co-published per case inside each contract's recommendation (the frontend
    # reads it from /api/case), since five cases can each be regenerated on a
    # different model — so this global endpoint reports the default, not a single
    # case's choice.
    return {
        "provider": provider,
        "ready": ready,
        "default": default if ready else None,
        "current": default if ready else None,
        "models": providers.available_models() if ready else [],
    }


@app.get("/api/case/{case_id}")
def get_case(case_id: str) -> dict:
    """Return the scored case contract built from the Neo4j graph."""
    contract = _require_case(case_id)
    _ensure_rationale(contract)  # generate the LLM rationale on first view (cached)
    return contract


@app.get("/api/case/{case_id}/graph")
def get_case_graph(case_id: str, window: str = "12m") -> dict:
    """Time-windowed {nodes, edges} for the case network (graph-view control only).

    A view over the SAME cached detectors — the score/recommendation are NOT
    recomputed, so the full-case assessment (and the acceptance test) is untouched.
    `window` in 1m/3m/6m/12m; 12m is the full network (equals the contract graph).
    """
    contract = _require_case(case_id)
    if window not in WINDOW_DAYS:
        raise HTTPException(status_code=400,
                            detail=f"window must be one of {sorted(WINDOW_DAYS)}")
    sid = contract["case"]["subject_entity_id"]
    minday = (None if window == "12m" or app.state.as_of_day is None
              else app.state.as_of_day - WINDOW_DAYS[window])
    view = build_graph_view(app.state.driver, contract["detectors"], sid, minday)
    return {"window": window, "as_of_day": app.state.as_of_day, **view}


class DecisionIn(BaseModel):
    # Bounded free text — oversize input is rejected with 422 before it reaches
    # SQLite, so a malformed client can't bloat the audit table / responses.
    action: str = Field(max_length=16)
    decided_by: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=2000)


def _require_case(case_id: str) -> dict:
    contracts = app.state.contracts
    if contracts is None:
        raise HTTPException(status_code=503, detail="Graph not ready (see server logs)")
    contract = contracts.get(case_id)
    if contract is None:
        raise HTTPException(status_code=404, detail=f"Unknown case '{case_id}'")
    return contract


def _audit(case_id: str, contract: dict) -> dict:
    """The audited decision trail: the system recommendation + every analyst decision."""
    # Capture the recommendation dict by reference ONCE: regeneration swaps it in
    # atomically (see regenerate_rationale), so every field read here comes from a
    # single consistent dict — never a torn rationale/rationale_source pair.
    rec, score = contract["recommendation"], contract["score"]
    return {
        "recommendation": {
            "action": rec["action"],
            "headline": rec["headline"],
            "score": score["total"],
            "band": score["band"],
            "engine": score.get("engine"),
            "rationale_source": rec["rationale_source"],
        },
        "decisions": store.list_decisions(case_id),
    }


@app.post("/api/case/{case_id}/decision")
def post_decision(case_id: str, body: DecisionIn) -> dict:
    """Capture an analyst's SAR/EDD/CLEAR decision (append-only) and return the trail."""
    contract = _require_case(case_id)
    action = (body.action or "").strip().upper()
    if action not in {"SAR", "EDD", "CLEAR"}:
        raise HTTPException(status_code=422, detail="action must be SAR, EDD, or CLEAR")
    decided_by = (body.decided_by or "").strip() or "analyst"
    notes = (body.notes or "").strip()
    # Capture the recommendation by reference once — regeneration swaps it
    # atomically — so the decision records a self-consistent score + source.
    rec, score = contract["recommendation"], contract["score"]
    row = store.record_decision(
        case_id, action, decided_by, notes,
        score["total"], score["band"], rec["rationale_source"],
        score.get("engine"),  # name the scorer the analyst acted on
    )
    return {"decision": row, "audit": _audit(case_id, contract)}


class RationaleIn(BaseModel):
    # Bounded; validated against the allowlist below before any provider call.
    model: str = Field(max_length=80)


@app.post("/api/case/{case_id}/rationale")
def regenerate_rationale(case_id: str, body: RationaleIn) -> dict:
    """Re-run the recommendation rationale on a different (allow-listed) model.

    This backs the UI model selector. The chosen model must be in
    providers.available_models() — so an arbitrary string can't be forwarded to
    the provider — then we regenerate, update the cached contract (so /api/case
    and the audit reflect the current model), and return the new text.
    """
    contract = _require_case(case_id)
    model = (body.model or "").strip()
    if model not in providers.available_models():
        raise HTTPException(status_code=422, detail="Unknown or unavailable model")
    # Generous timeout: the analyst is actively waiting, and a freshly selected
    # local model may need to load several GB before its first token.
    text, source = generate_rationale(contract, model=model, timeout=120.0)
    # Publish atomically: build a fresh recommendation dict and swap it in with a
    # single assignment. A dict item-set is atomic under the GIL, so every reader
    # — the /api/case serializer (which runs AFTER this returns), _audit, and
    # post_decision — sees the old or the new recommendation WHOLE, never a torn
    # rationale/rationale_source pair. That is why no lock is needed even though
    # sync endpoints share a threadpool; concurrent regenerations just last-win.
    new_rec = dict(contract["recommendation"])
    new_rec["rationale"] = text
    new_rec["rationale_source"] = source
    new_rec["model"] = model  # co-published, so /api/models can't skew vs source
    contract["recommendation"] = new_rec
    return {"model": model, "rationale": text, "rationale_source": source}


@app.get("/api/case/{case_id}/audit")
def get_audit(case_id: str) -> dict:
    """The audited decision trail for a case."""
    contract = _require_case(case_id)
    return _audit(case_id, contract)


@app.get("/api/case/{case_id}/entity/{entity_id}")
def get_entity(case_id: str, entity_id: str) -> dict:
    """Entity detail for the double-click modal: KYC + World-Check + risky paths."""
    contract = _require_case(case_id)
    detail = build_entity_detail(contract, entity_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Unknown entity '{entity_id}'")
    return detail


# Mount the frontend LAST so /api/* routes always win. html=True serves
# index.html at "/". Until the mockup is copied to frontend/index.html, "/"
# returns 404 by design — the API above is the testable surface.
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


if __name__ == "__main__":
    import os

    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))
