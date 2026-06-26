"""Detectors (in Cypher), rule-based scoring, and contract assembly.

Three detectors run over the built graph:
  * circular_flow      — a closed :SENT loop of length >= 3 through the subject
  * sanctioned_exposure— subject reaches a :Sanctioned node within a few hops
  * shell_linkage      — subject funds a cluster of >= 2 :Shell entities

Each fired detector contributes its configured weight (config.DETECTOR_WEIGHTS);
the total maps to a band (config.band). The contract emitted by
build_case_contract() is the SAME shape slice 1 hardcoded, so the frontend,
recommendation, and audit layers do not change. Node flags/role and edge
patterns are DERIVED from graph labels + detector output — never hand-labelled.
"""

import csv

from config import BANDS, DATA_DIR, DETECTOR_WEIGHTS, band
from graphdb import DB

# --- Cypher ---------------------------------------------------------------

# Closed loop of >=3 SENT hops back to the subject. *3.. excludes 2-cycles /
# back-and-forth; shortest qualifying loop is returned.
_CIRCULAR = """
MATCH path = (s:Subject)-[:SENT*3..8]->(s)
RETURN [n IN nodes(path) | n.entity_id]      AS ents,
       [r IN relationships(path) | r.txn_id] AS txns,
       [r IN relationships(path) | r.amount_gbp] AS amounts
ORDER BY size(txns)
LIMIT 1
"""

# Shortest directed path from the subject to any sanctioned counterparty.
_SANCTIONED = """
MATCH path = shortestPath((s:Subject)-[:SENT*1..4]->(t:Sanctioned))
RETURN [n IN nodes(path) | n.entity_id]      AS ents,
       [r IN relationships(path) | r.txn_id] AS txns,
       t.entity_id     AS sanctioned_id,
       t.screened_name AS screened,
       t.sanction_list AS list,
       t.sanction_match AS match
LIMIT 1
"""

# Subject funds a shell cluster. Anchor on the registered address(es) the
# subject actually funds INTO, then take only shells at that same address and
# the SENT edges among subject + that anchored cluster. This stops an unrelated
# shell cluster (not subject-funded) from being pulled into the detector.
_SHELL = """
MATCH (s:Subject)-[:SENT]->(entry:Shell)
WITH collect(DISTINCT toLower(trim(entry.registered_address))) AS funded_addrs
MATCH (sh:Shell)
WHERE toLower(trim(sh.registered_address)) IN funded_addrs
WITH collect(DISTINCT sh.entity_id) AS shells
WHERE size(shells) >= 2
MATCH (a:Entity)-[r:SENT]->(b:Entity)
WHERE (a.entity_id IN shells OR b.entity_id IN shells)
  AND (a:Subject OR a.entity_id IN shells)
  AND (b:Subject OR b.entity_id IN shells)
RETURN shells AS ents, collect(DISTINCT r.txn_id) AS txns
"""

# Address of a specific (already-detected) shell, for the explanation text.
_SHELL_ADDR = "MATCH (sh:Entity {entity_id: $sid}) RETURN sh.registered_address AS addr"

_NODES = """
MATCH (e:Entity)
RETURN e.entity_id AS id, e.name AS label, e.type AS type,
       e.jurisdiction AS jurisdiction, e.kyc_status AS kyc_status,
       labels(e) AS labels
ORDER BY e.entity_id
"""

_EDGES = """
MATCH (a:Entity)-[r:SENT]->(b:Entity)
RETURN r.txn_id AS id, a.entity_id AS source, b.entity_id AS target,
       r.amount_gbp AS amount_gbp, r.txn_date AS txn_date, r.channel AS channel
ORDER BY r.txn_id
"""


def _records(driver, cypher, **params) -> list[dict]:
    return [r.data() for r in driver.execute_query(cypher, database_=DB, **params).records]


def _gbp(n) -> str:
    return f"£{int(n):,}"


# --- Detectors ------------------------------------------------------------

def run_detectors(driver) -> list[dict]:
    """Run all three detectors; return one result dict each (worst weight first)."""
    results = []

    # Circular flow
    rows = _records(driver, _CIRCULAR)
    if rows:
        ents = rows[0]["ents"]
        if len(ents) > 1 and ents[0] == ents[-1]:
            ents = ents[:-1]                      # drop the closing duplicate
        txns = rows[0]["txns"]
        amounts = rows[0]["amounts"]
        loop = "→".join(ents + [ents[0]])
        results.append(_result(
            "circular_flow", "Circular flow", True, ents, txns,
            f"Funds left the subject and returned through a closed loop {loop} "
            f"({_gbp(amounts[0])} out, {_gbp(amounts[-1])} back), a classic "
            f"layering signature. Cycle length {len(ents)} (≥3).",
        ))
    else:
        results.append(_result("circular_flow", "Circular flow", False, [], [],
                               "No closed loop of length ≥3 through the subject."))

    # Sanctioned exposure
    rows = _records(driver, _SANCTIONED)
    if rows:
        r = rows[0]
        ents, txns = r["ents"], r["txns"]
        results.append(_result(
            "sanctioned_exposure", "Sanctioned exposure", True, ents, txns,
            f"The subject is {len(txns)} hop(s) from a sanctioned counterparty: "
            f"{'→'.join(ents)} — {r['sanctioned_id']} ({r['screened']}) is a "
            f"{r['list']} World-Check hit at match strength {r['match']}.",
        ))
    else:
        results.append(_result("sanctioned_exposure", "Sanctioned exposure", False, [], [],
                               "No path from the subject to a sanctioned node."))

    # Shell linkage
    rows = _records(driver, _SHELL)
    if rows:
        ents, txns = rows[0]["ents"], rows[0]["txns"]
        addr_rows = _records(driver, _SHELL_ADDR, sid=ents[0])
        addr = addr_rows[0]["addr"] if addr_rows else "a shared address"
        results.append(_result(
            "shell_linkage", "Shell linkage", True, ents, txns,
            f"The subject funds a cluster of {len(ents)} nominee-managed companies "
            f"({', '.join(ents)}) that all share one registered address ({addr}) "
            f"— a shell-company pattern.",
        ))
    else:
        results.append(_result("shell_linkage", "Shell linkage", False, [], [],
                               "No subject-funded cluster of ≥2 shells."))

    return results


def _result(key, name, fired, entities, txns, explanation) -> dict:
    return {
        "key": key,
        "name": name,
        "fired": fired,
        "contribution": DETECTOR_WEIGHTS[key] if fired else 0.0,
        "entities": entities,
        "txns": txns,
        "explanation": explanation,
    }


# --- Contract assembly ----------------------------------------------------

def _case_meta() -> dict:
    with open(DATA_DIR / "cases.csv", newline="", encoding="utf-8") as f:
        c = next(csv.DictReader(f))
    return {
        "case_id": c["case_id"],
        "subject_entity_id": c["subject_entity_id"],
        "trigger_code": c["trigger_code"],
        "trigger_desc": c["trigger_desc"],
        "created_at": c["created_at"],
    }


def _role(node_id, flags, circular_ents, sanctioned_ents) -> str:
    if flags["subject"]:
        return "subject"
    if flags["sanctioned"]:
        return "sanctioned"
    if flags["shell"]:
        return "shell"
    if node_id in circular_ents:
        return "layering"
    if node_id in sanctioned_ents:
        return "intermediary"
    return "counterparty"


def build_case_contract(driver, build_report: dict) -> dict:
    """Assemble the full case contract from the graph + detector results."""
    detectors = run_detectors(driver)
    by_key = {d["key"]: d for d in detectors}

    circular_ents = set(by_key["circular_flow"]["entities"])
    sanctioned_ents = set(by_key["sanctioned_exposure"]["entities"])

    # Map each txn id to the (single) detector pattern it belongs to.
    txn_pattern = {}
    for key, pat in (("circular_flow", "circular"),
                     ("sanctioned_exposure", "sanctioned"),
                     ("shell_linkage", "shell")):
        for t in by_key[key]["txns"]:
            txn_pattern.setdefault(t, pat)

    # Nodes
    nodes = []
    kyc_by_id = {}
    for n in _records(driver, _NODES):
        labels = set(n["labels"])
        flags = {
            "subject": "Subject" in labels,
            "sanctioned": "Sanctioned" in labels,
            "shell": "Shell" in labels,
        }
        kyc_by_id[n["id"]] = n["kyc_status"]
        nodes.append({
            "id": n["id"],
            "label": n["label"],
            "type": n["type"],
            "jurisdiction": n["jurisdiction"],
            "kyc_status": n["kyc_status"],
            "role": _role(n["id"], flags, circular_ents, sanctioned_ents),
            "flags": flags,
        })

    # Edges
    edges = [{
        "id": e["id"],
        "source": e["source"],
        "target": e["target"],
        "amount_gbp": e["amount_gbp"],
        "txn_date": e["txn_date"],
        "channel": e["channel"],
        "pattern": txn_pattern.get(e["id"]),
    } for e in _records(driver, _EDGES)]

    # Score + band
    total = round(sum(d["contribution"] for d in detectors), 2)
    the_band = band(total)

    # Source-integration badges (derived counts).
    layering_chain = any(kyc_by_id.get(eid) == "thin_file" for eid in circular_ents)
    kyc_clusters = (1 if by_key["shell_linkage"]["fired"] else 0) + (1 if layering_chain else 0)
    oon = build_report["out_of_network"]
    sources = [
        {"key": "world_check", "label": "World-Check", "count": len(build_report["sanctioned"]),
         "detail": "in-network sanctions hit(s) → derives :Sanctioned"},
        {"key": "tm", "label": "TM", "count": len(by_key["circular_flow"]["txns"]),
         "detail": "transaction-monitoring legs in the circular flow"},
        {"key": "kyc", "label": "KYC", "count": kyc_clusters,
         "detail": "KYC-derived risk clusters (nominee shells + thin-file layering chain)"},
        {"key": "watchlist", "label": "Watchlist", "count": 0,
         "detail": f"{len(oon['watchlist'])} screening row(s) but 0 in-network (out-of-network)"},
    ]

    fired_names = [d["name"].lower() for d in detectors if d["fired"]]
    case = _case_meta()
    case["subject_name"] = next((n["label"] for n in nodes if n["flags"]["subject"]), None)
    return {
        "case": case,
        "graph": {"nodes": nodes, "edges": edges},
        "detectors": detectors,
        "score": {"total": total, "band": the_band, "bands": BANDS},
        "recommendation": {
            "action": the_band,
            "headline": _headline(the_band),
            "rationale": (
                "PLACEHOLDER rationale (LLM-generated text arrives in slice 3). "
                f"Score {total} -> {the_band}"
                + (f", driven by {', '.join(fired_names)}." if fired_names else ".")
            ),
            "rationale_source": "placeholder",
        },
        "sources": sources,
    }


def _headline(the_band: str) -> str:
    return {
        "SAR": "File a Suspicious Activity Report (SAR)",
        "EDD": "Escalate to Enhanced Due Diligence (EDD)",
        "CLEAR": "No action — clear the alert",
    }[the_band]
