"""Central configuration for the A_NIRE backend.

Everything that defines the *rule-based model* lives here so there is one
auditable place for the numbers: the sanctions match cutoff, the per-detector
score weights, and the band thresholds. Detector logic reads these — it never
hardcodes a number inline.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent      # backend/
DATA_DIR = BACKEND_DIR / "data"                    # backend/data/
REPO_ROOT = BACKEND_DIR.parent

# Load repo-root .env (real secrets; gitignored). Safe no-op if absent.
load_dotenv(REPO_ROOT / ".env")

# --- Neo4j connection (from .env; local defaults for dev) ---
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")

# --- Derivation rule: World-Check hit strong enough to derive :Sanctioned ---
SANCTIONS_MATCH_THRESHOLD = 0.85

# --- Rule-based score: per-detector contribution weights ---
# These sum to 0.74 when all three fire — the acceptance-test total.
DETECTOR_WEIGHTS = {
    "circular_flow": 0.30,
    "sanctioned_exposure": 0.28,
    "shell_linkage": 0.16,
}

# --- Band thresholds on the total score ---
BANDS = {"sar": 0.65, "edd": 0.35}  # >=0.65 SAR; 0.35-0.65 EDD; <0.35 clear


def band(total: float) -> str:
    """Map a total score to its recommendation band."""
    if total >= BANDS["sar"]:
        return "SAR"
    if total >= BANDS["edd"]:
        return "EDD"
    return "CLEAR"
