"""Detectors (in Cypher), rule-based scoring, and contract assembly.

Five detectors run over the built graph, each scoped to one case subject's
ego-network (every :SENT edge carrying that subject_id):

  * sanctioned_exposure — subject sends to a :Sanctioned counterparty
  * high_risk_outbound  — many high-value debits to high-risk jurisdictions
  * structuring         — many debits just under a reporting threshold to one cp
  * circular_flow       — matched reciprocal round-trips (send £X, get £~X back)
  * shell_linkage       — subject funds >=N offshore cps sharing a beneficial owner

Detectors here emit pure *evidence* (which patterns fired, over which entities/
txns, with a plain-language explanation) and carry NO score. Turning evidence
into a total + band + per-detector contributions is the job of a pluggable
scoring engine (engine.py), selected by config.SCORING_ENGINE. Node roles/flags
and edge patterns are DERIVED from graph labels + detector output — never
hand-labelled in the data.
"""

import csv

import config
from config import DATA_DIR
from engine import get_engine
from graphdb import DB

# Detector key -> the edge/factor "pattern" category the frontend colours by,
# in descending severity (used to pick one pattern when a cp is in several).
PATTERN = {
    "sanctioned_exposure": "sanctioned",
    "circular_flow": "circular",
    "shell_linkage": "shell",
    "high_risk_outbound": "high_risk",
    "structuring": "structuring",
}
_SEVERITY = list(PATTERN.keys())  # order = severity


def _records(driver, cypher, **params) -> list[dict]:
    return [r.data() for r in driver.execute_query(cypher, database_=DB, **params).records]


def _gbp(n) -> str:
    return f"£{int(round(n or 0)):,}"


def _result(key, name, fired, entities, txns, explanation) -> dict:
    # Pure evidence: no score here. The engine owns `contribution`, which
    # build_case_contract merges back on after scoring.
    return {"key": key, "name": name, "fired": fired,
            "entities": entities, "txns": txns, "explanation": explanation}


# --- Detectors (all scoped to $sid; edges carry subject_id) ------------------

def run_detectors(driver, sid: str) -> list[dict]:
    """Run all five detectors for one subject; return one result dict each."""
    return [
        _sanctioned(driver, sid),
        _circular(driver, sid),
        _shell(driver, sid),
        _high_risk_outbound(driver, sid),
        _structuring(driver, sid),
    ]


def _sanctioned(driver, sid) -> dict:
    rows = _records(driver, """
        MATCH (s:Entity {entity_id:$sid})-[r:SENT {subject_id:$sid, direction:'D'}]->(t:Sanctioned)
        RETURN collect(DISTINCT t.entity_id) AS ids,
               collect(DISTINCT t.screened_name) AS names,
               collect(DISTINCT t.sanction_list) AS lists,
               max(t.sanction_match) AS score, sum(r.amount) AS total,
               count(r) AS n, collect(r.key)[..80] AS txns
    """, sid=sid)
    r = rows[0] if rows else {}
    ids = r.get("ids") or []
    if ids:
        return _result(
            "sanctioned_exposure", "Sanctioned exposure", True, [sid] + ids, r["txns"],
            f"The subject sent {_gbp(r['total'])} across {r['n']} transaction(s) to "
            f"{len(ids)} sanctioned counterparty(ies) — {', '.join(r['names'])} "
            f"({', '.join(l for l in r['lists'] if l)} hit, match score {int(r['score'])}).",
        )
    return _result("sanctioned_exposure", "Sanctioned exposure", False, [], [],
                   "No payments from the subject to a sanctioned counterparty.")


def _high_risk_outbound(driver, sid) -> dict:
    rows = _records(driver, """
        MATCH (s:Entity {entity_id:$sid})-[r:SENT {subject_id:$sid, direction:'D'}]->(c)
        WHERE r.amount >= $hv AND r.benef_country IN $hr
        RETURN count(r) AS n, sum(r.amount) AS total,
               collect(DISTINCT c.entity_id) AS cps,
               collect(DISTINCT r.benef_country) AS countries,
               collect(r.key)[..80] AS txns
    """, sid=sid, hv=config.HIGH_VALUE_GBP, hr=list(config.HIGH_RISK_JURISDICTIONS))
    r = rows[0] if rows else {}
    n = r.get("n") or 0
    if n >= config.HIGH_RISK_OUTBOUND_MIN_COUNT:
        return _result(
            "high_risk_outbound", "High-risk outbound", True, [sid] + r["cps"], r["txns"],
            f"{n} high-value debits totalling {_gbp(r['total'])} left the subject to "
            f"high-risk jurisdictions ({', '.join(sorted(r['countries']))}), each at or "
            f"above {_gbp(config.HIGH_VALUE_GBP)}.",
        )
    return _result("high_risk_outbound", "High-risk outbound", False, [], [],
                   f"Fewer than {config.HIGH_RISK_OUTBOUND_MIN_COUNT} high-value debits to high-risk jurisdictions.")


def _structuring(driver, sid) -> dict:
    lo, hi = config.STRUCTURING_BAND
    rows = _records(driver, """
        MATCH (s:Entity {entity_id:$sid})-[r:SENT {subject_id:$sid, direction:'D'}]->(c)
        WHERE r.amount >= $lo AND r.amount < $hi
        WITH c, count(r) AS cnt, sum(r.amount) AS tot, collect(r.key) AS keys
        WHERE cnt >= $minc
        RETURN collect(c.entity_id) AS cps, sum(cnt) AS n, sum(tot) AS total,
               reduce(a=[], k IN collect(keys) | a + k)[..80] AS txns
    """, sid=sid, lo=lo, hi=hi, minc=config.STRUCTURING_MIN_COUNT)
    r = rows[0] if rows else {}
    cps = r.get("cps") or []
    if cps:
        return _result(
            "structuring", "Structuring", True, [sid] + cps, r["txns"],
            f"{r['n']} debits of {_gbp(lo)}–{_gbp(hi)} (just under the reporting threshold) "
            f"went to {len(cps)} counterparty(ies) totalling {_gbp(r['total'])} — a smurfing "
            f"/ structuring signature.",
        )
    return _result("structuring", "Structuring", False, [], [],
                   f"No counterparty received >= {config.STRUCTURING_MIN_COUNT} near-threshold debits.")


def _circular(driver, sid) -> dict:
    rows = _records(driver, """
        MATCH (s:Entity {entity_id:$sid})-[out:SENT {subject_id:$sid, direction:'D'}]->(c)
        MATCH (c)-[back:SENT {subject_id:$sid, direction:'C'}]->(s)
        WHERE back.day >= out.day AND back.day - out.day <= $win
          AND abs(out.amount - back.amount) <= $tol * out.amount
        WITH c, out, min(back.day - out.day) AS lag, collect(back.key)[0] AS back_key
        RETURN count(*) AS n, sum(out.amount) AS total,
               collect(DISTINCT c.entity_id) AS cps,
               (collect(out.key) + collect(back_key))[..80] AS txns
    """, sid=sid, win=config.ROUNDTRIP_WINDOW_DAYS, tol=config.ROUNDTRIP_TOLERANCE)
    r = rows[0] if rows else {}
    n = r.get("n") or 0
    if n >= config.CIRCULAR_MIN_COUNT:
        return _result(
            "circular_flow", "Circular flow", True, [sid] + r["cps"], r["txns"],
            f"{n} matched round-trips ({_gbp(r['total'])} sent and returned within "
            f"{config.ROUNDTRIP_WINDOW_DAYS} days at ~the same amount) across {len(r['cps'])} "
            f"counterparty(ies) — a layering / circular fund-flow signature.",
        )
    return _result("circular_flow", "Circular flow", False, [], [],
                   f"Fewer than {config.CIRCULAR_MIN_COUNT} matched reciprocal round-trips.")


def _shell(driver, sid) -> dict:
    rows = _records(driver, """
        MATCH (s:Entity {entity_id:$sid})-[r:SENT {subject_id:$sid, direction:'D'}]->(c)
        WHERE c.jurisdiction IN $off AND c.beneficial_owner <> ''
        WITH c.beneficial_owner AS bo, collect(DISTINCT c.entity_id) AS cps,
             sum(r.amount) AS tot, collect(r.key) AS keys
        WHERE size(cps) >= $minc
        RETURN reduce(a=[], x IN collect(cps) | a + x) AS ents,
               collect(bo) AS bos, sum(tot) AS total,
               reduce(a=[], k IN collect(keys) | a + k)[..80] AS txns
    """, sid=sid, off=list(config.OFFSHORE_JURISDICTIONS), minc=config.SHELL_MIN_CLUSTER)
    r = rows[0] if rows else {}
    ents = r.get("ents") or []
    if ents:
        return _result(
            "shell_linkage", "Shell linkage", True, [sid] + ents, r["txns"],
            f"The subject funds {len(ents)} offshore companies ({', '.join(ents)}) that share "
            f"a beneficial owner ({', '.join(r['bos'])}) and are incorporated in secrecy "
            f"jurisdictions — a shell-company cluster ({_gbp(r['total'])} funded).",
        )
    return _result("shell_linkage", "Shell linkage", False, [], [],
                   f"No subject-funded cluster of >= {config.SHELL_MIN_CLUSTER} offshore shells sharing an owner.")


# --- Graph queries (subject ego-network) ------------------------------------

_NODES = """
MATCH (s:Entity {entity_id:$sid})
OPTIONAL MATCH (s)-[:SENT {subject_id:$sid}]-(c)
WITH s, collect(DISTINCT c) AS cps
UNWIND ([s] + cps) AS e
RETURN DISTINCT e.entity_id AS id, e.name AS label, e.type AS type,
       e.jurisdiction AS jurisdiction, e.kyc_risk_rating AS kyc_risk,
       e.beneficial_owner AS beneficial_owner, e.pep_flag AS pep_flag,
       labels(e) AS labels
ORDER BY id
"""

# Aggregate the subject's transactions into one edge per (source, target,
# direction) so the graph stays legible (per-txn detail lives in the CSVs).
_EDGES = """
MATCH (a:Entity)-[r:SENT {subject_id:$sid}]->(b:Entity)
WITH a.entity_id AS source, b.entity_id AS target, r.direction AS direction,
     sum(r.amount) AS amount, count(r) AS cnt,
     collect(DISTINCT r.channel) AS channels, max(r.txn_date) AS last_date
RETURN source, target, direction, amount, cnt, channels, last_date
ORDER BY amount DESC
"""


def _role(node_id, flags, ent_sets) -> str:
    if flags["subject"]:
        return "subject"
    if flags["sanctioned"]:
        return "sanctioned"
    if flags["shell"]:
        return "shell"
    if node_id in ent_sets["circular_flow"]:
        return "layering"
    if node_id in ent_sets["high_risk_outbound"] or node_id in ent_sets["sanctioned_exposure"]:
        return "intermediary"
    if node_id in ent_sets["structuring"]:
        return "intermediary"
    return "counterparty"


def build_case_contract(driver, build_report: dict, case: dict) -> dict:
    """Assemble one case's contract from the graph + detector results.

    `case` is a row from cases.csv (case_id + subject_id + metadata).
    """
    sid = case["subject_id"]
    detectors = run_detectors(driver, sid)
    by_key = {d["key"]: d for d in detectors}
    ent_sets = {k: set(by_key[k]["entities"]) for k in PATTERN}

    # counterparty -> its highest-severity fired pattern (for edge colouring).
    cp_pattern: dict[str, str] = {}
    for key in _SEVERITY:
        if by_key[key]["fired"]:
            for eid in by_key[key]["entities"]:
                if eid != sid:
                    cp_pattern.setdefault(eid, PATTERN[key])

    # Nodes
    nodes = []
    for n in _records(driver, _NODES, sid=sid):
        labels = set(n["labels"])
        flags = {
            "subject": n["id"] == sid,
            "sanctioned": "Sanctioned" in labels,
            "shell": n["id"] in ent_sets["shell_linkage"],
        }
        nodes.append({
            "id": n["id"],
            "label": n["label"],
            "type": n["type"],
            "jurisdiction": n["jurisdiction"],
            "kyc_status": n["kyc_risk"],          # hover shows KYC risk rating now
            "beneficial_owner": n["beneficial_owner"],
            "pep_flag": n["pep_flag"],
            "role": _role(n["id"], flags, ent_sets),
            "flags": flags,
        })

    # Edges (aggregated) — pattern from the non-subject endpoint's fired detector.
    edges = []
    for e in _records(driver, _EDGES, sid=sid):
        cp = e["target"] if e["source"] == sid else e["source"]
        edges.append({
            "id": f"{e['source']}->{e['target']}",
            "source": e["source"],
            "target": e["target"],
            "amount_gbp": round(e["amount"], 2),
            "txn_date": e["last_date"],
            "channel": ", ".join(e["channels"][:3]),
            "count": e["cnt"],
            "pattern": cp_pattern.get(cp),
        })

    # Score via the configured engine (detectors are pure evidence).
    result = get_engine().score(detectors, {"nodes": nodes, "edges": edges})
    for d in detectors:
        d["contribution"] = result.components.get(d["key"], 0.0)

    # Source-integration badges (derived counts).
    oon = build_report["out_of_network"]
    fired = {d["key"]: d for d in detectors if d["fired"]}
    sources = [
        {"key": "world_check", "label": "World-Check",
         "count": len(fired.get("sanctioned_exposure", {}).get("entities", [])[1:]),
         "detail": "in-network sanctions hit(s) → derives :Sanctioned"},
        {"key": "tm", "label": "TM",
         "count": sum(len(fired[k]["txns"]) for k in ("circular_flow", "high_risk_outbound", "structuring") if k in fired),
         "detail": "transaction-monitoring legs across the fired flow detectors"},
        {"key": "kyc", "label": "KYC",
         "count": (1 if "shell_linkage" in fired else 0),
         "detail": "KYC-derived risk clusters (offshore shell linkage)"},
        {"key": "watchlist", "label": "Watchlist", "count": 0,
         "detail": f"{len(oon['watchlist'])} screening row(s) but 0 in-network (out-of-network)"},
    ]

    fired_names = [d["name"].lower() for d in detectors if d["fired"]]
    case_block = {
        "case_id": case["case_id"],
        "subject_entity_id": sid,
        "subject_name": case["subject_name"],
        "trigger_code": case.get("alert_type", ""),
        "trigger_desc": case.get("trigger_reason", ""),
        "created_at": case.get("alert_date", ""),
        "status": case.get("case_status", ""),
        "analyst": case.get("assigned_analyst", ""),
        "priority": case.get("priority", ""),
        "jurisdiction": case.get("jurisdiction", ""),
    }
    return {
        "case": case_block,
        "graph": {"nodes": nodes, "edges": edges},
        "detectors": detectors,
        "score": {"total": result.total, "band": result.band, "bands": result.bands,
                  "engine": result.engine_name},
        "recommendation": {
            "action": result.band,
            "headline": _headline(result.band),
            "rationale": (
                "PLACEHOLDER rationale (LLM-generated text fills in at startup). "
                f"Score {result.total} -> {result.band}"
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

    debit = Σ amounts the reference SENT; credit = Σ it RECEIVED; an edge's share
    is its amount over the matching base. Returns {edge_id: {"pct", "direction"}}
    for every edge that touches the reference.
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
    with open(DATA_DIR / name, newline="", encoding="utf-8") as f:
        return {r["entity_id"]: r for r in csv.DictReader(f)}


def build_entity_detail(contract: dict, entity_id: str) -> dict | None:
    """Assemble {kyc, worldcheck|null, risky_paths[]} for one entity.

    A join over kyc.csv + worldcheck.csv + the already-scored contract (whose
    aggregated edges carry the per-counterparty detector pattern). Returns None
    when the entity has no KYC row (route -> 404).
    """
    kyc_row = _csv_by_id("kyc.csv").get(entity_id)
    if kyc_row is None:
        return None
    wc_row = _csv_by_id("worldcheck.csv").get(entity_id)

    kyc = {
        "entity_id": kyc_row["entity_id"],
        "name": kyc_row["entity_name"],
        "entity_type": kyc_row["entity_type"],
        "jurisdiction": kyc_row["incorporation_country"],
        "incorporation_date": kyc_row["incorporation_date"] or None,
        "industry": kyc_row["industry"],
        "beneficial_owner": kyc_row["beneficial_owner"] or None,
        "kyc_risk_rating": kyc_row["kyc_risk_rating"],
        "pep_flag": kyc_row["pep_flag"],
    }
    worldcheck = {
        "entity_id": wc_row["entity_id"],
        "match_category": wc_row["match_category"],
        "watchlist_source": wc_row["watchlist_source"],
        "match_status": wc_row["match_status"],
        "match_score": float(wc_row["match_score"]),
        "severity": wc_row["severity"],
        "screened_name": wc_row["entity_name"],
    } if wc_row else None

    # Which detector name(s) does the entity participate in?
    reasons = sorted({d["name"] for d in contract["detectors"]
                      if d["fired"] and entity_id in d["entities"]})

    # Aggregated flows between this entity and the subject, worst share first.
    edges = contract["graph"]["edges"]
    shares = contribution_shares(edges, entity_id)
    risky_paths = []
    for e in edges:
        if entity_id not in (e["source"], e["target"]):
            continue
        sh = shares.get(e["id"])
        counterparty = e["target"] if e["source"] == entity_id else e["source"]
        risky_paths.append({
            "counterparty": counterparty,
            "direction": sh["direction"] if sh else "debit",
            "reason": ", ".join(reasons) if e["pattern"] else "",
            "txn_count": e["count"],
            "amount": e["amount_gbp"],
            "currency": "GBP",
            "contribution_pct": round(sh["pct"], 1) if sh else 0.0,
            "pattern": e["pattern"],
        })
    risky_paths.sort(key=lambda r: r["contribution_pct"], reverse=True)

    return {"entity_id": entity_id, "kyc": kyc,
            "worldcheck": worldcheck, "risky_paths": risky_paths}
