"""Central configuration for the A_NIRE backend.

Everything that defines the *rule-based model* lives here so there is one
auditable place for the numbers: the derivation cutoffs (what makes a
World-Check hit a :Sanctioned node, which jurisdictions count as high-risk /
offshore), the per-detector thresholds, the per-detector score weights, and the
band thresholds. Detector logic reads these — it never hardcodes a number inline.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent      # backend/
DATA_DIR = BACKEND_DIR / "data"                    # backend/data/
REPO_ROOT = BACKEND_DIR.parent

# SQLite store for decisions + audit trail (gitignored via *.db).
DB_PATH = BACKEND_DIR / "anire.db"

# Load repo-root .env (real secrets; gitignored). Safe no-op if absent.
load_dotenv(REPO_ROOT / ".env")

# --- Neo4j connection (from .env; local defaults for dev) ---
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")

# --- Derivation rules (raw attribute -> derived label/flag) ------------------
# :Sanctioned is derived from a World-Check hit that is a CONFIRMED sanctions
# match at or above this score (match_score is 0-100 in the current schema).
SANCTIONS_CATEGORY = "Sanctions"
SANCTIONS_STATUS = "Confirmed"
SANCTIONS_MIN_SCORE = 85

# Jurisdictions that make an outbound flow "high-risk" (sanctioned regimes +
# secrecy/offshore havens). OFFSHORE is the subset used to derive shell risk
# (a shell cluster is offshore-incorporated companies sharing a beneficial owner).
HIGH_RISK_JURISDICTIONS = {"IR", "SY", "RU", "KP", "KY", "VG", "PA", "SC", "CY", "AE"}
OFFSHORE_JURISDICTIONS = {"VG", "KY", "PA", "SC", "CY"}

# --- Detector thresholds (what it takes for each typology to fire) -----------
# high_risk_outbound: N debits to a high-risk jurisdiction at/above this value.
HIGH_VALUE_GBP = 150_000
HIGH_RISK_OUTBOUND_MIN_COUNT = 10
# structuring: many debits just under a reporting threshold to ONE counterparty,
# clustered in time (structuring is *rapid* — spreading the same count over a year
# is ordinary trading, so the near-threshold debits must fall within this window).
STRUCTURING_BAND = (8_000, 10_000)
STRUCTURING_MIN_COUNT = 15
STRUCTURING_WINDOW_DAYS = 45
# circular_flow: matched reciprocal round-trips (send £X, get £~X back soon).
# tol/window are tight enough that only genuinely-matched pairs qualify — random
# debit/credit coincidences in the background stay in single digits (measured),
# while a real layering loop produces >100, so min-count 10 separates cleanly.
ROUNDTRIP_TOLERANCE = 0.02          # |sent-returned| / sent
ROUNDTRIP_WINDOW_DAYS = 5
CIRCULAR_MIN_COUNT = 10
# shell_linkage: subject funds >= this many offshore cps sharing a beneficial owner.
SHELL_MIN_CLUSTER = 3

# --- Multi-hop traversal bounds (the network is now a k-hop graph) ----------
# How deep a detector will walk out from the subject. The generated tree is
# k=3 deep; these give a little headroom for planted paths/loops.
SANCTIONED_MAX_HOP = 4     # subject -> ... -> :Sanctioned within this many hops
SHELL_MAX_HOP = 4          # subject funds an offshore cluster within this many hops
CIRCULAR_MAX_LEN = 8       # longest closed loop (in edges) the cycle search considers

# --- Rule-based score: per-detector contribution weights --------------------
# One number per typology, ordered by severity. A single typology lands in EDD
# (escalate); a second corroborating typology pushes the case into SAR (file).
# See CLAUDE.md ACCEPTANCE for the resulting per-case totals.
DETECTOR_WEIGHTS = {
    "sanctioned_exposure": 0.40,
    "circular_flow": 0.38,
    "shell_linkage": 0.37,
    "high_risk_outbound": 0.36,
    "structuring": 0.36,
}

# --- Band thresholds on the total score ---
BANDS = {"sar": 0.65, "edd": 0.35}  # >=0.65 SAR; 0.35-0.65 EDD; <0.35 clear

# --- Scoring engine selection ---
# Which scorer turns detector evidence into the total/band (see engine.py).
# Default reproduces the documented per-case acceptance; override via env to swap
# in another engine (e.g. SCORING_ENGINE=stub) with no other code changes.
SCORING_ENGINE = os.getenv("SCORING_ENGINE", "rule_based_v1")


def band(total: float) -> str:
    """Map a total score to its recommendation band."""
    if total >= BANDS["sar"]:
        return "SAR"
    if total >= BANDS["edd"]:
        return "EDD"
    return "CLEAR"
