// Maps the backend CaseContract -> the AMLCase view-model the React components
// already consume. This is the ONE place backend shape meets frontend shape, so
// the components stay unchanged in spirit (we only reconcile mock assumptions:
// real bands, GBP, real sources, no "AI" score term). The contract carries no
// node coordinates, so we compute a deterministic subject-centred fan-out here.

import {
  AMLCase,
  EdgeCategory,
  GraphEdge,
  GraphNode,
  NodeType,
  RiskCategory,
  RiskLevel,
} from './cases';
import { CaseContract, ContractEdge, ContractNode } from './api';

// Virtual canvas (matches NetworkGraph VW/VH); subject pinned at the centre.
const VW = 720;
const VH = 440;
const CX = VW / 2;
const CY = VH / 2;

// ── money formatting ────────────────────────────────────────────────────────
export function gbpCompact(n: number): string {
  if (n >= 1_000_000) return `£${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `£${Math.round(n / 1_000)}K`;
  return `£${n}`;
}

// ── node classification ─────────────────────────────────────────────────────
function nodeType(n: ContractNode): NodeType {
  if (n.flags.subject) return 'main';
  // A counterparty that is itself the subject of another case stands out on its
  // own — even over sanctioned/shell (in this data a peer subject is neither).
  if (n.flags.peer_subject) return 'peer_subject';
  if (n.flags.sanctioned) return 'sanctioned';
  if (n.flags.shell) return 'shell';
  return 'entity';
}

function nodeRisk(n: ContractNode): RiskLevel {
  if (n.flags.subject || n.flags.sanctioned || n.flags.shell || n.flags.peer_subject) return 'high';
  if (n.role === 'layering' || n.role === 'intermediary') return 'medium';
  return 'low'; // clean / plain counterparty — rendered muted
}

// Cluster nodes of the same pattern together around the ring.
function patternRank(n: ContractNode): number {
  if (n.role === 'layering') return 0;
  if (n.flags.sanctioned || n.role === 'intermediary') return 1;
  if (n.flags.shell) return 2;
  return 3;
}

function shortName(name: string, max = 15): string {
  return name.length > max ? name.slice(0, max - 1).trimEnd() + '…' : name;
}

// ── edge classification ─────────────────────────────────────────────────────
function edgeCategory(pattern: string | null): EdgeCategory {
  if (pattern === 'circular') return 'circular';
  if (pattern === 'sanctioned') return 'sanctioned';
  if (pattern === 'shell') return 'shell';
  if (pattern === 'high_risk') return 'high_risk';
  if (pattern === 'structuring') return 'structuring';
  return 'normal';
}

// ── layout: BFS hop distance from the subject, then place each hop level on a
//    ring; subject at the centre. Deterministic (sorted), so re-renders and
//    saved positions stay stable. ───────────────────────────────────────────
function computePositions(
  nodes: ContractNode[],
  edges: ContractEdge[],
  subjectId: string,
): Record<string, { x: number; y: number }> {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }

  const hop = new Map<string, number>([[subjectId, 0]]);
  const queue = [subjectId];
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of adj.get(u) ?? []) {
      if (!hop.has(v)) {
        hop.set(v, (hop.get(u) ?? 0) + 1);
        queue.push(v);
      }
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const levels = new Map<number, ContractNode[]>();
  for (const n of nodes) {
    if (n.id === subjectId) continue;
    const h = hop.get(n.id) ?? 2; // any disconnected node lands on an outer ring
    (levels.get(h) ?? levels.set(h, []).get(h)!).push(n);
  }

  const pos: Record<string, { x: number; y: number }> = { [subjectId]: { x: CX, y: CY } };
  const RX = 230; // horizontal spread (wider than tall reads better)
  const RY = 150;
  const sortedLevels = [...levels.keys()].sort((a, b) => a - b);
  sortedLevels.forEach((level, li) => {
    const ring = levels.get(level)!.slice().sort(
      (a, b) => patternRank(a) - patternRank(b) || a.id.localeCompare(b.id),
    );
    // Scale by ring INDEX (li+1), not the raw hop value — so sparse hop levels
    // (e.g. only a level 2 with no level 1) still stay inside the canvas.
    const frac = (li + 1) / sortedLevels.length;
    const rx = RX * frac;
    const ry = RY * frac;
    const n = ring.length;
    const offset = li * 0.5; // stagger rings so spokes don't overlap
    ring.forEach((node, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(n, 1) + offset;
      pos[node.id] = {
        x: Math.round(CX + Math.cos(angle) * rx),
        y: Math.round(CY + Math.sin(angle) * ry),
      };
    });
  });
  void byId;
  return pos;
}

// ── node radius scaled by incident money flow (= contribution / "share of
//    flow", matching the graph legend); subject is always the largest. ───────
function radii(nodes: ContractNode[], edges: ContractEdge[], subjectId: string): Map<string, number> {
  const flow = new Map<string, number>();
  for (const e of edges) {
    flow.set(e.source, (flow.get(e.source) ?? 0) + e.amount_gbp);
    flow.set(e.target, (flow.get(e.target) ?? 0) + e.amount_gbp);
  }
  const max = Math.max(1, ...[...flow.values()]);
  const out = new Map<string, number>();
  for (const n of nodes) {
    if (n.id === subjectId) { out.set(n.id, 34); continue; }
    out.set(n.id, Math.round(15 + 15 * ((flow.get(n.id) ?? 0) / max)));
  }
  return out;
}

const FACTOR_CATEGORY: Record<string, RiskCategory> = {
  circular_flow: 'circular',
  sanctioned_exposure: 'sanctioned',
  shell_linkage: 'shell',
  high_risk_outbound: 'high_risk',
  structuring: 'structuring',
};

// ── graph transform (nodes + edges only) ────────────────────────────────────
// Split out so the duration control can refresh JUST the graph (fetch a windowed
// {nodes, edges} and re-run this) without rebuilding the whole AMLCase — the
// score/recommendation/riskFactors are unaffected by a view window.
export function graphToViewModel(
  graph: { nodes: ContractNode[]; edges: ContractEdge[] },
  subjectId: string,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const pos = computePositions(graph.nodes, graph.edges, subjectId);
  const rad = radii(graph.nodes, graph.edges, subjectId);

  const nodes: GraphNode[] = graph.nodes.map((n) => {
    const type = nodeType(n);
    let label = n.id;
    let sublabel: string | undefined = shortName(n.label);
    if (type === 'main') {
      const parts = n.label.split(' ');
      label = parts[0];
      sublabel = parts.slice(1).join(' ') || undefined;
    }
    return {
      id: n.id,
      label,
      sublabel,
      name: n.label,          // full, untruncated name for the hover tooltip
      x: pos[n.id]?.x ?? CX,
      y: pos[n.id]?.y ?? CY,
      radius: rad.get(n.id) ?? 18,
      type,
      risk: nodeRisk(n),
      // Carried for the hover overview (KYC / sanctions / role).
      jurisdiction: n.jurisdiction,
      kycStatus: n.kyc_status,
      role: n.role,
      sanctioned: n.flags.sanctioned,
      shell: n.flags.shell,
      subject: n.flags.subject,
      peerSubject: n.flags.peer_subject,
    };
  });

  const edges: GraphEdge[] = graph.edges.map((e) => ({
    id: e.id,
    from: e.source,
    to: e.target,
    amount: gbpCompact(e.amount_gbp),
    amountValue: e.amount_gbp,
    suspicious: e.pattern != null,
    category: edgeCategory(e.pattern),
    txns: 1,
    types: e.channel,   // transaction types on this arc (backend: DISTINCT SENT.channel)
  }));

  return { nodes, edges };
}

export function contractToAMLCase(c: CaseContract): AMLCase {
  const subjectId = c.case.subject_entity_id;
  const { nodes, edges } = graphToViewModel(c.graph, subjectId);

  const riskFactors = c.detectors
    .filter((d) => d.fired)
    .map((d) => ({
      name: d.name,
      category: FACTOR_CATEGORY[d.key] ?? 'circular',
      contribution: d.contribution,
      detectors: d.txns.length,
      ai: 0, // unused now — the "AI" term is dropped in RiskPanel
      detail: d.explanation,
    }));

  const band = c.score.band as 'SAR' | 'EDD' | 'CLEAR';

  return {
    id: c.case.case_id,
    customerName: c.case.subject_name,
    status: 'ongoing',
    riskScore: c.score.total,
    entityFull: c.case.subject_name,
    triggerTags: c.detectors.filter((d) => d.fired).map((d) => d.name),
    nodes,
    edges,
    riskFactors,
    sarSummary: c.recommendation.rationale,

    isLive: true,
    subjectId,
    currency: 'GBP',
    band,
    bands: c.score.bands,
    engine: c.score.engine,
    action: c.recommendation.action,
    headline: c.recommendation.headline,
    rationale: c.recommendation.rationale,
    rationaleSource: c.recommendation.rationale_source,
    model: c.recommendation.model,
    sources: c.sources,
  };
}
