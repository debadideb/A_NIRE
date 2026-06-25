# CLAUDE.md — Operating Contract for A_NIRE (AML Case Console)

> Read this first, every session. It is the durable contract so context survives across
> sessions and context-window resets. If anything below conflicts with a passing instruction
> in chat, ask before deviating.

## OPERATING CONTRACT (how I, Claude, must work)
- I am the **driver**: I write and edit the files directly. The human does not paste code by hand.
- **Reasoning is mandatory.** Every change ships with a documented WHY — in my chat reply, in the
  commit message, and as inline comments where a future reader would otherwise be puzzled. A change
  with no explanation is a failed turn.
- **Adversarial review loop with Codex.** Codex runs **read-only** as a critic. The loop is:
  I implement → Codex critiques → I revise → repeat until clean. Codex never edits; I make every
  change. I run Codex at meaningful checkpoints (the synthetic data, and each backend slice), not
  on trivial config.
- I own `backend/`. Commits are **small and frequent**. Commit before switching agents.
- Build **thin end-to-end first**; do not deepen one stage early (see BUILD ORDER).

## PROJECT
An AML **Case Console** for financial-crime investigators. At case creation we build a
**scored counterparty risk network** from four synthetic data sources, then produce a
**SAR vs EDD recommendation** with plain-language rationale and an audited decision trail.
The hero is the network graph; the differentiator is turning network signals into one
auditable recommendation.

## STACK (locked — do not substitute without asking)
- Backend: Python + **FastAPI**, which also serves the frontend as static files
  (one process, one URL, no CORS).
- Graph store: **Neo4j**. Detection logic in Cypher where cleaner than Python.
- Frontend: an existing **vanilla HTML/CSS/JS mockup**. Do NOT rewrite in React. Only swap
  the hand-coded `<svg>` graph for **Cytoscape.js** fed by API JSON.
- Decisions/audit persistence: **SQLite**.
- LLM rationale: **Anthropic API, server-side only**. The API key never appears in frontend JS.

## SCOPE — build ONLY this
IN: one subject, one pre-built case, four synthetic CSV sources, Neo4j graph, three detectors
(circular flow, sanctioned exposure, shell linkage), rule-based score → SAR/EDD band, LLM
rationale, decision capture + audit trail, graph + recommendation UI.

OUT (do not build): real/fuzzy entity resolution, live data feeds, auth/users,
multi-case-switching logic (queue is visual only), model training, working chat Q&A
(chat box stays presentational). Park post-MVP ideas separately; never expand scope silently.

## DESIGN PRINCIPLE
Inputs carry **raw attributes only**. Never read a "shell"/"sanctioned" label from input.
- Derive `:Sanctioned` from a World-Check sanctions hit (match_strength ≥ 0.85).
- Derive shell risk from `kyc_status = nominee` + shared `registered_address`.
- The subject comes from the case file, not a data column.

## ACCEPTANCE TEST (the build is correct only if this holds)
Detectors over the synthetic data MUST produce:
- circular flow fires once: E001→E002→E003→E004→E001 (contribution 0.30)
- sanctioned exposure fires: E001→E005→E006 (0.28)
- shell linkage fires: E007, E008, E009 (0.16)
- clean parties E010–E015 do NOT fire
- total score = **0.74 → band SAR**  (≥0.65 SAR · 0.35–0.65 EDD · <0.35 clear)

If the score isn't 0.74/SAR, the detectors are wrong, not the data.

## BUILD ORDER (thin end-to-end first; do not deepen one stage early)
1. FastAPI returns the JSON the frontend needs (hardcoded first); frontend fetches it.
2. Replace hardcoded JSON with real Neo4j build + scoring from the CSVs.
3. Add the LLM recommendation.
4. Add decision/audit persistence.

## MULTI-AGENT
- **Codex** runs as a **read-only adversarial critic**: it suggests, never edits. Its brief lives
  in `AGENTS.md`; its sandbox is pinned read-only in `.codex/config.toml`.
- Claude (me) owns `backend/` and makes every edit. Commit before switching agents.
- Critique format Codex emits: `[file:line] · SEVERITY · problem · WHY · suggested fix`.
