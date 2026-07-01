"""Deterministic synthetic-data generator for the A_NIRE Case Console.

WHY this exists
---------------
The five cases must each *exhibit* a distinct money-laundering typology so the
detectors have something real to find. Crucially — per the project design
principle — the CSVs carry **raw attributes only**; they never contain a
"shell"/"sanctioned"/"structuring" label. Each typology is planted as raw
signal (large offshore debits, near-threshold amounts, matched round-trips,
shared beneficial owners + offshore incorporation, confirmed World-Check hits),
and the backend detectors *derive* the pattern from those raw facts.

Deterministic: a fixed seed means the dataset — and therefore the acceptance
scores — reproduce exactly on every run. Re-generate with:

    python backend/synthdata.py            # writes backend/data/*.csv

The five subjects and their planted typology (raw signal -> derived detector):

  CASE-2026-0001  E00181  Tradewind    high-value debits to high-risk
                                        jurisdictions + a sanctioned cp in that
                                        corridor            -> high_risk_outbound + sanctioned
  CASE-2026-0002  E00204  Meridian      many debits clustered just under £10k
                                        in a tight window   -> structuring
  CASE-2026-0003  E00337  Halcyon       heavy volume to a confirmed-sanctioned
                                        cp via sanctioned corridors
                                                            -> sanctioned + corridor
  CASE-2026-0004  E00452  Sterling      matched reciprocal round-trips (send £X,
                                        get £~X back in days)
                                                            -> circular_flow
  CASE-2026-0005  E00519  Orion         funds >=3 cps that share a beneficial
                                        owner AND are offshore-incorporated
                                                            -> shell_linkage
"""

from __future__ import annotations

import csv
import random
from datetime import date, timedelta
from pathlib import Path

SEED = 20260701
DATA_DIR = Path(__file__).resolve().parent / "data"

# ── vocab pools ────────────────────────────────────────────────────────────
LOW_RISK = ["GB", "DE", "FR", "NL", "IE", "US", "CA", "AU", "JP", "SE", "ES", "IT", "CH"]
HIGH_RISK = ["IR", "SY", "RU", "KY", "VG", "PA", "SC", "CY", "AE"]   # sanctioned + offshore havens
OFFSHORE = ["VG", "KY", "PA", "SC"]                                   # shell-incorporation havens
TXN_TYPES = ["WIRE", "SWIFT", "SEPA", "FASTER_PAYMENT", "CARD", "CHAPS",
             "STANDING_ORDER", "DIRECT_DEBIT", "CASH_DEPOSIT", "CHEQUE"]
INDUSTRIES = ["Freight & Logistics", "Commodity Trading", "Import/Export", "Shipping",
              "Wholesale Trade", "Precious Metals", "Real Estate", "Financial Holdings",
              "Consulting Services", "Manufacturing"]
ENTITY_TYPES = ["Public Limited Company", "Private Limited Company",
                "Limited Liability Partnership", "Sole Trader"]
NAME_A = ["Apex", "Quill", "Nova", "Atlas", "Onyx", "Summit", "Harbour", "Beacon",
          "Cobalt", "Crest", "Delta", "Vertex", "Silverline", "Northgate", "Pallas",
          "Cascade", "Meridian", "Halcyon", "Orion", "Sterling", "Aurora", "Zephyr",
          "Granite", "Ironclad", "Marlin", "Pinnacle", "Regent", "Titan", "Verano", "Willow"]
NAME_B = ["Group", "Holdings", "Partners", "Global", "Ventures", "Enterprises",
          "Consulting", "Trading", "Ltd", "Capital", "Industries", "Logistics"]
WC_SOURCES = ["OFAC SDN", "EU Consolidated", "UN Sanctions", "HM Treasury", "Interpol"]

START = date(2025, 7, 1)
DAYS = 365


def d(dt: date) -> str:
    return dt.strftime("%d/%m/%Y")


class Gen:
    def __init__(self):
        self.rng = random.Random(SEED)
        self.entities: dict[str, dict] = {}   # entity_id -> kyc row
        self.txns: list[dict] = []
        self.worldcheck: list[dict] = []
        self.watchlist: list[dict] = []
        self.cases: list[dict] = []
        self._acct = 10000000
        self._bo = 1000
        self._reg = 1000000
        self._used_names: set[str] = set()

    # -- helpers -----------------------------------------------------------
    def acct(self) -> str:
        self._acct += self.rng.randint(101, 947)
        return str(self._acct)

    def bo(self) -> str:
        self._bo += self.rng.randint(1, 9)
        return f"BO{self._bo:04d}"

    def reg(self) -> str:
        self._reg += self.rng.randint(11, 97)
        return str(self._reg)

    def name(self) -> str:
        for _ in range(200):
            n = f"{self.rng.choice(NAME_A)} {self.rng.choice(NAME_B)}"
            if n not in self._used_names:
                self._used_names.add(n)
                return n
        # fall back to a numbered name if the pool is exhausted
        n = f"{self.rng.choice(NAME_A)} {self.rng.choice(NAME_B)} {len(self._used_names)}"
        self._used_names.add(n)
        return n

    def some_date(self) -> date:
        return START + timedelta(days=self.rng.randint(0, DAYS))

    def entity(self, eid: str, *, name=None, country=None, industry=None,
               incorp=None, bo=None, risk="Low", pep="N", etype=None) -> dict:
        row = {
            "entity_id": eid,
            "entity_name": name or self.name(),
            "account_number": self.acct(),
            "entity_type": etype or self.rng.choice(ENTITY_TYPES),
            "incorporation_country": country or self.rng.choice(LOW_RISK),
            "incorporation_date": d(incorp or date(self.rng.randint(1995, 2020),
                                                   self.rng.randint(1, 12), self.rng.randint(1, 28))),
            "industry": industry or self.rng.choice(INDUSTRIES),
            "registration_number": self.reg(),
            "beneficial_owner": bo or self.bo(),
            "kyc_risk_rating": risk,
            "pep_flag": pep,
            "onboarding_date": d(self.some_date()),
        }
        self.entities[eid] = row
        return row

    def txn(self, subject_id, cp, direction, amount, when, *, benef=None, orig=None, ttype=None):
        """One transaction row. direction 'D' = subject sent; 'C' = subject received."""
        key = "TXN" + "".join(self.rng.choice("0123456789ABCDEF") for _ in range(12))
        self.txns.append({
            "subject_id": subject_id,
            "counterparty_name": self.entities[cp]["entity_name"],
            "counterparty_account_number": self.entities[cp]["account_number"],
            "counterparty_id": cp,
            "transaction_key": key,
            "transaction_type": ttype or self.rng.choice(TXN_TYPES),
            "transaction_date": d(when),
            "originator_bank_country": orig or "GB",
            "beneficiary_bank_country": benef or "GB",
            "credit_debit_code": direction,
            "amount": f"{amount:.2f}",
        })

    def money(self, lo, hi) -> float:
        return round(self.rng.uniform(lo, hi), 2)

    # -- per-case counterparty pool ---------------------------------------
    def pool(self, case_idx: int, n: int = 55) -> list[str]:
        """Create n clean counterparties E1{idx}000..E1{idx}0NN and return ids."""
        ids = []
        for j in range(n):
            eid = f"E1{case_idx}{j:03d}"
            self.entity(eid)   # clean, low-risk defaults
            ids.append(eid)
        return ids

    def background(self, subject_id, cps, n_debit, n_credit):
        """Low-risk domestic-ish noise: unmatched, mostly GB/EU, modest amounts."""
        for _ in range(n_debit):
            cp = self.rng.choice(cps)
            benef = "GB" if self.rng.random() < 0.6 else self.rng.choice(LOW_RISK)
            self.txn(subject_id, cp, "D", self.money(500, 120000), self.some_date(), benef=benef)
        for _ in range(n_credit):
            cp = self.rng.choice(cps)
            orig = "GB" if self.rng.random() < 0.6 else self.rng.choice(LOW_RISK)
            self.txn(subject_id, cp, "C", self.money(500, 120000), self.some_date(), orig=orig)

    def wc(self, eid, category, status, score, severity):
        self.worldcheck.append({
            "entity_id": eid,
            "entity_name": self.entities.get(eid, {}).get("entity_name", "Unknown"),
            "match_category": category,
            "watchlist_source": self.rng.choice(WC_SOURCES),
            "match_status": status,
            "match_score": str(score),
            "severity": severity,
            "screening_date": d(self.some_date()),
        })

    def wl(self, eid, reason, risk="Medium"):
        self.watchlist.append({
            "entity_id": eid,
            "entity_name": self.entities.get(eid, {}).get("entity_name", "Unknown"),
            "list_type": "Internal AML Watchlist",
            "reason": reason,
            "risk_level": risk,
            "added_by": "TMS-AUTO",
            "date_added": d(self.some_date()),
            "active_flag": "Y",
        })

    # -- build --------------------------------------------------------------
    def build(self):
        # Five subjects (raw KYC only — the case file, not a data column, names them subject).
        subjects = [
            ("E00181", "Tradewind Commerce Ltd", "Freight & Logistics"),
            ("E00204", "Meridian Logistics PLC", "Commodity Trading"),
            ("E00337", "Halcyon Trading Group", "Import/Export"),
            ("E00452", "Sterling Bridge Holdings", "Financial Holdings"),
            ("E00519", "Orion Freight Services Ltd", "Freight & Logistics"),
        ]
        for eid, nm, ind in subjects:
            self.entity(eid, name=nm, country="GB", industry=ind, risk="Medium",
                        etype="Public Limited Company")
            self._used_names.add(nm)

        self._case1_outbound()
        self._case2_structuring()
        self._case3_sanctioned()
        self._case4_circular()
        self._case5_shell()
        self._cases_meta(subjects)

    # CASE-0001 — high-value outbound to high-risk jurisdictions (+ sanctioned corridor)
    def _case1_outbound(self):
        S = "E00181"
        cps = self.pool(0)
        self.background(S, cps[8:], 900, 520)
        # Six offshore "sink" counterparties incorporated in high-risk havens.
        sinks = cps[1:7]
        for cp in sinks:
            self.entities[cp]["incorporation_country"] = self.rng.choice(HIGH_RISK)
            self.entities[cp]["kyc_risk_rating"] = "High"
        # Many large debits routed abroad to high-risk beneficiary countries.
        for _ in range(140):
            cp = self.rng.choice(sinks)
            self.txn(S, cp, "D", self.money(150000, 690000), self.some_date(),
                     benef=self.rng.choice(HIGH_RISK), ttype="SWIFT")
        # One confirmed-sanctioned counterparty in that same corridor (corroborates).
        sanc = cps[4]
        self.entities[sanc]["kyc_risk_rating"] = "High"
        self.wc(sanc, "Sanctions", "Confirmed", self.rng.randint(85, 96), "High")
        for _ in range(28):
            self.txn(S, sanc, "D", self.money(180000, 620000), self.some_date(),
                     benef="IR", ttype="SWIFT")
        self.wl(cps[0], "High-risk jurisdiction exposure", "High")

    # CASE-0002 — structuring: many debits clustered just under £10k in a tight window
    def _case2_structuring(self):
        S = "E00204"
        cps = self.pool(1)
        self.background(S, cps[6:], 700, 480)
        smurfs = cps[1:5]
        window0 = self.rng.randint(30, 200)
        for _ in range(190):
            cp = self.rng.choice(smurfs)
            when = START + timedelta(days=window0 + self.rng.randint(0, 25))
            self.txn(S, cp, "D", self.money(8500, 9950), when,
                     benef=self.rng.choice(["GB", "DE", "NL"]), ttype="FASTER_PAYMENT")
        self.wc(cps[4], "Adverse Media", "Potential", self.rng.randint(60, 80), "Medium")
        self.wl(cps[0], "Rapid movement / possible structuring", "High")

    # CASE-0003 — sanctioned exposure: heavy volume to a confirmed-sanctioned cp + corridor
    def _case3_sanctioned(self):
        S = "E00337"
        cps = self.pool(2)
        self.background(S, cps[6:], 780, 500)
        sanc = cps[4]
        self.entities[sanc]["incorporation_country"] = self.rng.choice(["IR", "SY", "RU"])
        self.entities[sanc]["kyc_risk_rating"] = "High"
        self.wc(sanc, "Sanctions", "Confirmed", self.rng.randint(88, 97), "High")
        for _ in range(120):
            self.txn(S, sanc, "D", self.money(60000, 480000), self.some_date(),
                     benef=self.entities[sanc]["incorporation_country"], ttype="SWIFT")
        # A second sanctioned corridor counterparty (adverse media, still routed abroad).
        adverse = cps[5]
        self.entities[adverse]["kyc_risk_rating"] = "High"
        self.wc(adverse, "Adverse Media", "Potential", self.rng.randint(70, 85), "High")
        for _ in range(40):
            self.txn(S, adverse, "D", self.money(50000, 300000), self.some_date(),
                     benef=self.rng.choice(["RU", "SY", "IR"]), ttype="SWIFT")
        self.wl(cps[0], "Sanctioned-jurisdiction corridor", "High")

    # CASE-0004 — circular fund-flow: matched reciprocal round-trips
    def _case4_circular(self):
        S = "E00452"
        cps = self.pool(3)
        self.background(S, cps[6:], 760, 300)
        loopers = cps[1:6]
        for cp in loopers:
            self.entities[cp]["kyc_risk_rating"] = "Medium"
            for _ in range(22):
                amt = self.money(40000, 300000)
                out = self.some_date()
                back = out + timedelta(days=self.rng.randint(1, 5))
                self.txn(S, cp, "D", amt, out, benef="GB", ttype="CHAPS")
                # returned within a few days at ~the same amount (matched round-trip)
                self.txn(S, cp, "C", round(amt * self.rng.uniform(0.985, 1.0), 2), back,
                         orig="GB", ttype="CHAPS")
        self.wl(cps[0], "Circular fund-flow participant", "High")

    # CASE-0005 — shell linkage: >=3 funded cps share a beneficial owner AND are offshore
    def _case5_shell(self):
        S = "E00519"
        cps = self.pool(4)
        self.background(S, cps[6:], 820, 520)
        shell_bo = "BO90019"
        shells = cps[1:5]
        for cp in shells:
            self.entities[cp]["beneficial_owner"] = shell_bo
            self.entities[cp]["incorporation_country"] = self.rng.choice(OFFSHORE)
            self.entities[cp]["incorporation_date"] = d(date(self.rng.randint(2023, 2025),
                                                             self.rng.randint(1, 12), self.rng.randint(1, 28)))
            self.entities[cp]["entity_type"] = "Private Limited Company"
            self.entities[cp]["industry"] = "Financial Holdings"
            self.entities[cp]["kyc_risk_rating"] = "High"
            for _ in range(55):
                self.txn(S, cp, "D", self.money(30000, 260000), self.some_date(),
                         benef=self.entities[cp]["incorporation_country"], ttype="WIRE")
        self.wl(shells[0], "Offshore shell-linkage cluster", "High")

    def _cases_meta(self, subjects):
        meta = [
            ("CASE-2026-0001", "18/01/2026", "High-value outbound to high-risk jurisdiction", "Pending EDD", "R. Chen"),
            ("CASE-2026-0002", "14/02/2026", "Rapid movement of funds / structuring pattern", "In Review", "S. Okafor"),
            ("CASE-2026-0003", "12/05/2026", "Sanctioned-jurisdiction corridor exposure", "Open", "A. Morgan"),
            ("CASE-2026-0004", "26/02/2026", "Circular fund-flow anomaly detected", "Open", "L. Rossi"),
            ("CASE-2026-0005", "28/04/2026", "Offshore shell-linkage cluster", "In Review", "S. Okafor"),
        ]
        for (cid, adate, reason, status, analyst), (eid, nm, _ind) in zip(meta, subjects):
            self.cases.append({
                "case_id": cid,
                "subject_id": eid,
                "subject_name": nm,
                "account_number": self.entities[eid]["account_number"],
                "alert_date": adate,
                "trigger_reason": reason,
                "alert_type": "Transaction Monitoring",
                "case_status": status,
                "assigned_analyst": analyst,
                "priority": "High",
                "jurisdiction": "GB",
            })

    # -- write --------------------------------------------------------------
    def write(self):
        self.rng.shuffle(self.txns)  # interleave so files don't group by subject
        _dump("cases.csv", self.cases, DATA_DIR)
        _dump("kyc.csv", list(self.entities.values()), DATA_DIR)
        _dump("transactions.csv", self.txns, DATA_DIR)
        _dump("worldcheck.csv", self.worldcheck, DATA_DIR)
        _dump("watchlist.csv", self.watchlist, DATA_DIR)


def _dump(name: str, rows: list[dict], out: Path):
    with open(out / name, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"  wrote {name}: {len(rows)} rows")


def main():
    g = Gen()
    g.build()
    g.write()
    print(f"done (seed={SEED}): {len(g.entities)} entities, {len(g.txns)} txns, "
          f"{len(g.worldcheck)} worldcheck, {len(g.watchlist)} watchlist, {len(g.cases)} cases")


if __name__ == "__main__":
    main()
