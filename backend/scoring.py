"""Detectors (in Cypher), rule-based scoring, and contract assembly.

Three detectors run over the built graph:
  * circular_flow      — a closed :SENT loop of length >= 3 through the subject
  * sanctioned_exposure— subject reaches a :Sanctioned node within a few hops
  * shell_linkage      — subject funds a cluster of >= 2 :Shell entities

Detectors here emit pure *evidence* (which patterns fired, over which entities/
txns) and carry NO score. Turning that evidence into a total + band + per-detector
contributions is the job of a pluggable scoring engine (engine.py), selected by
config.SCORING_ENGINE; build_case_contract() calls it and merges the contributions
back onto the detector list. The contract emitted is the SAME shape slice 1
hardcoded, so the frontend, recommendation, and audit layers do not change. Node
flags/role and edge patterns are DERIVED from graph labels + detector output —
never hand-labelled.
"""

import csv

from config import DATA_DIR
from engine import get_engine
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
    # Pure evidence: no score here. The scoring engine owns `contribution`, which
    # build_case_contract merges back on after scoring.
    return {
        "key": key,
        "name": name,
        "fired": fired,
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

    # Score via the configured engine (detectors are pure evidence). The graph is
    # passed for engines that want topology; the rule-based engine ignores it.
    result = get_engine().score(detectors, {"nodes": nodes, "edges": edges})
    # Merge the engine's per-detector contributions back onto the evidence list,
    # so each detector in the contract carries its share (0.0 if it didn't fire).
    for d in detectors:
        d["contribution"] = result.components.get(d["key"], 0.0)
    total = result.total
    the_band = result.band

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
        "score": {"total": total, "band": the_band, "bands": result.bands,
                  "engine": result.engine_name},
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


# --- Contribution share (ONE definition, reused everywhere) -----------------

def contribution_shares(edges: list[dict], reference_id: str) -> dict[str, dict]:
    """Each edge's share of `reference_id`'s money flow, with its direction.

    The single server-side definition of "contribution %": for the reference
    entity, debit = Σ amounts it SENT (outflows) and credit = Σ amounts it
    RECEIVED (inflows); an edge's share is its amount over the matching base.
    Outflows are "debit", inflows "credit". Returns {edge_id: {"pct", "direction"}}
    for every edge that touches the reference (others are omitted; a base of 0
    yields no entry). The entity endpoint calls this with the queried entity; the
    main-graph slider and the modal will adopt the SAME helper (reference = the
    subject) during frontend wiring — so contribution % has one server-side
    definition rather than one per UI surface.
    """
    debit = sum(e["amount_gbp"] for e in edges if e["source"] == reference_id)
    credit = sum(e["amount_gbp"] for e in edges if e["target"] == reference_id)
    shares: dict[str, dict] = {}
    for e in edges:
        if e["source"] == reference_id and debit:
            shares[e["id"]] = {"pct": 100.0 * e["amount_gbp"] / debit, "direction": "debit"}
        elif e["target"] == reference_id and credit:
            shares[e["id"]] = {"pct": 100.0 * e["amount_gbp"] / credit, "direction": "credit"}
    return shares


# --- Entity detail (backs the double-click modal) ---------------------------

def _csv_by_id(name: str) -> dict[str, dict]:
    """Index a data CSV by its entity_id column."""
    with open(DATA_DIR / name, newline="", encoding="utf-8") as f:
        return {r["entity_id"]: r for r in csv.DictReader(f)}


def build_entity_detail(contract: dict, entity_id: str) -> dict | None:
    """Assemble {kyc, worldcheck|null, risky_paths[]} for one entity.

    No new data: a join over kyc.csv + worldcheck.csv + the already-scored
    contract (whose edges carry the per-txn detector pattern). Returns None when
    the entity has no KYC row, which the route turns into a 404.

    risky_paths = every fired-detector transaction that touches the entity, BOTH
    directions (sent and received), aggregated per (counterparty, direction):
    summed amount, the txn ids, the detector reason(s), and the entity-relative
    contribution % from the shared helper. Clean parties touch no fired txn, so
    their list is empty.
    """
    kyc_row = _csv_by_id("kyc.csv").get(entity_id)
    if kyc_row is None:
        return None
    wc_row = _csv_by_id("worldcheck.csv").get(entity_id)

    kyc = {
        "entity_id": kyc_row["entity_id"],
        "name": kyc_row["name"],
        "entity_type": kyc_row["entity_type"],
        "jurisdiction": kyc_row["jurisdiction"],
        "incorporation_year": (int(kyc_row["incorporation_year"])
                               if kyc_row["incorporation_year"] else None),
        "kyc_status": kyc_row["kyc_status"],
        "registered_address": kyc_row["registered_address"] or None,
    }
    worldcheck = {
        "entity_id": wc_row["entity_id"],
        "source": wc_row["source"],
        "list_name": wc_row["list_name"],
        "category": wc_row["category"],
        "match_strength": float(wc_row["match_strength"]),
        "hit_date": wc_row["hit_date"],
        "screened_name": wc_row["screened_name"],
    } if wc_row else None

    # Which txns are risky, and why. Collect ALL fired-detector names per txn (not
    # just the first) so a txn caught by two detectors keeps both reasons — the
    # endpoint promises the detector reason(s), so none may be dropped.
    reason_by_txn: dict[str, set[str]] = {}
    for d in contract["detectors"]:
        if d["fired"]:
            for t in d["txns"]:
                reason_by_txn.setdefault(t, set()).add(d["name"])

    edges = contract["graph"]["edges"]
    shares = contribution_shares(edges, entity_id)  # direction + % from one source

    # Aggregate per (counterparty, direction). Keying on direction too stays sound
    # even if an entity both sent to and received from the same counterparty (the
    # synthetic data has no such 2-cycle, but the rule must not mix the two).
    agg: dict[tuple, dict] = {}
    for e in edges:
        if e["id"] not in reason_by_txn:
            continue
        sh = shares.get(e["id"])
        if sh is None:                       # edge doesn't touch this entity
            continue
        direction = sh["direction"]
        counterparty = e["target"] if direction == "debit" else e["source"]
        row = agg.setdefault((counterparty, direction), {
            "counterparty": counterparty,
            "direction": direction,
            "reason": set(),
            "txn_ids": [],
            "amount": 0,
            "currency": "GBP",
            "contribution_pct": 0.0,
        })
        row["txn_ids"].append(e["id"])
        row["amount"] += e["amount_gbp"]
        row["reason"].update(reason_by_txn[e["id"]])
        row["contribution_pct"] += sh["pct"]

    risky_paths = []
    for row in agg.values():
        row["reason"] = ", ".join(sorted(row["reason"]))
        row["contribution_pct"] = round(row["contribution_pct"], 1)
        risky_paths.append(row)
    risky_paths.sort(key=lambda r: r["contribution_pct"], reverse=True)  # worst first

    return {"entity_id": entity_id, "kyc": kyc,
            "worldcheck": worldcheck, "risky_paths": risky_paths}
