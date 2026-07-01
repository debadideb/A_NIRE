"""Neo4j connection + idempotent graph build from the synthetic CSVs.

Ingestion discipline (matches the design principle — RAW attributes only):
  * `:Entity` nodes carry only raw attributes from kyc.csv.
  * The subject comes from the case file (cases.csv), not a data column, and is
    resolved per case at query time — there is no global :Subject label because
    the dataset now holds five cases sharing one graph.
  * Transactions are subject-centric: each row is a movement between a case
    subject and a counterparty with a credit/debit code. It becomes a directed
    `:SENT` edge — D = subject sent to counterparty, C = counterparty sent to
    subject — so `:SENT` always means "money moved a -> b". The edge carries the
    owning `subject_id`, so a case's ego-network is every SENT edge with that
    subject_id.
  * `:Sanctioned` is DERIVED from a confirmed World-Check sanctions hit at/above
    the score cutoff, never read from a label.
  * Shell / high-risk / structuring / circular are NOT baked in as labels; they
    are derived by the detectors from raw edge + KYC attributes.

CSV rows are passed as Cypher parameters (UNWIND) rather than LOAD CSV, so the
data files stay in the repo and nothing depends on Neo4j's import directory.
"""

import csv
from datetime import datetime

from neo4j import GraphDatabase

from config import (
    DATA_DIR,
    NEO4J_PASSWORD,
    NEO4J_URI,
    NEO4J_USER,
    SANCTIONS_CATEGORY,
    SANCTIONS_MIN_SCORE,
    SANCTIONS_STATUS,
)

DB = "neo4j"


def get_driver():
    """Create a Neo4j driver from configured credentials."""
    return GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))


def _load_csv(name: str) -> list[dict]:
    with open(DATA_DIR / name, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _day(date_str: str) -> int:
    """DD/MM/YYYY -> ordinal day number, for window arithmetic in Cypher."""
    return datetime.strptime(date_str, "%d/%m/%Y").date().toordinal()


def build_graph(driver) -> dict:
    """(Re)build the graph from the CSVs. Idempotent: wipes first.

    Returns a small build report (counts + derived/out-of-network ids + the list
    of case subjects) for logging and the source-summary badges.
    """
    kyc = _load_csv("kyc.csv")
    txns = _load_csv("transactions.csv")
    cases = _load_csv("cases.csv")
    worldcheck = _load_csv("worldcheck.csv")
    watchlist = _load_csv("watchlist.csv")

    q = lambda cypher, **params: driver.execute_query(cypher, database_=DB, **params)

    # 1. Clean slate + uniqueness constraint.
    q("MATCH (n) DETACH DELETE n")
    q("CREATE CONSTRAINT entity_id IF NOT EXISTS "
      "FOR (e:Entity) REQUIRE e.entity_id IS UNIQUE")

    # 2. Entities — raw attributes only (new KYC schema).
    q(
        """
        UNWIND $rows AS r
        MERGE (e:Entity {entity_id: r.entity_id})
        SET e.name = r.entity_name,
            e.type = r.entity_type,
            e.account_number = r.account_number,
            e.jurisdiction = r.incorporation_country,
            e.incorporation_date = r.incorporation_date,
            e.industry = r.industry,
            e.registration_number = r.registration_number,
            e.beneficial_owner = r.beneficial_owner,
            e.kyc_risk_rating = r.kyc_risk_rating,
            e.pep_flag = r.pep_flag
        """,
        rows=kyc,
    )

    # 3. Transactions -> directed :SENT edges. Enrich in Python (float amount +
    #    ordinal day) so the Cypher stays simple and date math is trivial.
    edges = []
    for r in txns:
        edges.append({
            "subject_id": r["subject_id"],
            "counterparty_id": r["counterparty_id"],
            "direction": r["credit_debit_code"],
            "key": r["transaction_key"],
            "amount": float(r["amount"]),
            "day": _day(r["transaction_date"]),
            "date": r["transaction_date"],
            "ttype": r["transaction_type"],
            "benef": r["beneficiary_bank_country"],
            "orig": r["originator_bank_country"],
        })
    debits = [e for e in edges if e["direction"] == "D"]
    credits = [e for e in edges if e["direction"] == "C"]
    _edge_props = """
        key: r.key, amount: r.amount, day: r.day, txn_date: r.date,
        channel: r.ttype, benef_country: r.benef, orig_country: r.orig,
        subject_id: r.subject_id, direction: r.direction
    """
    # D: subject -> counterparty
    q(
        f"""
        UNWIND $rows AS r
        MATCH (s:Entity {{entity_id: r.subject_id}})
        MATCH (c:Entity {{entity_id: r.counterparty_id}})
        CREATE (s)-[:SENT {{{_edge_props}}}]->(c)
        """,
        rows=debits,
    )
    # C: counterparty -> subject
    q(
        f"""
        UNWIND $rows AS r
        MATCH (s:Entity {{entity_id: r.subject_id}})
        MATCH (c:Entity {{entity_id: r.counterparty_id}})
        CREATE (c)-[:SENT {{{_edge_props}}}]->(s)
        """,
        rows=credits,
    )

    # 4. Derive :Sanctioned from confirmed World-Check sanctions hits >= cutoff.
    sanctions_hits = [
        r for r in worldcheck
        if r["match_category"] == SANCTIONS_CATEGORY
        and r["match_status"] == SANCTIONS_STATUS
        and float(r["match_score"]) >= SANCTIONS_MIN_SCORE
    ]
    q(
        """
        UNWIND $rows AS r
        MATCH (e:Entity {entity_id: r.entity_id})
        SET e:Sanctioned,
            e.sanction_list = r.watchlist_source,
            e.sanction_match = toFloat(r.match_score),
            e.screened_name = r.entity_name
        """,
        rows=sanctions_hits,
    )

    # 5. Watchlist — mark in-network matches (informational; drives no detector).
    q(
        """
        UNWIND $rows AS r
        MATCH (e:Entity {entity_id: r.entity_id})
        SET e:Watchlisted, e.watch_reason = r.reason
        """,
        rows=watchlist,
    )

    node_ids = {r["entity_id"] for r in kyc}
    return {
        "entities": len(kyc),
        "transactions": len(txns),
        "subjects": [c["subject_id"] for c in cases],
        "sanctioned": [r["entity_id"] for r in sanctions_hits if r["entity_id"] in node_ids],
        "out_of_network": {
            "worldcheck": [r["entity_id"] for r in worldcheck if r["entity_id"] not in node_ids],
            "watchlist": [r["entity_id"] for r in watchlist if r["entity_id"] not in node_ids],
        },
    }
