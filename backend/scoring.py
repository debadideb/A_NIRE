"""Detectors (in Cypher), rule-based scoring, and contract assembly.

The graph is a k-hop counterparty network per subject (subject -> counterparties
-> sub-counterparties -> ...), so detectors now TRAVERSE, each scoped to one
case's network (every :SENT edge carrying that subject_id):

  * sanctioned_exposure — a real path subject -> ... -> :Sanctioned within k hops
  * high_risk_outbound  — any node in the network (subject or a deep intermediary)
                          makes many high-value debits to high-risk jurisdictions
  * structuring         — any node fans many near-threshold debits out to several
                          counterparties in a tight window (deep cash-in/layer-out)
  * circular_flow       — a genuine closed loop subject -> ... -> subject (len >= 3,
                          often long: through several counterparties before returning)
  * shell_linkage       — the network funds >=N offshore cps sharing a beneficial owner

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


# --- Detectors (all scoped to a case network via edge.subject_id; multi-hop) --

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
    # A real path from the subject out to a sanctioned node, within k hops.
    rows = _records(driver, f"""
        MATCH p = shortestPath((s:Entity {{entity_id:$sid}})-[:SENT*1..{config.SANCTIONED_MAX_HOP}]->(t:Sanctioned))
        WHERE all(r IN relationships(p) WHERE r.subject_id = $sid)
        RETURN [n IN nodes(p) | n.entity_id] AS ents,
               [r IN relationships(p) | r.key] AS txns,
               t.entity_id AS tid, t.screened_name AS name,
               t.sanction_list AS list, t.sanction_match AS score, length(p) AS hops
        ORDER BY hops LIMIT 1
    """, sid=sid)
    if rows:
        r = rows[0]
        return _result(
            "sanctioned_exposure", "Sanctioned exposure", True, r["ents"], r["txns"],
            f"The subject reaches a sanctioned counterparty in {r['hops']} hop(s): "
            f"{'→'.join(r['ents'])} — {r['tid']} ({r['name']}) is a {r['list']} "
            f"World-Check hit at match score {int(r['score'])}.",
        )
    return _result("sanctioned_exposure", "Sanctioned exposure", False, [], [],
                   "No path from the subject to a sanctioned counterparty.")


def _high_risk_outbound(driver, sid) -> dict:
    # Network-wide: any node in the case network (the subject OR an intermediary
    # cut-out deeper out) that pushes many high-value debits to high-risk
    # jurisdictions. Grouped by sender so the typology is caught wherever it sits.
    rows = _records(driver, """
        MATCH (a)-[r:SENT {subject_id:$sid}]->(c)
        WHERE r.amount >= $hv AND r.benef_country IN $hr
        WITH a, count(r) AS n, sum(r.amount) AS total,
             collect(DISTINCT c.entity_id) AS cps,
             collect(DISTINCT r.benef_country) AS countries,
             collect(r.key)[..80] AS txns
        WHERE n >= $minc
        RETURN a.entity_id AS src, n, total, cps, countries, txns
        ORDER BY n DESC LIMIT 1
    """, sid=sid, hv=config.HIGH_VALUE_GBP, hr=list(config.HIGH_RISK_JURISDICTIONS),
         minc=config.HIGH_RISK_OUTBOUND_MIN_COUNT)
    if rows:
        r = rows[0]
        where = "the subject" if r["src"] == sid else f"an intermediary ({r['src']})"
        return _result(
            "high_risk_outbound", "High-risk outbound", True, [r["src"]] + r["cps"], r["txns"],
            f"{r['n']} high-value debits totalling {_gbp(r['total'])} left {where} to "
            f"high-risk jurisdictions ({', '.join(sorted(r['countries']))}), each at or "
            f"above {_gbp(config.HIGH_VALUE_GBP)}.",
        )
    return _result("high_risk_outbound", "High-risk outbound", False, [], [],
                   f"No node made >= {config.HIGH_RISK_OUTBOUND_MIN_COUNT} high-value debits to high-risk jurisdictions.")


def _structuring(driver, sid) -> dict:
    # Network-wide layering: a single node (the subject OR a hub deep in the
    # network) that pushes OUT many near-threshold debits to several counterparties
    # inside a tight window — the fan-out signature of cash broken into sub-limit
    # chunks. Grouped by sender, so a deep cash-in/layer-out hub is caught.
    lo, hi = config.STRUCTURING_BAND
    rows = _records(driver, """
        MATCH (a)-[r:SENT {subject_id:$sid}]->(c)
        WHERE r.amount >= $lo AND r.amount < $hi
        WITH a, count(r) AS cnt, sum(r.amount) AS tot,
             collect(DISTINCT c.entity_id) AS cps, collect(r.key) AS keys,
             max(r.day) - min(r.day) AS span
        WHERE cnt >= $minc AND span <= $win
        RETURN a.entity_id AS hub, cnt, tot, cps, keys[..80] AS txns
        ORDER BY cnt DESC LIMIT 1
    """, sid=sid, lo=lo, hi=hi, minc=config.STRUCTURING_MIN_COUNT,
         win=config.STRUCTURING_WINDOW_DAYS)
    if rows:
        r = rows[0]
        where = "the subject" if r["hub"] == sid else f"an intermediary ({r['hub']})"
        return _result(
            "structuring", "Structuring", True, [r["hub"]] + r["cps"], r["txns"],
            f"{where} layered {r['cnt']} debits of {_gbp(lo)}–{_gbp(hi)} (just under the "
            f"reporting threshold) out to {len(r['cps'])} counterparties totalling "
            f"{_gbp(r['tot'])} within {config.STRUCTURING_WINDOW_DAYS} days — a structuring "
            f"/ layering signature.",
        )
    return _result("structuring", "Structuring", False, [], [],
                   f"No node made >= {config.STRUCTURING_MIN_COUNT} near-threshold debits within "
                   f"{config.STRUCTURING_WINDOW_DAYS} days.")


def _circular(driver, sid) -> dict:
    # A genuine closed loop of length >= 3: find a node that pays the subject back
    # (an edge into the subject), then the SHORTEST outbound path to it. shortestPath
    # is BFS — enumerating every trail on the multigraph (many parallel :SENT edges
    # per relationship) would blow up combinatorially.
    #
    # CRITICAL: the `length(path) >= 2` filter lives in a SEPARATE `WITH`, NOT inside
    # the shortestPath's own WHERE. Inlining it makes Neo4j fall back to EXHAUSTIVE
    # path enumeration whenever the shortest path can't satisfy the predicate — which
    # is exactly the case for the subject's income counterparties (pure sources, not
    # reachable from the subject): that fallback is the combinatorial blow-up. As a
    # post-filter the shortestPath stays a plain BFS that simply finds nothing for an
    # unreachable payer. (Neo4j forbids property maps inside shortestPath, so the
    # walk isn't scoped to subject_id — harmless here: only this case's income payers
    # carry an edge into the subject, and they're unreachable either way.)
    #
    # length(path) >= 2 makes the closed loop (path + the return edge) >= 3, which
    # excludes trivial 2-cycles. `trips`/`back_total` aggregate ALL return edges from
    # the payer to the subject (the scheme repeats), rather than quoting one arbitrary
    # parallel leg (per-iteration amounts don't line up across parallel edges, so a
    # single "out vs back" pair would mislead).
    rows = _records(driver, f"""
        MATCH (x)-[:SENT {{subject_id:$sid}}]->(s:Entity {{entity_id:$sid}})
        WHERE x.entity_id <> $sid
        WITH DISTINCT x
        MATCH path = shortestPath((s2:Entity {{entity_id:$sid}})-[:SENT*1..{config.CIRCULAR_MAX_LEN}]->(x))
        WITH x, path, length(path) AS plen
        WHERE plen >= 2
        WITH x, path, plen ORDER BY plen LIMIT 1
        MATCH (x)-[back:SENT {{subject_id:$sid}}]->(:Entity {{entity_id:$sid}})
        WITH path, plen, count(back) AS trips, sum(back.amount) AS back_total
        RETURN [n IN nodes(path) | n.entity_id] AS ents,
               [r IN relationships(path) | r.key] AS txns,
               plen + 1 AS len, trips, back_total
        LIMIT 1
    """, sid=sid)
    if rows:
        r = rows[0]
        ents = r["ents"]                        # [subject, ..., payer]
        loop = "→".join(ents + [ents[0]])
        return _result(
            "circular_flow", "Circular flow", True, ents, r["txns"],
            f"Funds left the subject and returned through a closed loop of length {r['len']} "
            f"passing through {len(ents) - 1} counterparties: {loop}. {r['trips']} round-trip(s) "
            f"totalling {_gbp(r['back_total'])} came back to the subject — a layering / circular "
            f"fund-flow signature.",
        )
    return _result("circular_flow", "Circular flow", False, [], [],
                   "No closed loop of length ≥3 through the subject.")


def _shell(driver, sid) -> dict:
    # Offshore counterparties in the subject's network (every entity funded within
    # the case is a target of some subject_id edge — the network is a tree rooted
    # at the subject, so membership = reachable) that share a beneficial owner — a
    # shell cluster. Membership over edge targets avoids var-length path
    # enumeration (which would blow up on the multigraph). Then collect the funding
    # transactions into the cluster for the evidence trail.
    rows = _records(driver, """
        MATCH (a)-[:SENT {subject_id:$sid}]->(c)
        WHERE c.jurisdiction IN $off AND c.beneficial_owner <> ''
        WITH DISTINCT c
        WITH c.beneficial_owner AS bo, collect(DISTINCT c.entity_id) AS cps
        WHERE size(cps) >= $minc
        RETURN reduce(a=[], x IN collect(cps) | a + x) AS ents, collect(bo) AS bos
    """, sid=sid, off=list(config.OFFSHORE_JURISDICTIONS), minc=config.SHELL_MIN_CLUSTER)
    r = rows[0] if rows else {}
    ents = r.get("ents") or []
    if not ents:
        return _result("shell_linkage", "Shell linkage", False, [], [],
                       f"No subject-funded cluster of >= {config.SHELL_MIN_CLUSTER} offshore shells sharing an owner.")
    fund = _records(driver, """
        MATCH (a)-[r:SENT {subject_id:$sid}]->(sh:Entity)
        WHERE sh.entity_id IN $shells
        RETURN collect(r.key)[..80] AS txns, sum(r.amount) AS total
    """, sid=sid, shells=ents)
    txns = fund[0]["txns"] if fund else []
    total = fund[0]["total"] if fund else 0
    bos = sorted(set(r.get("bos") or []))
    return _result(
        "shell_linkage", "Shell linkage", True, [sid] + ents, txns,
        f"The subject funds {len(ents)} offshore companies ({', '.join(ents)}) that share a "
        f"beneficial owner ({', '.join(bos)}) and are incorporated in secrecy jurisdictions "
        f"— a shell-company cluster ({_gbp(total)} funded).",
    )


# --- Graph queries (the subject's whole k-hop network) ----------------------
# Both queries take $minday: when it is null they cover the whole network; when
# it is an ordinal day they keep only transactions on/after that day (the graph's
# time-window control). Edges carry an ordinal `day` (graphdb._day).

# Every entity that appears on an edge belonging to this case's (windowed) network.
_NODES = """
MATCH (a:Entity)-[r:SENT {subject_id:$sid}]->(b:Entity)
WHERE $minday IS NULL OR r.day >= $minday
WITH collect(DISTINCT a) + collect(DISTINCT b) AS ns
UNWIND ns AS e
RETURN DISTINCT e.entity_id AS id, e.name AS label, e.type AS type,
       e.jurisdiction AS jurisdiction, e.kyc_risk_rating AS kyc_risk,
       e.beneficial_owner AS beneficial_owner, e.pep_flag AS pep_flag,
       labels(e) AS labels
ORDER BY id
"""

# Aggregate the (windowed) network's transactions into one edge per (source,
# target) so the graph stays legible (per-txn detail lives in the CSVs). hop =
# shallowest depth of the edge from the subject, handy for layout/debugging.
_EDGES = """
MATCH (a:Entity)-[r:SENT {subject_id:$sid}]->(b:Entity)
WHERE $minday IS NULL OR r.day >= $minday
WITH a.entity_id AS source, b.entity_id AS target,
     sum(r.amount) AS amount, count(r) AS cnt,
     collect(DISTINCT r.channel) AS channels, max(r.txn_date) AS last_date,
     collect(r.key)[..8] AS keys, min(r.hop) AS hop
RETURN source, target, amount, cnt, channels, last_date, keys, hop
ORDER BY amount DESC
"""


def _all_subject_ids() -> set[str]:
    """Every case's subject id — so a counterparty that is itself the subject of a
    DIFFERENT case (the networks are wired together by a peer ring) can be flagged
    and rendered distinctly, not as an ordinary counterparty."""
    with open(DATA_DIR / "cases.csv", newline="", encoding="utf-8") as f:
        return {r["subject_id"] for r in csv.DictReader(f)}


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


def build_graph_view(driver, detectors: list[dict], sid: str, minday: int | None = None) -> dict:
    """Build {nodes, edges} for one case's k-hop network, optionally time-windowed.

    `minday` (an ordinal day) keeps only transactions on/after it; None ⇒ the
    whole network. Node roles/flags and edge patterns are DERIVED from the
    already-run `detectors`, so a windowed view keeps its detector colours without
    re-running detection or the score. This is the seam the startup contract build
    and the windowed-graph endpoint both use.
    """
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
    all_subjects = _all_subject_ids()
    nodes = []
    for n in _records(driver, _NODES, sid=sid, minday=minday):
        labels = set(n["labels"])
        flags = {
            "subject": n["id"] == sid,
            "sanctioned": "Sanctioned" in labels,
            # Shell applies to the funded cluster members, never the subject
            # itself (the shell detector's entity set is [subject] + cluster).
            "shell": n["id"] != sid and n["id"] in ent_sets["shell_linkage"],
            # A counterparty here that is the ALERTED SUBJECT of another case.
            "peer_subject": n["id"] != sid and n["id"] in all_subjects,
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
    for e in _records(driver, _EDGES, sid=sid, minday=minday):
        cp = e["target"] if e["source"] == sid else e["source"]
        edges.append({
            "id": f"{e['source']}->{e['target']}",
            "source": e["source"],
            "target": e["target"],
            "amount_gbp": round(e["amount"], 2),
            "txn_date": e["last_date"],
            "channel": ", ".join(e["channels"][:3]),
            "count": e["cnt"],
            "hop": e["hop"],
            "txn_ids": e["keys"],           # sample of underlying txn keys (capped)
            "pattern": cp_pattern.get(cp),
        })

    return {"nodes": nodes, "edges": edges}


def build_case_contract(driver, build_report: dict, case: dict) -> dict:
    """Assemble one case's contract from the graph + detector results.

    `case` is a row from cases.csv (case_id + subject_id + metadata).
    """
    sid = case["subject_id"]
    detectors = run_detectors(driver, sid)

    # Nodes/edges over the whole network (the seam reused by the windowed endpoint).
    view = build_graph_view(driver, detectors, sid)
    nodes, edges = view["nodes"], view["edges"]

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


def _trail_from_subject(edges: list[dict], subject_id: str, target_id: str) -> list[str]:
    """Shortest hop-chain of entity ids from the subject to `target_id`.

    Money flows subject -> outward, so we BFS the DIRECTED graph first (that is the
    real funding corridor). A few actors sit on a leg that only reaches the subject
    against the flow (e.g. a reciprocal/circular return), so we fall back to an
    undirected BFS to guarantee the trail always resolves. Returns [subject..target]
    or [] if genuinely disconnected.
    """
    if target_id == subject_id:
        return [subject_id]

    def bfs(directed: bool) -> list[str] | None:
        adj: dict[str, list[str]] = {}
        for e in edges:
            adj.setdefault(e["source"], []).append(e["target"])
            if not directed:
                adj.setdefault(e["target"], []).append(e["source"])
        prev: dict[str, str | None] = {subject_id: None}
        queue, head = [subject_id], 0
        while head < len(queue):
            u = queue[head]; head += 1
            for v in adj.get(u, []):
                if v in prev:
                    continue
                prev[v] = u
                if v == target_id:
                    path = [v]
                    while prev[path[-1]] is not None:
                        path.append(prev[path[-1]])  # type: ignore[arg-type]
                    path.reverse()
                    return path
                queue.append(v)
        return None

    return bfs(True) or bfs(False) or []


def build_entity_detail(contract: dict, entity_id: str) -> dict | None:
    """Assemble {kyc, worldcheck|null, risky_paths[]} for one entity.

    A join over kyc.csv + worldcheck.csv + the already-scored contract (whose
    aggregated edges carry the per-counterparty detector pattern). Returns None
    when the entity has no KYC row (route -> 404).
    """
    kyc_all = _csv_by_id("kyc.csv")
    kyc_row = kyc_all.get(entity_id)
    if kyc_row is None:
        return None
    wc_row = _csv_by_id("worldcheck.csv").get(entity_id)

    def _name(eid: str) -> str:
        return kyc_all.get(eid, {}).get("entity_name", eid)

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

    # Risky paths = the entity's flows that belong to a FIRED detector only (an
    # edge with a pattern). Clean counterparties touch no fired pattern, so their
    # list is empty — the modal then shows "no fired-detector transactions".
    edges = contract["graph"]["edges"]
    shares = contribution_shares(edges, entity_id)
    risky_paths = []
    for e in edges:
        if e["pattern"] is None or entity_id not in (e["source"], e["target"]):
            continue
        sh = shares.get(e["id"])
        counterparty = e["target"] if e["source"] == entity_id else e["source"]
        risky_paths.append({
            "counterparty": counterparty,
            "counterparty_name": _name(counterparty),   # human-readable, for the modal
            "direction": sh["direction"] if sh else "debit",
            "reason": ", ".join(reasons),
            "txn_ids": e["txn_ids"],
            "txn_count": e["count"],
            "amount": e["amount_gbp"],
            "currency": "GBP",
            "contribution_pct": round(sh["pct"], 1) if sh else 0.0,
            "pattern": e["pattern"],
        })
    risky_paths.sort(key=lambda r: r["contribution_pct"], reverse=True)

    # Trail back to the subject: the hop-chain (by NAME) from the alerted subject
    # to this entity, so an investigator sees how the money reaches it rather than
    # a lone edge floating in the network. Built over the same aggregated edges the
    # graph draws (the benign funding corridors are present), so a deep actor still
    # traces all the way home.
    subject_id = contract["case"]["subject_entity_id"]
    trail = [{"id": i, "name": _name(i)} for i in
             _trail_from_subject(edges, subject_id, entity_id)]

    return {"entity_id": entity_id, "kyc": kyc, "worldcheck": worldcheck,
            "subject_id": subject_id, "subject_name": _name(subject_id),
            "trail": trail, "risky_paths": risky_paths}
