"""Neo4j connection + idempotent graph build from the synthetic CSVs.

Ingestion discipline (matches the design principle):
  * `:Entity` nodes carry only RAW attributes from kyc.csv.
  * `:Subject` comes from cases.csv, not a data column.
  * `:Sanctioned` is DERIVED from a World-Check hit (match_strength >= threshold),
    never read from a label.
  * `:Shell` is DERIVED from kyc_status = 'nominee' + a shared (normalised)
    registered_address — shared address ALONE is not enough.
  * Screening rows with no matching node are skipped and reported as
    out-of-network (they prove the source is integrated without polluting the graph).

CSV rows are passed as Cypher parameters (UNWIND) rather than LOAD CSV, so the
data files stay in the repo and nothing depends on Neo4j's import directory.
"""

import csv

from neo4j import GraphDatabase

from config import (
    DATA_DIR,
    NEO4J_PASSWORD,
    NEO4J_URI,
    NEO4J_USER,
    SANCTIONS_MATCH_THRESHOLD,
)

DB = "neo4j"


def get_driver():
    """Create a Neo4j driver from configured credentials."""
    return GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))


def _load_csv(name: str) -> list[dict]:
    with open(DATA_DIR / name, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def build_graph(driver) -> dict:
    """(Re)build the graph from the CSVs. Idempotent: wipes first.

    Returns a small build report (counts + derived/out-of-network ids) for
    logging and the source-summary badges.
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

    # 2. Entities — raw attributes only.
    q(
        """
        UNWIND $rows AS r
        MERGE (e:Entity {entity_id: r.entity_id})
        SET e.name = r.name,
            e.type = r.entity_type,
            e.jurisdiction = r.jurisdiction,
            e.incorporation_year = toInteger(r.incorporation_year),
            e.kyc_status = r.kyc_status,
            e.registered_address = r.registered_address
        """,
        rows=kyc,
    )

    # 3. Transactions -> :SENT edges.
    q(
        """
        UNWIND $rows AS r
        MATCH (a:Entity {entity_id: r.from_entity_id})
        MATCH (b:Entity {entity_id: r.to_entity_id})
        CREATE (a)-[:SENT {
            txn_id: r.txn_id,
            amount_gbp: toInteger(r.amount_gbp),
            txn_date: r.txn_date,
            channel: r.channel
        }]->(b)
        """,
        rows=txns,
    )

    # 4. Subject — from the case file.
    subject_id = cases[0]["subject_entity_id"]
    q("MATCH (e:Entity {entity_id: $sid}) SET e:Subject", sid=subject_id)

    # 5. Derive :Sanctioned from World-Check hits >= threshold.
    sanctions_hits = [
        r for r in worldcheck
        if r["category"] == "sanctions"
        and float(r["match_strength"]) >= SANCTIONS_MATCH_THRESHOLD
    ]
    q(
        """
        UNWIND $rows AS r
        MATCH (e:Entity {entity_id: r.entity_id})
        SET e:Sanctioned,
            e.sanction_list = r.list_name,
            e.sanction_match = toFloat(r.match_strength),
            e.screened_name = r.screened_name
        """,
        rows=sanctions_hits,
    )

    # 6. Derive :Shell — nominee AND shared (normalised) registered_address.
    #    The pair join + label-set marks every member of a shared-address
    #    nominee cluster. thin_file entities sharing an address are NOT marked.
    q(
        """
        MATCH (a:Entity), (b:Entity)
        WHERE a.kyc_status = 'nominee' AND b.kyc_status = 'nominee'
          AND a.entity_id < b.entity_id
          AND a.registered_address <> ''
          AND toLower(trim(a.registered_address)) = toLower(trim(b.registered_address))
        SET a:Shell, b:Shell
        """,
    )

    # 7. Watchlist — mark in-network matches (none expected here).
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
        "subject": subject_id,
        "sanctioned": [r["entity_id"] for r in sanctions_hits if r["entity_id"] in node_ids],
        "out_of_network": {
            "worldcheck": [r["entity_id"] for r in worldcheck if r["entity_id"] not in node_ids],
            "watchlist": [r["entity_id"] for r in watchlist if r["entity_id"] not in node_ids],
        },
    }
