"""Deterministic synthetic-data generator for the A_NIRE Case Console.

WHY this exists
---------------
The counterparty network is fundamentally a **transaction graph**: each alerted
subject sits at the root of a multi-hop network — subject → n counterparties →
each of those → m sub-counterparties → … out to k hops. KYC and World-Check are
node attributes that ride along for the hover tooltip; they are never edges.

Shape of the network (user spec):
  * Depth per subject varies from MIN_HOP to MAX_HOP (4–7): every alerted subject
    has a genuinely deep k-hop network, not a shallow star.
  * The six networks are **not islands** — alerted subjects transact with one
    another (a directed peer ring) and **share common counterparties** (a subject
    also funds benign nodes that live in another subject's network). The whole
    thing is one connected graph; a *case* is still every edge carrying that
    subject_id. Some benign counterparty pairs also trade **both ways** (a debit
    one direction, a credit the other) — two opposite directed edges on the pair.
  * Every alerted subject has **both debit and credit** flow: alongside the money
    it sends out, income counterparties (customers) pay it — added as pure sources
    so they can never close a circular loop back through the subject.
  * **Typologies live deep, not on the first hop.** Real laundering hides behind
    layers of cut-outs, so signals are planted 2–5 hops out: sanctioned exposure
    down a funded corridor, high-risk outbound + structuring fired by an
    *intermediary* (not the subject), a shell cluster at hop 3, and circular flow
    as a long loop that passes through several counterparties before returning to
    the originator (subject → c1 → c11 → c112 → R → subject). Cash-structuring is
    a layering pass-through: a big CASH deposit lands on a node and leaves as many
    sub-£10k WIREs (~97–100% of what came in) fanned out across hops 3–5.
  * Transaction volume is realistic: relationships transact repeatedly across the
    12-month window, topped up to TARGET_ROWS total rows.

Crucially — per the design principle — the CSVs carry **raw attributes only**;
they never contain a "shell"/"sanctioned"/"structuring" label. Each typology is
planted as raw signal (large offshore debits, near-threshold amounts, a genuine
closed loop, shared beneficial owners + offshore incorporation, a confirmed
World-Check hit) and the backend detectors *derive* the pattern by traversing the
graph. Every benign edge added for depth/volume/connectivity is deliberately kept
*outside* every detector's firing conditions (see _safe-by-construction notes on
link_subjects / topup), so the acceptance scores are untouched.

Deterministic: a fixed seed reproduces the dataset — and the acceptance scores —
exactly. Re-generate with:  python backend/synthdata.py

Transaction schema is an EDGE LIST so counterparty→counterparty flow at any depth
is representable:
    subject_id, from_id, from_name, to_id, to_name, transaction_key,
    transaction_type, transaction_date, originator_bank_country,
    beneficiary_bank_country, amount, hop
`subject_id` is the case root the edge belongs to; `hop` is the depth of the
edge's child endpoint from that subject (1 = direct counterparty … up to 7).

The six cases (typology planted deep as raw signal → derived detector):
  0001 Tradewind  multi   hop-3 sanctioned corridor + hop-2 intermediary high-risk debits  -> sanctioned + high_risk_outbound          (SAR 0.76)
  0002 Meridian   multi   hop-2 cash-in/layer-out + a long subject->..->subject loop        -> structuring + circular                   (SAR 0.74)
  0003 Halcyon    multi   hop-3 sanctioned + hop-3 offshore shell cluster + intermediary hr -> sanctioned + shell + high_risk_outbound  (SAR 1.00, capped)
  0004 Sterling   single  a long circular loop through several counterparties               -> circular                                 (EDD 0.38)
  0005 Orion      CLEAR   benign multi-hop network only                                     -> nothing                                  (CLEAR 0.00)
  0006 Kingfisher CLEAR   benign multi-hop network only                                     -> nothing                                  (CLEAR 0.00)
"""

from __future__ import annotations

import csv
import random
from datetime import date, timedelta
from pathlib import Path

SEED = 20260701
DATA_DIR = Path(__file__).resolve().parent / "data"

# --- Network shape ----------------------------------------------------------
# Per-hop fan-out, sliced to each subject's depth. Wide near the subject, then
# narrowing into chains so the network reaches deep (hop 7) without exploding.
# BRANCH[0] must be >= 6: the sanctioned planter uses levels[1][5] alongside the
# five high-risk sinks at levels[1][:5], so hop-1 needs at least six nodes.
BRANCH = [6, 3, 2, 2, 1, 1, 1]
MIN_HOP, MAX_HOP = 4, 7
CASE_DEPTHS = [7, 6, 5, 4, 6, 7]           # one per case; spans MIN_HOP..MAX_HOP
TARGET_ROWS = 30_000                        # total transaction rows to emit

# --- Time window: the trailing 12 months from "today" -----------------------
# Anchored to a fixed TODAY so the dataset stays reproducible; every transaction
# date lands in [START, TODAY] = the last 365 days, never in the future.
TODAY = date(2026, 7, 1)
START = TODAY - timedelta(days=365)         # 2025-07-01
DAYS = 365

LOW_RISK = ["GB", "DE", "FR", "NL", "IE", "US", "CA", "AU", "JP", "SE", "ES", "IT", "CH"]
HIGH_RISK = ["IR", "SY", "RU", "KY", "VG", "PA", "SC", "CY", "AE"]
OFFSHORE = ["VG", "KY", "PA", "SC"]
# Only four instruments (user spec). They carry meaning: CASH is how bulk value
# enters a node; WIRE is how it is layered back out; POS_DEBIT / CHEQUE are
# ordinary retail-style background traffic.
TXN_TYPES = ["wire", "cash", "pos_debit", "cheque"]
INDUSTRIES = ["Freight & Logistics", "Commodity Trading", "Import/Export", "Shipping",
              "Wholesale Trade", "Precious Metals", "Real Estate", "Financial Holdings",
              "Consulting Services", "Manufacturing"]
ENTITY_TYPES = ["Public Limited Company", "Private Limited Company",
                "Limited Liability Partnership", "Sole Trader"]
NAME_A = ["Apex", "Quill", "Nova", "Atlas", "Onyx", "Summit", "Harbour", "Beacon",
          "Cobalt", "Crest", "Delta", "Vertex", "Silverline", "Northgate", "Pallas",
          "Cascade", "Aurora", "Zephyr", "Granite", "Ironclad", "Marlin", "Pinnacle",
          "Regent", "Titan", "Verano", "Willow", "Cedar", "Draco", "Ember", "Fable",
          "Gale", "Hollow", "Indigo", "Juniper", "Kestrel", "Lumen", "Mosaic", "Nimbus",
          "Orbit", "Peregrine", "Quartz", "Rhodium", "Sable", "Talon", "Umbra", "Vantage",
          "Wraith", "Yardarm", "Zenith", "Argent", "Bramble", "Corvus", "Dune", "Everest"]
NAME_B = ["Group", "Holdings", "Partners", "Global", "Ventures", "Enterprises",
          "Consulting", "Trading", "Ltd", "Capital", "Industries", "Logistics",
          "Associates", "Commerce", "Maritime", "Systems"]
WC_SOURCES = ["OFAC SDN", "EU Consolidated", "UN Sanctions", "HM Treasury", "Interpol"]


def d(dt: date) -> str:
    return dt.strftime("%d/%m/%Y")


class Gen:
    def __init__(self):
        self.rng = random.Random(SEED)
        self.entities: dict[str, dict] = {}
        self.txns: list[dict] = []
        self.worldcheck: list[dict] = []
        self.watchlist: list[dict] = []
        self.cases: list[dict] = []
        self._acct = 10000000
        self._reg = 1000000
        self._bo = 1000
        self._cid = 0
        self._used_names: set[str] = set()
        # network bookkeeping
        self.hop_of: dict[str, int] = {}        # cp id -> depth from its subject
        self.tree: dict[str, tuple] = {}        # sid -> (levels, parent, depth)
        self.pool: dict[str, list] = {}         # sid -> benign cp ids (shareable/top-uppable)
        self.signal: set[str] = set()           # planted nodes (never shared/altered by benign traffic)

    # -- primitive helpers -------------------------------------------------
    def acct(self):
        self._acct += self.rng.randint(101, 947); return str(self._acct)

    def reg(self):
        self._reg += self.rng.randint(11, 97); return str(self._reg)

    def bo(self):
        self._bo += self.rng.randint(1, 9); return f"BO{self._bo:04d}"

    def cp(self):
        self._cid += 1; return f"C{self._cid:05d}"

    def name(self):
        for _ in range(400):
            n = f"{self.rng.choice(NAME_A)} {self.rng.choice(NAME_B)}"
            if n not in self._used_names:
                self._used_names.add(n); return n
        n = f"{self.rng.choice(NAME_A)} {self.rng.choice(NAME_B)} {len(self._used_names)}"
        self._used_names.add(n); return n

    def some_date(self):
        return START + timedelta(days=self.rng.randint(0, DAYS))

    def money(self, lo, hi):
        return round(self.rng.uniform(lo, hi), 2)

    def benign_amount(self):
        """A benign amount that can never look like structuring: outside the
        near-threshold band and below the high-value cutoff. Combined with a
        low-risk beneficiary country (all benign traffic uses one), no benign
        edge can trip high_risk_outbound or structuring."""
        a = self.money(500, 120000)
        while 8000 <= a < 10000:                 # keep clear of STRUCTURING_BAND
            a = self.money(500, 120000)
        return a

    def entity(self, eid, *, name=None, country=None, industry=None, incorp=None,
               bo=None, risk="Low", pep="N", etype=None):
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

    def edge(self, subject_id, frm, to, amount, when, hop, *, benef=None, orig=None, ttype=None):
        """One transaction (directed money movement frm -> to) in subject's network."""
        if when > TODAY:                          # never emit a future-dated txn
            when = TODAY
        key = "TXN" + "".join(self.rng.choice("0123456789ABCDEF") for _ in range(12))
        self.txns.append({
            "subject_id": subject_id,
            "from_id": frm,
            "from_name": self.entities[frm]["entity_name"],
            "to_id": to,
            "to_name": self.entities[to]["entity_name"],
            "transaction_key": key,
            "transaction_type": ttype or self.rng.choice(TXN_TYPES),
            "transaction_date": d(when),
            "originator_bank_country": orig or self.entities[frm]["incorporation_country"],
            "beneficiary_bank_country": benef or self.entities[to]["incorporation_country"],
            "amount": f"{amount:.2f}",
            "hop": hop,
        })

    def wc(self, eid, category, status, score, severity):
        self.worldcheck.append({
            "entity_id": eid, "entity_name": self.entities[eid]["entity_name"],
            "match_category": category, "watchlist_source": self.rng.choice(WC_SOURCES),
            "match_status": status, "match_score": str(score), "severity": severity,
            "screening_date": d(self.some_date()),
        })

    def wl(self, eid, reason, risk="Medium"):
        self.watchlist.append({
            "entity_id": eid, "entity_name": self.entities[eid]["entity_name"],
            "list_type": "Internal AML Watchlist", "reason": reason, "risk_level": risk,
            "added_by": "TMS-AUTO", "date_added": d(self.some_date()), "active_flag": "Y",
        })

    # -- network construction ---------------------------------------------
    def build_tree(self, subject_id, depth):
        """Create the subject's k-hop counterparty tree to `depth`; return (levels, parent)."""
        levels = {0: [subject_id]}
        parent = {}
        for hop in range(1, depth + 1):
            cur = []
            for p in levels[hop - 1]:
                for _ in range(BRANCH[hop - 1]):
                    eid = self.cp()
                    self.entity(eid)
                    parent[eid] = p
                    self.hop_of[eid] = hop
                    cur.append(eid)
            levels[hop] = cur
        return levels, parent

    def base_flows(self, subject_id, levels, parent, depth):
        """Benign volume along every parent->child relationship (money flows outward,
        so the graph stays acyclic — no benign edge can create a circular loop)."""
        for hop in range(1, depth + 1):
            for child in levels[hop]:
                p = parent[child]
                for _ in range(self.rng.randint(2, 4)):
                    benef = "GB" if self.rng.random() < 0.6 else self.rng.choice(LOW_RISK)
                    self.edge(subject_id, p, child, self.benign_amount(),
                              self.some_date(), hop, benef=benef)

    # -- tree navigation (used to place typologies deep) -------------------
    def _children(self, levels, parent, node):
        """Direct children of `node` in its subject's tree."""
        h = self.hop_of.get(node, 0)            # subject has no hop entry -> 0
        return [c for c in levels.get(h + 1, []) if parent.get(c) == node]

    def _chain(self, levels, parent, node, length):
        """A downward chain of `length` nodes starting at `node`'s first child."""
        out = []
        cur = node
        for _ in range(length):
            kids = self._children(levels, parent, cur)
            if not kids:
                break
            cur = kids[0]
            out.append(cur)
        return out

    def _subtree(self, levels, parent, root):
        """All descendants of `root` (every hop below it)."""
        depth = max(levels)
        out, frontier = [], {root}
        for h in range(self.hop_of.get(root, 0) + 1, depth + 1):
            kids = [c for c in levels[h] if parent.get(c) in frontier]
            if not kids:
                break
            out += kids
            frontier = set(kids)
        return out

    def fund_from_subject(self, S, parent, node, amount, ttype="wire", n=6):
        """Route `amount` from the subject down to `node` along its ancestor chain
        (S -> a1 -> ... -> node), so the money `node` later moves on is TRACEABLE to
        the subject rather than appearing from nowhere at a cut-out.

        The legs carry real magnitude but stay benign by construction — benef "GB"
        and strictly outward — so they can't trip high-risk (needs a high-risk
        beneficiary), structuring (not near-threshold) or circular (never points
        back at the subject). Detection is unaffected; only the money trail becomes
        realistic ("what the actor pushes out, it first received from the subject").
        """
        chain = [node]
        cur = node
        while cur != S:
            cur = parent.get(cur, S)
            chain.append(cur)
        chain.reverse()                                   # [S, a1, ..., node]
        per = round(amount / n, 2)
        for _ in range(n):
            t0 = self.some_date()
            for k in range(len(chain) - 1):
                self.edge(S, chain[k], chain[k + 1], per, t0 + timedelta(days=k),
                          self.hop_of.get(chain[k + 1], 1), benef="GB", ttype=ttype)

    # -- typology planting (raw signal only, deep in the network) ----------
    def plant_high_risk_outbound(self, S, levels, parent):
        # A hop-2 intermediary — not the subject — pushes many high-value debits
        # out to high-risk jurisdictions (the subject's funds reach the corridor
        # through a cut-out). The detector groups by sender, so it fires on the
        # intermediary wherever it sits.
        H = self._children(levels, parent, levels[1][2])[0]      # a hop-2 node
        self.signal.add(H)
        sinks = self._subtree(levels, parent, H)[:6] or self._children(levels, parent, H)
        for cp in sinks:
            self.entities[cp]["incorporation_country"] = self.rng.choice(HIGH_RISK)
            self.entities[cp]["kyc_risk_rating"] = "High"
            self.signal.add(cp)
        debits = [self.money(150000, 690000) for _ in range(16)]
        # The subject first feeds H (through a cut-out) ~what it will push out, so
        # the high-risk corridor's money traces back to the subject.
        self.fund_from_subject(S, parent, H, sum(debits), ttype="wire", n=8)
        for amt in debits:
            cp = self.rng.choice(sinks)
            self.edge(S, H, cp, amt, self.some_date(),
                      self.hop_of[cp], benef=self.rng.choice(HIGH_RISK), ttype="wire")

    def plant_sanctioned(self, S, levels, parent):
        # The sanctioned party sits at hop 3, reached down a funded corridor
        # subject -> i1 -> i2 -> sanc. The detector walks the network (shortestPath
        # within k hops) to find it — it is not a direct counterparty.
        i1 = levels[1][5]
        chain = self._chain(levels, parent, i1, 2)               # [i2, sanc]
        i2, sanc = chain[0], chain[1]
        self.signal.update([i1, i2, sanc])
        self.entities[sanc]["incorporation_country"] = self.rng.choice(["IR", "SY", "RU"])
        self.entities[sanc]["kyc_risk_rating"] = "High"
        self.wc(sanc, "Sanctions", "Confirmed", self.rng.randint(88, 96), "High")
        hops = [(S, i1, 1), (i1, i2, 2), (i2, sanc, 3)]
        for _ in range(6):
            t0 = self.some_date()
            for k, (frm, to, hp) in enumerate(hops):
                benef = self.entities[sanc]["incorporation_country"] if to == sanc else "GB"
                self.edge(S, frm, to, self.money(60000, 480000),
                          t0 + timedelta(days=k), hp, benef=benef, ttype="wire")
        # a non-firing adverse-media hit elsewhere in the network (realism)
        self.wc(levels[2][0], "Adverse Media", "Potential", self.rng.randint(60, 80), "Medium")

    def plant_structuring(self, S, levels, parent):
        # Cash-structuring / layering DEEP in the network: a hop-2 hub takes in one
        # big CASH deposit, then layers ~97–100% of it back out as many sub-£10k
        # WIREs to counterparties across hops 3–5, all inside the structuring
        # window. Detector groups near-threshold debits by sender -> fires on hub.
        hub = self._children(levels, parent, levels[1][1])[0]    # a hop-2 node
        self.signal.add(hub)
        targets = self._subtree(levels, parent, hub) or [hub]
        n = self.rng.randint(40, 60)
        wires = [self.money(8500, 9950) for _ in range(n)]
        big = round(sum(wires) / self.rng.uniform(0.97, 1.0), 2)  # cash-in ~= what leaves
        t0 = START + timedelta(days=self.rng.randint(0, 300))
        # The big cash the hub structures out originates at the SUBJECT: route it
        # down the corridor S -> cut-out -> hub (as cash), so the hub receives what
        # it launders rather than the money materialising at a cut-out.
        self.fund_from_subject(S, parent, hub, big, ttype="cash", n=1)
        for w in wires:
            cp = self.rng.choice(targets)
            self.edge(S, hub, cp, w, t0 + timedelta(days=self.rng.randint(0, 44)),
                      self.hop_of[cp], benef="GB", ttype="wire")

    def plant_circular(self, S, levels, parent):
        # A long circular loop that passes through several counterparties before
        # returning to the originator: subject -> c1 -> c11 -> c112 -> R -> subject
        # (length 5). R is a dedicated return node reachable ONLY via c112, so the
        # shortest closed loop the detector finds is the long one.
        c1 = levels[1][0]
        c11, c112 = self._chain(levels, parent, c1, 2)
        R = self.cp()
        self.entity(R, country="GB", risk="Medium")
        self.hop_of[R] = 4
        self.signal.update([c1, c11, c112, R])
        legs = [(S, c1, 1), (c1, c11, 2), (c11, c112, 3), (c112, R, 4)]
        for _ in range(8):
            amt = self.money(40000, 300000)
            t0 = START + timedelta(days=self.rng.randint(0, 340))
            for k, (frm, to, hp) in enumerate(legs):
                self.edge(S, frm, to, round(amt * self.rng.uniform(0.99, 1.0), 2),
                          t0 + timedelta(days=k), hp, benef="GB", ttype="wire")
            # ...and back to the subject: 97–100% of what left completes the loop.
            self.edge(S, R, S, round(amt * self.rng.uniform(0.97, 1.0), 2),
                      t0 + timedelta(days=4), 5, benef="GB", ttype="wire")

    def plant_shell(self, S, levels, parent):
        shells = levels[3][:4]                  # a hop-3 cluster funded via hop-2 cut-outs
        self.signal.update(shells)
        shell_bo = f"BO9{len(self.cases)}019"
        forwarded: dict[str, float] = {}        # hop-2 cut-out -> total it sends to shells
        for cp in shells:
            self.entities[cp]["beneficial_owner"] = shell_bo
            self.entities[cp]["incorporation_country"] = self.rng.choice(OFFSHORE)
            self.entities[cp]["incorporation_date"] = d(date(self.rng.randint(2023, 2025),
                                                             self.rng.randint(1, 12), self.rng.randint(1, 28)))
            self.entities[cp]["entity_type"] = "Private Limited Company"
            self.entities[cp]["kyc_risk_rating"] = "High"
            amts = [self.money(30000, 260000) for _ in range(6)]
            forwarded[parent[cp]] = forwarded.get(parent[cp], 0.0) + sum(amts)
            for a in amts:
                self.edge(S, parent[cp], cp, a, self.some_date(),
                          self.hop_of[cp], benef=self.entities[cp]["incorporation_country"], ttype="wire")
        # The subject feeds each hop-2 cut-out ~what it forwards to the shells, so
        # the shell funding traces back to the subject instead of appearing at the
        # cut-out.
        for cutout, total in forwarded.items():
            self.fund_from_subject(S, parent, cutout, total, ttype="wire", n=6)

    # -- cross-network connectivity (safe-by-construction) -----------------
    def link_subjects(self):
        """Wire the six networks together: a directed peer ring (subjects transact
        with each other) plus shared counterparties (each subject also funds two
        benign nodes that belong to another subject's network).

        Every edge here is benign by construction — it flows *outward* (never back
        into a subject, so no circular loop), carries a benign amount + a GB
        beneficiary (so neither high_risk_outbound nor structuring can fire), and
        only ever targets a *benign* node (never a sanctioned/shell/signal node,
        so no sanctioned/shell exposure leaks across cases). Detection stays
        exactly where it was planted.
        """
        subs = [c["subject_id"] for c in self.cases]
        # (a) peer ring: S_i -> S_(i+1). Tagged with the sender's subject_id, so it
        #     appears as a hop-1 peer in the sender's network and is invisible to
        #     the receiver's detectors (which filter on their own subject_id).
        for i, s in enumerate(subs):
            nxt = subs[(i + 1) % len(subs)]
            for _ in range(self.rng.randint(3, 5)):
                self.edge(s, s, nxt, self.benign_amount(), self.some_date(), 1,
                          benef="GB", ttype="wire")
        # (b) shared counterparties: subject s also funds two deep benign nodes
        #     that live in the previous subject's network.
        for i, s in enumerate(subs):
            donor = subs[(i - 1) % len(subs)]
            donor_pool = [c for c in self.pool[donor] if self.hop_of.get(c, 1) >= 3]
            mine_deep = [c for c in self.pool[s] if self.hop_of.get(c, 1) >= 3]
            if not donor_pool or not mine_deep:
                continue
            for shared in self.rng.sample(donor_pool, min(2, len(donor_pool))):
                src = self.rng.choice(mine_deep)
                hop = min(self.hop_of[src] + 1, MAX_HOP)
                for _ in range(self.rng.randint(2, 4)):
                    self.edge(s, src, shared, self.benign_amount(), self.some_date(),
                              hop, benef="GB")

    def add_reciprocal_flows(self):
        """Give some counterparties genuine two-way relationships: where a benign
        parent already pays a child, add the reverse leg (child pays the parent
        back) so the pair trades in both directions. Direction is from_id->to_id,
        so this shows up as two opposite directed edges between the same pair — a
        debit one way, a credit the other.

        Safe-by-construction: both endpoints are benign, non-subject counterparties
        (never the subject, never a signal node), the reverse leg carries a benign
        amount to a low-risk country, and it points INTO a counterparty — never
        into the subject — so it cannot create a subject loop or trip any detector.
        """
        for sid, (levels, parent, depth) in self.tree.items():
            cands = [(parent[c], c) for h in range(2, depth + 1) for c in levels[h]
                     if c not in self.signal and parent[c] not in self.signal
                     and parent[c] != sid]
            if not cands:
                continue
            for p, c in self.rng.sample(cands, min(len(cands), self.rng.randint(12, 20))):
                for _ in range(self.rng.randint(3, 6)):
                    # reverse leg c -> p; hop = the deeper endpoint's depth (c), so
                    # the relationship stays tagged at the level it lives on.
                    self.edge(sid, c, p, self.benign_amount(), self.some_date(),
                              self.hop_of[c], benef="GB")

    def add_subject_income(self):
        """Give every alerted subject realistic CREDIT flow — a real business
        RECEIVES money as well as sending it. Income counterparties (the subject's
        customers) pay the subject, some via a shallow upstream of their own.

        Safe-by-construction: every income counterparty is a PURE SOURCE — the
        subject never pays it back — so no path subject->...->payer exists and the
        circular detector can never form a loop through it. Benign amounts to a
        low-risk country keep the credit flow clear of every other detector too.
        """
        for sid, (levels, parent, depth) in self.tree.items():
            for _ in range(self.rng.randint(6, 9)):
                payer = self.cp()
                self.entity(payer)
                self.hop_of[payer] = 1
                for _ in range(self.rng.randint(6, 14)):
                    self.edge(sid, payer, sid, self.benign_amount(), self.some_date(),
                              1, benef="GB")
                # ~60% of customers have their own upstream sources (credit depth).
                if self.rng.random() < 0.6:
                    for _ in range(self.rng.randint(1, 2)):
                        src = self.cp()
                        self.entity(src)
                        self.hop_of[src] = 2
                        for _ in range(self.rng.randint(2, 4)):
                            self.edge(sid, src, payer, self.benign_amount(),
                                      self.some_date(), 2, benef="GB")

    def add_direct_two_way(self):
        """Give every subject a couple of DIRECT (hop-1) TWO-WAY counterparties: a
        benign hop-1 node that BOTH receives from the subject (debit) AND pays it
        back (credit). This is what the per-direction graph sliders need a node for
        — so an analyst can drop the debit edge while keeping the credit edge (and
        vice-versa) on a single counterparty.

        Uses hop-1 slots [3] and [4], which no planter ever touches (they use
        [0]/[1]/[2]/[5]), so the node stays benign. Safe-by-construction: benign
        amounts to GB, and the return leg only closes a 2-cycle (subject->cp->
        subject) — shortestPath(subject->cp)=1, which the circular detector
        EXPLICITLY excludes (it needs a forward path >=2). No detector moves, so the
        acceptance scores are unchanged. The debit and credit legs use independent
        counts/amounts (a genuine trading relationship, not a wash round-trip)."""
        for sid, (levels, parent, depth) in self.tree.items():
            for idx in (3, 4):
                cp = levels[1][idx]
                if cp in self.signal:
                    continue
                # extra outbound (debit) so the node's debit share is non-trivial
                for _ in range(self.rng.randint(6, 10)):
                    self.edge(sid, sid, cp, self.benign_amount(), self.some_date(), 1, benef="GB")
                # inbound (credit) back to the subject — the second direction
                for _ in range(self.rng.randint(8, 14)):
                    self.edge(sid, cp, sid, self.benign_amount(), self.some_date(), 1, benef="GB")

    def topup_to_target(self):
        """Inflate to exactly TARGET_ROWS with benign recurring business along
        existing benign parent->child relationships (realistic: counterparties
        transact repeatedly across the year). Signal nodes are excluded, and every
        top-up is a benign_amount to a low-risk country flowing outward — so the
        fill can never create or destroy a typology."""
        rels = []
        for sid, (levels, parent, depth) in self.tree.items():
            for hop in range(1, depth + 1):
                for child in levels[hop]:
                    p = parent[child]
                    if child in self.signal or p in self.signal:
                        continue
                    rels.append((sid, p, child, hop))
        while len(self.txns) < TARGET_ROWS and rels:
            sid, p, c, hop = self.rng.choice(rels)
            benef = "GB" if self.rng.random() < 0.7 else self.rng.choice(LOW_RISK)
            self.edge(sid, p, c, self.benign_amount(), self.some_date(), hop, benef=benef)

    # -- assemble ----------------------------------------------------------
    def build(self):
        cfg = [
            ("E00181", "Tradewind Commerce Ltd", "Freight & Logistics",
             ["high_risk_outbound", "sanctioned"],
             "CASE-2026-0001", "18/01/2026", "High-value outbound to high-risk jurisdiction", "Pending EDD", "R. Chen", "High"),
            ("E00204", "Meridian Logistics PLC", "Commodity Trading",
             ["structuring", "circular"],
             "CASE-2026-0002", "14/02/2026", "Rapid movement of funds / structuring pattern", "In Review", "S. Okafor", "High"),
            ("E00337", "Halcyon Trading Group", "Import/Export",
             ["sanctioned", "high_risk_outbound"],
             "CASE-2026-0003", "12/05/2026", "Sanctioned-jurisdiction corridor exposure", "Open", "A. Morgan", "High"),
            ("E00452", "Sterling Bridge Holdings", "Financial Holdings",
             ["circular"],
             "CASE-2026-0004", "26/02/2026", "Circular fund-flow anomaly detected", "Open", "L. Rossi", "High"),
            ("E00519", "Orion Freight Services Ltd", "Freight & Logistics",
             ["shell", "high_risk_outbound", "sanctioned"],
             "CASE-2026-0005", "28/04/2026", "Elevated counterparty volume — periodic review", "In Review", "S. Okafor", "Medium"),
            ("E00637", "Kingfisher Retail Group", "Retail Trade",
             [],
             "CASE-2026-0006", "05/06/2026", "Periodic KYC review — routine screening", "Open", "R. Chen", "Low"),
        ]
        for idx, (sid, nm, ind, typ, cid, adate, reason, status, analyst, prio) in enumerate(cfg):
            self.entity(sid, name=nm, country="GB", industry=ind, risk="Medium",
                        etype="Public Limited Company")
            self._used_names.add(nm)
            depth = CASE_DEPTHS[idx]
            levels, parent = self.build_tree(sid, depth)
            self.tree[sid] = (levels, parent, depth)
            self.base_flows(sid, levels, parent, depth)
            if "high_risk_outbound" in typ: self.plant_high_risk_outbound(sid, levels, parent)
            if "sanctioned" in typ: self.plant_sanctioned(sid, levels, parent)
            if "structuring" in typ: self.plant_structuring(sid, levels, parent)
            if "circular" in typ: self.plant_circular(sid, levels, parent)
            if "shell" in typ: self.plant_shell(sid, levels, parent)
            # benign shareable pool = this subject's cps that carry no planted signal
            self.pool[sid] = [c for h in range(1, depth + 1) for c in levels[h]
                              if c not in self.signal]
            self.wl(levels[1][0], f"{reason} — flagged for review",
                    "Low" if not typ else "High")
            self.cases.append({
                "case_id": cid, "subject_id": sid, "subject_name": nm,
                "account_number": self.entities[sid]["account_number"], "alert_date": adate,
                "trigger_reason": reason, "alert_type": "Transaction Monitoring",
                "case_status": status, "assigned_analyst": analyst, "priority": prio,
                "jurisdiction": "GB",
            })
        # connect the six networks, add two-way counterparty relationships, give
        # every subject inbound (credit) flow, then inflate to the target row count.
        self.link_subjects()
        self.add_reciprocal_flows()
        self.add_subject_income()
        self.add_direct_two_way()
        self.topup_to_target()

    def write(self):
        self.rng.shuffle(self.txns)
        _dump("cases.csv", self.cases)
        _dump("kyc.csv", list(self.entities.values()))
        _dump("transactions.csv", self.txns)
        _dump("worldcheck.csv", self.worldcheck)
        _dump("watchlist.csv", self.watchlist)


def _dump(name, rows):
    with open(DATA_DIR / name, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    print(f"  wrote {name}: {len(rows)} rows")


def main():
    g = Gen(); g.build(); g.write()
    hops = sorted({int(t["hop"]) for t in g.txns})
    print(f"done (seed={SEED}): {len(g.entities)} entities, {len(g.txns)} txns, "
          f"{len(g.worldcheck)} worldcheck, {len(g.watchlist)} watchlist, {len(g.cases)} cases")
    print(f"  hop range in txns: {hops[0]}..{hops[-1]}  (depths {CASE_DEPTHS})")


if __name__ == "__main__":
    main()
