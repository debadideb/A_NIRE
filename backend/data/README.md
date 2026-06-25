# Synthetic data — A_NIRE Case Console

Five CSVs that drive the whole demo for **CASE-2026-0001** (subject **E001**, Tradewind Commerce
Ltd). Inputs carry **raw attributes only**. No file contains a "shell" or "sanctioned" or "risk"
label — those are **derived** during ingestion (see rules below). If you ever feel tempted to edit
these files to make the score come out right, stop: **the detectors are wrong, not the data.**

## File → source → detector map
| File | Real-world source it stands in for | Feeds |
|------|------------------------------------|-------|
| `cases.csv` | Case management / alert queue | The subject + trigger; one pre-built case |
| `kyc.csv` | KYC / company registry | `:Entity` nodes; shell-linkage signal (nominee + shared address) |
| `transactions.csv` | Transaction monitoring (TM) | `:SENT` edges; circular-flow + sanctioned-exposure detectors |
| `worldcheck.csv` | World-Check screening | Derives `:Sanctioned`; sanctioned-exposure detector |
| `watchlist.csv` | Internal FCC watchlist | Source-integration proof (0 in-network hits by design) |

## Ingestion rules (authoritative)
1. **Subject** comes from `cases.csv.subject_entity_id` (E001) — never inferred from a data column.
2. Build one **`:Entity`** node per row of `kyc.csv` (key = `entity_id`).
3. Build **`:SENT`** edges from `transactions.csv` (`from_entity_id` → `to_entity_id`, with amount,
   date, channel).
4. **Derive `:Sanctioned`** for any entity with a `worldcheck.csv` row whose
   `match_strength ≥ 0.85` and `category = sanctions`. (Here: **E006** at 0.95.)
5. **Derive shell risk** for entities that are BOTH `kyc_status = nominee` AND share a normalized
   `registered_address` with another entity. (Here: **E007, E008, E009**.)
6. **Screening rows with no matching `:Entity` node are skipped and logged as _out-of-network_** —
   they prove the source is integrated without polluting the graph. (Here: watchlist **E090, E091**.)

## The three planted patterns (must fire) → total 0.74 → SAR
| Detector | Pattern | Entities / txns | Contribution |
|----------|---------|-----------------|--------------|
| **Circular flow** | one closed loop, length ≥ 3 | E001→E002→E003→E004→E001 (T001–T004) | **0.30** |
| **Sanctioned exposure** | subject reaches a sanctioned node | E001→E005→E006 (T005, T006); E006 sanctioned | **0.28** |
| **Shell linkage** | nominee cluster on one address | E007, E008, E009 (T007–T009; all nominee @ "Suite 4B, Ocean Plaza, Victoria, Mahe") | **0.16** |

`0.30 + 0.28 + 0.16 = 0.74` → band **SAR** (≥0.65 SAR · 0.35–0.65 EDD · <0.35 clear).

## Discriminators (must NOT fire) — the traps
- **Clean parties E010–E015 do NOT fire.** Their transactions are strictly one-directional
  (T010–T015: in or out of E001, never forming a loop), all `verified`, all distinct addresses.
- **No benign 2-cycles.** There is no pair A→B and B→A anywhere in `transactions.csv`. The circular
  detector's **minimum cycle length is 3** — a 2-cycle (or simple back-and-forth) must never count.
- **Shared address alone is NOT shell risk.** **E002 and E004** share
  "Office 12, Nicosia Business Centre, Nicosia" but are `thin_file`, not `nominee` → shell linkage
  must **not** fire on them. The signal requires `nominee` AND shared address together.
- **Do NOT merge on name similarity.** "Meridian Payment Agents" (E005) and "Meridian Freight GmbH"
  (E013) are unrelated entities that happen to share a word. Entity resolution is **out of scope**;
  treat `entity_id` as identity.

## Expected source-hit summary (the badges shown in the case header)
- **World-Check · 1 hit** — E006 (OFAC SDN, match_strength 0.95 → derives `:Sanctioned`).
- **TM · 4** — the 4 transaction-monitoring legs of the circular flow (T001–T004).
- **KYC · 2** — the 2 KYC-derived risk clusters: the nominee shell cluster (E007/E008/E009) and the
  `thin_file` layering chain (E002/E003/E004).
- **Watchlist · 0 in-network** — E090, E091 screened but absent from the graph (out-of-network).
