"""Pluggable scoring engines — the seam between evidence and a number.

The separation is deliberate and auditable:

  * **Detection** (scoring.run_detectors, in Cypher) extracts *evidence* — which
    patterns fired, over which entities/txns, with a plain-language explanation.
    Detectors carry NO score; they are pure evidence.
  * **Scoring** (a ScoringEngine here) turns that evidence into a *number*: a
    total, a band, and the per-detector contributions that explain the total.

Today there is one engine — RuleBasedEngine — whose logic is the rule-based model
relocated verbatim from scoring.py (read the configured weights, sum the fired
detectors' weights, band the total). Because every scorer hides behind the same
`score(detectors, graph) -> ScoreResult` interface, a different engine drops in
with NO change to the detectors, the Cypher, the contract shape, or the frontend.
`get_engine()` picks one by name from config.SCORING_ENGINE.

WHY `score` also takes `graph` even though the rule-based engine ignores it: a
future engine (e.g. a centrality- or path-weighted scorer) will want the topology,
and adding the parameter now avoids a breaking interface change later.
"""

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import config


@dataclass
class ScoreResult:
    """The output of a scoring engine — everything the contract's score block needs.

    `components` maps each *fired* detector key to its contribution; the contract
    assembler merges these back onto the detector list (absent key -> 0.0).
    `bands` is the engine-published threshold map so the UI/audit read thresholds
    from the same source that produced the band.
    """

    engine_name: str
    total: float
    band: str
    bands: dict[str, float]
    components: dict[str, float]


@runtime_checkable
class ScoringEngine(Protocol):
    """The stable contract every scorer implements."""

    @property
    def name(self) -> str: ...

    def score(self, detectors: list[dict], graph: dict) -> ScoreResult: ...


class RuleBasedEngine:
    """The deterministic rule-based model — today's behaviour, just behind the seam.

    Each fired detector contributes its configured weight; the total is the sum,
    banded by config.band(). Ignores `graph` (see module docstring on why it's
    still in the signature). This MUST reproduce the acceptance total 0.74 -> SAR.
    """

    name = "rule_based_v1"

    def score(self, detectors: list[dict], graph: dict) -> ScoreResult:
        components = {
            d["key"]: config.DETECTOR_WEIGHTS[d["key"]]
            for d in detectors
            if d["fired"]
        }
        total = round(sum(components.values()), 2)
        return ScoreResult(
            engine_name=self.name,
            total=total,
            band=config.band(total),
            bands=config.BANDS,
            components=components,
        )


class StubEngine:
    """A throwaway scorer that always returns 0.0 / CLEAR.

    It exists only to prove the seam: flip config.SCORING_ENGINE to "stub" and the
    score changes with zero edits to detectors, Cypher, the contract, or the UI.
    """

    name = "stub"

    def score(self, detectors: list[dict], graph: dict) -> ScoreResult:
        return ScoreResult(
            engine_name=self.name,
            total=0.0,
            band=config.band(0.0),
            bands=config.BANDS,
            components={},
        )


# Registry of available engines, keyed by their stable name.
_ENGINES: dict[str, type] = {
    RuleBasedEngine.name: RuleBasedEngine,
    StubEngine.name: StubEngine,
}


def get_engine(name: str | None = None) -> ScoringEngine:
    """Return a scoring engine by name (defaults to config.SCORING_ENGINE)."""
    name = name or config.SCORING_ENGINE
    try:
        return _ENGINES[name]()
    except KeyError:
        raise ValueError(
            f"Unknown scoring engine '{name}'; available: {sorted(_ENGINES)}"
        )
