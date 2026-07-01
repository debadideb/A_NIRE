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
from pydantic import BaseModel, Field

# Make sibling modules importable regardless of uvicorn's working directory.
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import providers                              # noqa: E402
import store                                  # noqa: E402
from graphdb import build_graph, get_driver  # noqa: E402
from llm import generate_rationale            # noqa: E402
from scoring import build_case_contract, build_entity_detail  # noqa: E402

FRONTEND_DIR = _HERE.parent / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Connect to Neo4j, build the graph, and cache the scored contract.

    If Neo4j is unreachable we still start (so the UI/static layer is testable)
    but the case endpoint reports 503 with the underlying error.
    """
    app.state.contract = None
    app.state.error = None
    store.init_db()  # decisions/audit table — independent of Neo4j, so it's always ready
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
        # Co-publish the selected model INSIDE the recommendation so /api/models
        # and /api/case always read it from the same dict and can never disagree
        # about which model is current. Startup uses the configured default.
        _provider, _model, _ready, _ = providers.status()
        contract["recommendation"]["model"] = _model if _ready else None
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


app = FastAPI(title="A_NIRE Case Console", version="0.4.0", lifespan=lifespan)


@app.get("/api/health")
def health() -> dict:
    """Liveness + graph-readiness probe."""
    return {"status": "ok", "slice": 4, "graph_ready": app.state.contract is not None}


@app.get("/api/models")
def list_models() -> dict:
    """The LLM models the UI may offer for the rationale, for the configured provider.

    `models` is the server-side allowlist; `current` is the model behind the
    rationale right now. When no provider is ready (e.g. Ollama down) the list is
    empty and the frontend hides the selector.
    """
    provider, default, ready, _reason = providers.status()
    # `current` (the model behind the cached rationale) is read from the
    # recommendation dict — co-published atomically with the rationale_source in
    # one swap — so it can never skew against /api/case. Falls back to the
    # configured default before the contract is ready.
    current = default if ready else None
    contract = app.state.contract
    if contract is not None:
        current = contract["recommendation"].get("model", current)
    return {
        "provider": provider,
        "ready": ready,
        "default": default if ready else None,
        "current": current,
        "models": providers.available_models() if ready else [],
    }


@app.get("/api/case/{case_id}")
def get_case(case_id: str) -> dict:
    """Return the scored case contract built from the Neo4j graph."""
    contract = app.state.contract
    if contract is None:
        raise HTTPException(status_code=503, detail="Graph not ready (see server logs)")
    if case_id != contract["case"]["case_id"]:
        raise HTTPException(status_code=404, detail=f"Unknown case '{case_id}'")
    return contract


class DecisionIn(BaseModel):
    # Bounded free text — oversize input is rejected with 422 before it reaches
    # SQLite, so a malformed client can't bloat the audit table / responses.
    action: str = Field(max_length=16)
    decided_by: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=2000)


def _require_case(case_id: str) -> dict:
    contract = app.state.contract
    if contract is None:
        raise HTTPException(status_code=503, detail="Graph not ready (see server logs)")
    if case_id != contract["case"]["case_id"]:
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
