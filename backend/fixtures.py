"""Hardcoded case contract for build slice 1.

This is the JSON shape the frontend consumes. It is intentionally a static
fixture: slice 1's only goal is to lock the API contract and prove the
frontend can fetch it end-to-end. In slice 2 this whole module is replaced by
a real Neo4j build + scoring pass that emits the SAME shape, so nothing
downstream (frontend, recommendation, audit) has to change.

Design-principle discipline, even in the fixture: a node's risk `flags` and
its display `role` are NOT stored as per-node label columns — they are derived
purely from the ID sets (_SUBJECT/_SANCTIONED/_SHELL) and from edge-pattern
membership (which detector an edge belongs to). The only hand-authored node
fields are genuinely raw attributes (name, type, jurisdiction, kyc_status).
That keeps the "derive, never label" rule honest and gives slice 2 no
label-leak path to inherit.

The values here are transcribed from backend/data/*.csv and MUST satisfy the
acceptance test: circular 0.30 + sanctioned 0.28 + shell 0.16 = 0.74 -> SAR,
with E010-E015 silent. If you change a number here, change it in the detectors
in slice 2 too -- this fixture is a stand-in for those detectors, not a
separate source of truth.
"""

# Score band thresholds (single source of truth for the contract).
BANDS = {"sar": 0.65, "edd": 0.35}  # >=0.65 SAR; 0.35-0.65 EDD; <0.35 clear


def _band(total: float) -> str:
    if total >= BANDS["sar"]:
        return "SAR"
    if total >= BANDS["edd"]:
        return "EDD"
    return "CLEAR"


# --- Derived-risk ID sets (stand-ins for slice-2 detector output). These, plus
# edge patterns below, are the ONLY source of a node's flags and role. ---
_SUBJECT = "E001"               # from cases.csv.subject_entity_id
_SANCTIONED = {"E006"}          # World-Check hit >= 0.85 -> :Sanctioned
_SHELL = {"E007", "E008", "E009"}  # nominee + shared registered_address

# --- Nodes: one per kyc.csv row. Only raw attributes are stored here. ---
_NODES = [
    # id,    label,                     type,      jurisdiction,             kyc_status
    ("E001", "Tradewind Commerce Ltd",  "company", "United Kingdom",         "verified"),
    ("E002", "Layer Co 1",              "company", "Cyprus",                 "thin_file"),
    ("E003", "Layer Co 2",              "company", "Malta",                  "thin_file"),
    ("E004", "Layer Co 3",              "company", "Cyprus",                 "thin_file"),
    ("E005", "Meridian Payment Agents", "agent",   "United Arab Emirates",   "verified"),
    ("E006", "Volta Trading FZE",       "company", "Marshall Islands",       "none"),
    ("E007", "Azure Crest Holdings",    "company", "British Virgin Islands", "nominee"),
    ("E008", "Brightwater Ventures",    "company", "Seychelles",             "nominee"),
    ("E009", "Cobalt Harbour Capital",  "company", "Seychelles",             "nominee"),
    ("E010", "Acme Supplies Co",        "company", "United Kingdom",         "verified"),
    ("E011", "City Bank plc",           "bank",    "United Kingdom",         "verified"),
    ("E012", "Northwind Logistics Ltd", "company", "United Kingdom",         "verified"),
    ("E013", "Meridian Freight GmbH",   "company", "Germany",                "verified"),
    ("E014", "Harbour Insurance Ltd",   "company", "United Kingdom",         "verified"),
    ("E015", "Sterling Metals Ltd",     "company", "United Kingdom",         "verified"),
]

# --- Edges: one per transactions.csv row. `pattern` tags which detector the
# edge participates in (stand-in for detector output); None = clean. ---
_EDGES = [
    # txn,  from,   to,     amount,  date,         pattern
    ("T001", "E001", "E002", 325000, "2026-04-02", "circular"),
    ("T002", "E002", "E003", 322000, "2026-04-05", "circular"),
    ("T003", "E003", "E004", 320000, "2026-04-09", "circular"),
    ("T004", "E004", "E001", 318000, "2026-04-14", "circular"),
    ("T005", "E001", "E005", 612000, "2026-03-20", "sanctioned"),
    ("T006", "E005", "E006", 598000, "2026-03-24", "sanctioned"),
    ("T007", "E001", "E007", 120000, "2026-04-22", "shell"),
    ("T008", "E007", "E008", 40000,  "2026-04-25", "shell"),
    ("T009", "E007", "E009", 38000,  "2026-04-26", "shell"),
    ("T010", "E010", "E001", 180000, "2026-03-15", None),
    ("T011", "E001", "E011", 95000,  "2026-03-28", None),
    ("T012", "E001", "E012", 45000,  "2026-04-18", None),
    ("T013", "E013", "E001", 62000,  "2026-03-30", None),
    ("T014", "E001", "E014", 8000,   "2026-04-10", None),
    ("T015", "E015", "E001", 74000,  "2026-04-03", None),
]


def _entities_in_pattern(pattern: str) -> set:
    """Endpoints of every edge tagged with `pattern` (derived from _EDGES)."""
    out = set()
    for _tid, src, tgt, _amt, _date, pat in _EDGES:
        if pat == pattern:
            out.update((src, tgt))
    return out


_CIRCULAR_ENTS = _entities_in_pattern("circular")        # E001-E004
_SANCTIONED_PATH_ENTS = _entities_in_pattern("sanctioned")  # E001, E005, E006


def _role(nid: str) -> str:
    """Display role, derived (never hand-labeled). Risk roles win first."""
    if nid == _SUBJECT:
        return "subject"
    if nid in _SANCTIONED:
        return "sanctioned"
    if nid in _SHELL:
        return "shell"
    if nid in _CIRCULAR_ENTS:
        return "layering"      # non-subject leg of the circular flow
    if nid in _SANCTIONED_PATH_ENTS:
        return "intermediary"  # hop between subject and sanctioned node
    return "counterparty"      # not in any detector pattern (e.g. E010-E015)


def _node(nid, label, ntype, juris, kyc):
    return {
        "id": nid,
        "label": label,
        "type": ntype,
        "jurisdiction": juris,
        "kyc_status": kyc,
        "role": _role(nid),
        "flags": {
            "subject": nid == _SUBJECT,
            "sanctioned": nid in _SANCTIONED,
            "shell": nid in _SHELL,
        },
    }


def _edge(tid, src, tgt, amount, date, pattern):
    return {
        "id": tid,
        "source": src,
        "target": tgt,
        "amount_gbp": amount,
        "txn_date": date,
        "channel": "wire",
        "pattern": pattern,
    }


# --- Detectors: hardcoded results matching the acceptance test. ---
_DETECTORS = [
    {
        "key": "circular_flow",
        "name": "Circular flow",
        "fired": True,
        "contribution": 0.30,
        "entities": ["E001", "E002", "E003", "E004"],
        "txns": ["T001", "T002", "T003", "T004"],
        "explanation": (
            "Funds left the subject and returned through a closed loop "
            "E001→E002→E003→E004→E001 (£325k out, £318k back in 12 days), "
            "a classic layering signature. Cycle length 4 (≥3)."
        ),
    },
    {
        "key": "sanctioned_exposure",
        "name": "Sanctioned exposure",
        "fired": True,
        "contribution": 0.28,
        "entities": ["E001", "E005", "E006"],
        "txns": ["T005", "T006"],
        "explanation": (
            "The subject is two hops from a sanctioned counterparty: "
            "E001→E005 (payment agent)→E006 (Volta Trading FZE), which is an OFAC SDN "
            "World-Check hit at match strength 0.95."
        ),
    },
    {
        "key": "shell_linkage",
        "name": "Shell linkage",
        "fired": True,
        "contribution": 0.16,
        "entities": ["E007", "E008", "E009"],
        "txns": ["T007", "T008", "T009"],
        "explanation": (
            "The subject funds a cluster of three nominee-managed companies "
            "(E007, E008, E009) that all share one registered address "
            "(Suite 4B, Ocean Plaza, Victoria, Mahé) — a shell-company pattern."
        ),
    },
]

_TOTAL = round(sum(d["contribution"] for d in _DETECTORS if d["fired"]), 2)  # 0.74

# --- Source-integration summary (case-header badges). ---
_SOURCES = [
    {"key": "world_check", "label": "World-Check", "count": 1,
     "detail": "1 sanctions hit (E006, OFAC SDN @ 0.95) → derives :Sanctioned"},
    {"key": "tm", "label": "TM", "count": 4,
     "detail": "4 transaction-monitoring legs forming the circular flow (T001–T004)"},
    {"key": "kyc", "label": "KYC", "count": 2,
     "detail": "2 KYC-derived risk clusters: nominee shell cluster + thin-file layering chain"},
    {"key": "watchlist", "label": "Watchlist", "count": 0,
     "detail": "2 screening rows (E090, E091) but 0 in-network — out-of-network, source integrated"},
]

HARDCODED_CASE = {
    "case": {
        "case_id": "CASE-2026-0001",
        "subject_entity_id": "E001",
        "subject_name": "Tradewind Commerce Ltd",
        "trigger_code": "TM-771",
        "trigger_desc": "High-value outbound to high-risk jurisdiction",
        "created_at": "2026-05-20T09:31:00",
    },
    "graph": {
        "nodes": [_node(*n) for n in _NODES],
        "edges": [_edge(*e) for e in _EDGES],
    },
    "detectors": _DETECTORS,
    "score": {
        "total": _TOTAL,
        "band": _band(_TOTAL),
        "bands": BANDS,
    },
    "recommendation": {
        "action": _band(_TOTAL),  # "SAR"
        "headline": "File a Suspicious Activity Report (SAR)",
        "rationale": (
            "PLACEHOLDER rationale (LLM-generated text arrives in slice 3). "
            "Score 0.74 crosses the SAR threshold (≥0.65), driven by a circular "
            "flow, two-hop sanctioned exposure, and a nominee shell cluster."
        ),
        "rationale_source": "placeholder",
    },
    "sources": _SOURCES,
}
