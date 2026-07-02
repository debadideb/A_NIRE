import { useState, useMemo, useCallback, lazy, Suspense } from 'react';
import { Network, ExternalLink, ShieldAlert, Layers, CalendarClock, Waypoints } from 'lucide-react';
import { GraphNode, GraphEdge } from '../data/cases';
import { Duration } from '../data/api';
import { gbpCompact } from '../data/adapter';
import { EntityModal } from './EntityModal';
import { RendererId, RENDERERS } from './graph/shared';

// The graph is drawn by one of three pluggable engines — Cytoscape (default,
// force-clustered), G6 (radial), or vis.js (physics). All are heavy, so they are
// code-split and only download when selected. The toolbar, visibility gate, hover
// tooltip and entity modal are shared chrome that wrap whichever engine is active.
const CytoscapeSurface = lazy(() =>
  import('./graph/CytoscapeSurface').then(m => ({ default: m.CytoscapeSurface })),
);
const G6Surface = lazy(() =>
  import('./graph/G6Surface').then(m => ({ default: m.G6Surface })),
);
const VisSurface = lazy(() =>
  import('./graph/VisSurface').then(m => ({ default: m.VisSurface })),
);

const SURFACE_BG: Record<RendererId, string> = { cytoscape: '#262626', g6: '#0b0b0f', vis: '#262626' };
const RENDERER_LABEL: Record<RendererId, string> = { cytoscape: 'Cytoscape', g6: 'G6', vis: 'vis.js' };

interface Props {
  caseId: string;
  isLive: boolean;
  subjectId?: string;                 // alerted subject — anchors the contribution sliders
  initialNodes: GraphNode[];
  edges: GraphEdge[];
  isPopout?: boolean;                 // true when rendered in the pop-out window
  isolateCategory?: string | null;    // isolate one risk pattern's subgraph (from RiskPanel)
  initialRenderer?: RendererId;       // pre-selected view (carried through the pop-out URL)
  duration?: Duration;                // transaction time-window (dropdown)
  onDurationChange?: (w: Duration) => void;
  graphLoading?: boolean;             // true while a windowed graph is being fetched
}

const DURATIONS: { id: Duration; label: string }[] = [
  { id: '1m', label: '1 month' },
  { id: '3m', label: '3 months' },
  { id: '6m', label: '6 months' },
  { id: '12m', label: '12 months' },
];

// When a risk factor is isolated we must show that pattern's edges PLUS the
// corridor that connects them back to the subject — otherwise a deep typology
// (funded through 'normal' corridor edges the pattern filter hides) floats
// disconnected from the subject. BFS the undirected graph from the subject,
// remember the edge used to first reach each node, then walk those predecessor
// edges back for every node the pattern touches → the shortest connecting trail.
function connectorEdgesToSubject(
  edges: GraphEdge[],
  subj: string,
  targets: Set<string>,
): Set<string> {
  const adj = new Map<string, { to: string; id: string }[]>();
  for (const e of edges) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push({ to: e.to, id: e.id });
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push({ to: e.from, id: e.id });
  }
  const prevEdge = new Map<string, string>();
  const prevNode = new Map<string, string>();
  const seen = new Set<string>([subj]);
  const queue = [subj];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    for (const { to, id } of adj.get(u) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      prevEdge.set(to, id);
      prevNode.set(to, u);
      queue.push(to);
    }
  }
  const out = new Set<string>();
  targets.forEach(t => {
    let cur = t;
    while (cur !== subj && prevNode.has(cur)) {
      out.add(prevEdge.get(cur)!);
      cur = prevNode.get(cur)!;
    }
  });
  return out;
}

export function NetworkGraph({
  caseId, isLive, subjectId, initialNodes, edges, isPopout = false,
  isolateCategory = null, initialRenderer = 'cytoscape', duration = '12m',
  onDurationChange, graphLoading = false,
}: Props) {
  const [modalEntity, setModalEntity] = useState<string | null>(null); // double-click detail
  const [renderer, setRenderer] = useState<RendererId>(initialRenderer);
  const [resetSignal, setResetSignal] = useState(0);                   // bump → surface re-layouts
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  // Directional contribution thresholds (% of the subject's outflow / inflow).
  // 0 = show everything; raising one reveals only its major direct counterparties.
  const [debitPct, setDebitPct] = useState(0);
  const [creditPct, setCreditPct] = useState(0);
  // Hop limit: show only counterparties within N hops of the subject. Sentinel 99
  // = "all hops" (no filter); the dropdown clamps its shown value to the case's
  // maxHop. Always constrains — it composes with the sliders AND isolate.
  const [hopLimit, setHopLimit] = useState(99);

  // "Major counterparties" gate. Contribution is measured ONLY for the subject's
  // DIRECT (hop-1) counterparties: each one's share of the subject's total debit
  // (outflow) and credit (inflow). The two sliders filter the direct edges
  // INDEPENDENTLY per direction — the debit slider hides low-share outbound edges,
  // the credit slider hides low-share inbound edges — and a surviving direct
  // counterparty still drags in its whole downstream network.
  const subj = subjectId ?? initialNodes.find(n => n.type === 'main')?.id ?? null;
  const slidersActive = debitPct > 0 || creditPct > 0;

  // All graph-derived data is MEMOISED so that hover re-renders (which only touch
  // tooltip state) don't hand the renderers fresh array/Set references. Without
  // this, every hover recreates `surfaceEdges`/`visibleEdgeIds`, which tears down
  // and rebuilds the Cytoscape/vis instance mid-hover — stranding the tooltip
  // (the `mouseout` fires on an already-destroyed instance).
  const { surfaceEdges, visibleEdgeIds, visibleNodeIds, totalDirect, shownDirect, maxHop } = useMemo(() => {
    // Hop distance of every node from the subject (undirected shortest path, same
    // ring metric the layout uses). Drives the hop controller + its filter.
    const hopOf = new Map<string, number>();
    if (subj) {
      const adj = new Map<string, string[]>();
      for (const e of edges) {
        (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
        (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
      }
      hopOf.set(subj, 0);
      const q = [subj];
      let h = 0;
      while (h < q.length) {
        const u = q[h++]; const du = hopOf.get(u)!;
        for (const v of adj.get(u) ?? []) {
          if (hopOf.has(v)) continue;
          hopOf.set(v, du + 1); q.push(v);
        }
      }
    }
    const maxHop = Math.max(1, ...[...hopOf.values()]);

    const directCps = new Map<string, { debit: number; credit: number }>();
    if (subj) {
      const debitTotal = edges.filter(e => e.from === subj).reduce((s, e) => s + e.amountValue, 0);
      const creditTotal = edges.filter(e => e.to === subj).reduce((s, e) => s + e.amountValue, 0);
      for (const e of edges) {
        if (e.from === subj && e.to !== subj) {
          const cp = directCps.get(e.to) ?? { debit: 0, credit: 0 };
          cp.debit += debitTotal ? (e.amountValue / debitTotal) * 100 : 0;
          directCps.set(e.to, cp);
        } else if (e.to === subj && e.from !== subj) {
          const cp = directCps.get(e.from) ?? { debit: 0, credit: 0 };
          cp.credit += creditTotal ? (e.amountValue / creditTotal) * 100 : 0;
          directCps.set(e.from, cp);
        }
      }
    }
    // Directional, per-edge filtering of the subject's DIRECT edges (independent
    // sliders). A direct debit edge S->CP survives on the DEBIT slider (its share
    // of the subject's outflow); a direct credit edge CP->S survives on the CREDIT
    // slider (its share of the inflow). 0 = no filter for that direction. Because
    // contract edges are aggregated per (source,target), a cp's debit/credit % is
    // exactly that one edge's share — so a two-way counterparty can lose one edge
    // and keep the other. `inViewCps` = direct cps with >=1 surviving direct edge.
    const keptDirectEdgeIds = new Set<string>();
    const inViewCps = new Set<string>();
    if (subj) {
      for (const e of edges) {
        if (e.from === subj && e.to !== subj) {
          const x = directCps.get(e.to)?.debit ?? 0;
          if (debitPct === 0 || x >= debitPct) { keptDirectEdgeIds.add(e.id); inViewCps.add(e.to); }
        } else if (e.to === subj && e.from !== subj) {
          const y = directCps.get(e.from)?.credit ?? 0;
          if (creditPct === 0 || y >= creditPct) { keptDirectEdgeIds.add(e.id); inViewCps.add(e.from); }
        }
      }
    }

    // Visible node set: subject + in-view direct counterparties + everything
    // reachable downstream from them (following directed edges, never crossing back
    // through the subject) — "their corresponding networks".
    const nodeGate = new Set<string>();
    if (slidersActive && subj) {
      nodeGate.add(subj);
      const adjOut = new Map<string, string[]>();
      for (const e of edges) (adjOut.get(e.from) ?? adjOut.set(e.from, []).get(e.from)!).push(e.to);
      const queue = [...inViewCps];
      inViewCps.forEach(id => nodeGate.add(id));
      while (queue.length) {
        const u = queue.shift()!;
        for (const v of adjOut.get(u) ?? []) {
          if (v === subj || nodeGate.has(v)) continue;
          nodeGate.add(v);
          queue.push(v);
        }
      }
    }

    // Corridor colouring. For EVERY risk pattern present, trace the corridor from
    // the subject to that pattern's nodes and paint those benign ('normal') edges
    // in the pattern's colour — so each risk path reads as one continuous coloured
    // trail back to the subject, not just the deep pattern edges. When a factor is
    // isolated we colour only that factor's corridor (matching what stays visible).
    // Severity order breaks the rare tie where two corridors share an edge.
    const SEVERITY: GraphEdge['category'][] = ['sanctioned', 'high_risk', 'shell', 'structuring', 'circular'];
    const corridorCat = new Map<string, GraphEdge['category']>();
    const cats = isolateCategory ? [isolateCategory as GraphEdge['category']] : SEVERITY;
    if (subj) {
      for (const cat of cats) {
        const patternEdges = edges.filter(e => e.category === cat);
        if (!patternEdges.length) continue;
        const targets = new Set<string>();
        patternEdges.forEach(e => { targets.add(e.from); targets.add(e.to); });
        connectorEdgesToSubject(edges, subj, targets).forEach(id => {
          if (!corridorCat.has(id)) corridorCat.set(id, cat);
        });
      }
    }

    // Visible edges. Three modes, all feeding the Cytoscape / G6 / vis.js surfaces:
    //  · Isolating a risk factor → that pattern's edges PLUS its corridor back to
    //    the subject (so the whole trail is visible). Overrides the sliders.
    //  · Sliders off → the whole network.
    //  · Sliders on → each DIRECT edge survives per its own directional slider
    //    filter; every other (downstream) edge survives only if both endpoints sit
    //    inside the in-view network (nodeGate).
    const veIds = new Set<string>();
    if (isolateCategory) {
      edges.forEach(e => { if (e.category === isolateCategory) veIds.add(e.id); });
      corridorCat.forEach((_c, id) => veIds.add(id));
    } else if (!slidersActive) {
      edges.forEach(e => veIds.add(e.id));
    } else {
      edges.forEach(e => {
        const direct = e.from === subj || e.to === subj;
        if (direct ? keptDirectEdgeIds.has(e.id) : (nodeGate.has(e.from) && nodeGate.has(e.to))) {
          veIds.add(e.id);
        }
      });
    }

    // Recolour the benign corridor edges to their risk pattern's colour (edge
    // colour is driven by `category`); real pattern edges keep their own colour.
    const sEdges = corridorCat.size
      ? edges.map(e => (e.category === 'normal' && corridorCat.has(e.id)
          ? { ...e, category: corridorCat.get(e.id)! }
          : e))
      : edges;

    // Hop limit ALWAYS constrains (composes with the sliders and isolate): drop any
    // surviving edge that reaches beyond `hopLimit` hops from the subject.
    if (hopLimit < maxHop) {
      for (const e of edges) {
        if (!veIds.has(e.id)) continue;
        if ((hopOf.get(e.from) ?? 0) > hopLimit || (hopOf.get(e.to) ?? 0) > hopLimit) {
          veIds.delete(e.id);
        }
      }
    }

    const vnIds = new Set<string>();
    edges.forEach(e => {
      if (veIds.has(e.id)) { vnIds.add(e.from); vnIds.add(e.to); }
    });
    // The subject stays visible even if the hop limit removed all its edges.
    if (subj && (hopLimit >= 1)) vnIds.add(subj);

    return {
      surfaceEdges: sEdges,
      visibleEdgeIds: veIds,
      visibleNodeIds: vnIds,
      totalDirect: directCps.size,
      shownDirect: slidersActive ? inViewCps.size : directCps.size,
      maxHop,
    };
  }, [edges, subj, debitPct, creditPct, slidersActive, isolateCategory, hopLimit]);

  const resetLayout = () => {
    setDebitPct(0);
    setCreditPct(0);
    setHopLimit(99);            // back to "all hops"
    setResetSignal(s => s + 1); // tell the active renderer to re-run its layout
  };

  // Open the graph in a SEPARATE browser window via the ?popout route (a fresh
  // React root there, so native events work — a cross-window portal would not).
  const openPopout = () => {
    const url = `${location.pathname}?popout=${encodeURIComponent(caseId)}&renderer=${renderer}`;
    window.open(url, `amlGraph_${caseId}`, 'width=1280,height=860,menubar=no,toolbar=no,location=no');
  };

  // Hover reported up by the active surface feeds the SHARED tooltip. Stable
  // identity (useCallback) so the surface's callback ref stays put across renders.
  const handleSurfaceHover = useCallback((node: GraphNode | null, clientX: number, clientY: number) => {
    setHoveredId(node?.id ?? null);
    setHoverPos(node ? { x: clientX, y: clientY } : null);
  }, []);

  // Reveal counterparty names only when the user has narrowed to a subgraph (sliders
  // active) or isolated a risk factor; otherwise just the subject(s) are labelled.
  const revealLabels = slidersActive || !!isolateCategory;

  const surfaceProps = {
    nodes: initialNodes,
    edges: surfaceEdges,
    visibleEdgeIds,
    visibleNodeIds,
    isLive,
    resetSignal,
    revealLabels,
    onHover: handleSurfaceHover,
    onOpenEntity: setModalEntity,
  };

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden relative"
      // Fallback: guarantee the tooltip clears if the pointer leaves the graph
      // region without the engine's own mouseout/blur firing (fast exits off the
      // canvas edge can be missed by Cytoscape/vis).
      onMouseLeave={() => { setHoveredId(null); setHoverPos(null); }}
    >
      {/* Toolbar */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 flex-wrap">
        {/* Renderer (view) switcher — Cytoscape / G6 / vis.js */}
        <div
          className="bg-white/90 backdrop-blur-sm rounded-md border border-gray-200 shadow-sm flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5"
          title="Graph renderer"
        >
          <Layers size={11} className="text-slate-400" />
          <select
            value={renderer}
            onChange={e => setRenderer(e.target.value as RendererId)}
            className="text-[11px] text-slate-600 bg-transparent outline-none cursor-pointer"
          >
            {RENDERERS.map(r => (
              <option key={r.id} value={r.id}>{r.label} — {r.hint}</option>
            ))}
          </select>
        </div>

        <button
          className="bg-white/90 backdrop-blur-sm rounded-md px-2.5 py-1.5 text-[11px] text-slate-600 border border-gray-200 hover:bg-white shadow-sm flex items-center gap-1.5 transition-colors"
          onClick={resetLayout}
        >
          <Network size={11} /> Reset view
        </button>

        {/* Pop out the graph into its own browser window (hidden when already
            inside the pop-out window). Keeps every control. */}
        {!isPopout && (
          <button
            className="bg-white/90 backdrop-blur-sm rounded-md px-2.5 py-1.5 text-[11px] text-slate-600 border border-gray-200 hover:bg-white shadow-sm flex items-center gap-1.5 transition-colors"
            onClick={openPopout}
            title="Open the graph in a separate window"
          >
            <ExternalLink size={11} /> Pop out
          </button>
        )}

        {/* Transaction duration window */}
        <div
          className="bg-white/90 backdrop-blur-sm rounded-md border border-gray-200 shadow-sm flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5"
          title="Transaction time window"
        >
          <CalendarClock size={11} className="text-slate-400" />
          <select
            value={duration}
            onChange={e => onDurationChange?.(e.target.value as Duration)}
            disabled={!isLive || graphLoading || !onDurationChange}
            className="text-[11px] text-slate-600 bg-transparent outline-none cursor-pointer disabled:cursor-default disabled:opacity-50"
          >
            {DURATIONS.map(d => (
              <option key={d.id} value={d.id}>Last {d.label}</option>
            ))}
          </select>
          {graphLoading && (
            <div className="w-3 h-3 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
          )}
        </div>

        {/* Hop limit: show only counterparties within N hops of the subject. */}
        <div
          className="bg-white/90 backdrop-blur-sm rounded-md border border-gray-200 shadow-sm flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5"
          title="Show only counterparties within this many hops of the subject"
        >
          <Waypoints size={11} className="text-slate-400" />
          <select
            value={Math.min(hopLimit, maxHop)}
            onChange={e => setHopLimit(Number(e.target.value))}
            className="text-[11px] text-slate-600 bg-transparent outline-none cursor-pointer"
          >
            {Array.from({ length: maxHop }, (_, i) => i + 1).map(h => (
              <option key={h} value={h}>{h === maxHop ? `${h} hops (all)` : `${h} hop${h > 1 ? 's' : ''}`}</option>
            ))}
          </select>
        </div>

        {/* Directional edge gate: two independent contribution thresholds applied
            to the subject's DIRECT edges (debit = outflow, credit = inflow). */}
        <div className="bg-white/90 backdrop-blur-sm rounded-md px-3 py-1.5 border border-gray-200 shadow-sm flex items-center gap-3">
          <div className="flex items-center gap-1.5" title="Hide the subject's direct OUTBOUND (debit) edges below this share of its outflow (independent of the credit slider)">
            <span className="text-[10px] text-slate-500 whitespace-nowrap">Debit ≥</span>
            <input
              type="range" min={0} max={100} step={1}
              value={debitPct}
              onChange={e => setDebitPct(Number(e.target.value))}
              className="w-20 h-1 accent-rose-600 cursor-pointer"
            />
            <span className="text-[10px] font-mono font-semibold text-rose-700 w-9 text-right">{debitPct}%</span>
          </div>
          <div className="flex items-center gap-1.5" title="Hide the subject's direct INBOUND (credit) edges below this share of its inflow (independent of the debit slider)">
            <span className="text-[10px] text-slate-500 whitespace-nowrap">Credit ≥</span>
            <input
              type="range" min={0} max={100} step={1}
              value={creditPct}
              onChange={e => setCreditPct(Number(e.target.value))}
              className="w-20 h-1 accent-emerald-600 cursor-pointer"
            />
            <span className="text-[10px] font-mono font-semibold text-emerald-700 w-9 text-right">{creditPct}%</span>
          </div>
          {slidersActive && (
            <span className="text-[9px] text-gray-400 whitespace-nowrap">
              {shownDirect}/{totalDirect} direct CPs
            </span>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-3 z-10 bg-white/90 backdrop-blur-sm rounded-lg border border-gray-200 shadow-sm p-2.5 text-[10px] text-gray-600 space-y-1.5">
        {[
          { color: '#f97316', label: 'Circular flow' },
          { color: '#ef4444', label: 'Sanctioned' },
          { color: '#f59e0b', label: 'Shell linkage' },
          { color: '#d946ef', label: 'High-risk outbound' },
          { color: '#2dd4bf', label: 'Structuring' },
          { color: '#94a3b8', label: 'Normal flow' },
        ].map(item => (
          <div key={item.label} className="flex items-center gap-2">
            <svg width="18" height="8">
              <line x1="0" y1="4" x2="12" y2="4" stroke={item.color} strokeWidth="2" strokeLinecap="round" />
              <polygon points="12,1 18,4 12,7" fill={item.color} />
            </svg>
            <span>{item.label}</span>
          </div>
        ))}
        {/* Node key: the two subject markers (in-focus vs. another case). */}
        <div className="pt-1.5 mt-0.5 border-t border-gray-200/70 space-y-1.5">
          {[
            { stroke: '#f97316', fill: '#f8fafc', label: 'Subject (in focus)' },
            { stroke: '#8b5cf6', fill: '#ede9fe', label: 'Subject · other case' },
          ].map(item => (
            <div key={item.label} className="flex items-center gap-2">
              <svg width="18" height="12">
                <circle cx="9" cy="6" r="4.5" fill={item.fill} stroke={item.stroke} strokeWidth="2" />
              </svg>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Risk-factor isolation hint (driven from the RiskPanel) — bottom-right */}
      {isolateCategory && (
        <div className="absolute bottom-4 right-3 z-10 bg-slate-800 text-white rounded-lg px-3 py-2 text-[11px] shadow-md">
          Isolating <strong className="capitalize">{isolateCategory}</strong> pattern · clear it from the risk factor card
        </div>
      )}

      {/* Active renderer */}
      <Suspense
        fallback={
          <div className="flex-1 flex items-center justify-center" style={{ background: SURFACE_BG[renderer] }}>
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <div className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
              Loading {RENDERER_LABEL[renderer]} renderer…
            </div>
          </div>
        }
      >
        {renderer === 'cytoscape' ? (
          <CytoscapeSurface {...surfaceProps} />
        ) : renderer === 'g6' ? (
          <G6Surface {...surfaceProps} />
        ) : (
          <VisSurface {...surfaceProps} />
        )}
      </Suspense>

      {/* Hover overview — entity at a glance (KYC / World-Check / transactions) */}
      {hoveredId && hoverPos && (() => {
        const n = initialNodes.find(x => x.id === hoveredId);
        if (!n) return null;
        const sanctioned = n.sanctioned ?? n.type === 'sanctioned';
        const shell = n.shell ?? n.type === 'shell';
        const subject = n.subject ?? n.type === 'main';
        const peerSubject = n.peerSubject ?? n.type === 'peer_subject';
        const out = edges.filter(e => e.from === n.id);
        const inc = edges.filter(e => e.to === n.id);
        const sent = out.reduce((s, e) => s + e.amountValue, 0);
        const recv = inc.reduce((s, e) => s + e.amountValue, 0);
        // Distinct transaction types across this entity's incident flows.
        const typeSet = new Set<string>();
        [...out, ...inc].forEach(e => (e.types ?? '').split(',').forEach(t => {
          const s = t.trim().replace('_', ' '); if (s) typeSet.add(s);
        }));
        const typesLabel = [...typeSet].join(', ');
        const typeLabel = subject ? 'Subject'
          : peerSubject ? 'Subject · other case'
          : sanctioned ? 'Sanctioned' : shell ? 'Shell' : 'Counterparty';
        return (
          <div
            className="fixed z-[60] pointer-events-none w-64 bg-white rounded-lg shadow-xl border border-gray-200 p-3 text-[11px]"
            style={{
              left: Math.min(hoverPos.x + 16, window.innerWidth - 270),
              top: Math.min(hoverPos.y + 16, window.innerHeight - 190),
            }}
          >
            <div className="mb-1.5">
              {/* Full entity name (untruncated) so the subject reads in full. */}
              <div className="font-semibold text-slate-800 leading-snug">{n.name ?? n.sublabel ?? n.label}</div>
              <div className="text-[9px] font-mono text-gray-400">{n.id}</div>
            </div>
            <div className="flex items-center gap-1.5 mb-2">
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${
                sanctioned ? 'bg-red-50 border-red-200 text-red-700'
                : shell ? 'bg-amber-50 border-amber-200 text-amber-700'
                : peerSubject ? 'bg-violet-50 border-violet-200 text-violet-700'
                : subject ? 'bg-slate-100 border-slate-200 text-slate-700'
                : 'bg-gray-50 border-gray-200 text-gray-500'}`}>{typeLabel}</span>
              {n.jurisdiction && <span className="text-[10px] text-gray-500">{n.jurisdiction}</span>}
            </div>
            {n.kycStatus && (
              <div className="flex justify-between text-[10px] mb-0.5">
                <span className="text-gray-400">KYC</span><span className="text-slate-700">{n.kycStatus}</span>
              </div>
            )}
            <div className="flex justify-between text-[10px] mb-0.5">
              <span className="text-gray-400">World-Check</span>
              <span className={sanctioned ? 'text-red-600 font-medium flex items-center gap-1' : 'text-slate-600'}>
                {sanctioned ? <><ShieldAlert size={10} /> Sanctions hit</> : 'No hit'}
              </span>
            </div>
            <div className="flex justify-between text-[10px]">
              <span className="text-gray-400">Transactions</span>
              <span className="text-slate-700">{gbpCompact(sent)} out · {gbpCompact(recv)} in</span>
            </div>
            {typesLabel && (
              <div className="flex justify-between text-[10px] mt-0.5 gap-2">
                <span className="text-gray-400 flex-shrink-0">Types</span>
                <span className="text-slate-700 text-right capitalize">{typesLabel}</span>
              </div>
            )}
            <div className="text-[9px] text-gray-400 mt-1.5">
              {out.length + inc.length} flow(s){isLive ? ' · double-click for full detail' : ''}
            </div>
          </div>
        );
      })()}

      {modalEntity && (
        <EntityModal caseId={caseId} entityId={modalEntity} onClose={() => setModalEntity(null)} />
      )}
    </div>
  );
}
