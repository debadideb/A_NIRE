import { useRef, useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Network, ExternalLink, ShieldAlert, Layers } from 'lucide-react';
import { GraphNode, GraphEdge } from '../data/cases';
import { gbpCompact } from '../data/adapter';
import { EntityModal } from './EntityModal';
import { RendererId, RENDERERS } from './graph/shared';

// Cytoscape and G6 are heavy (~600 kB gzip together) — code-split them so the
// default canvas view stays lean and they only download when actually selected
// (matching the project's "lazy-load alt renderers" approach for NVL).
const CytoscapeSurface = lazy(() =>
  import('./graph/CytoscapeSurface').then(m => ({ default: m.CytoscapeSurface })),
);
const G6Surface = lazy(() =>
  import('./graph/G6Surface').then(m => ({ default: m.G6Surface })),
);

// Virtual canvas dimensions
const VW = 720;
const VH = 440;

function edgeColor(category: GraphEdge['category']): string {
  if (category === 'circular') return '#f97316';
  if (category === 'sanctioned') return '#ef4444';
  if (category === 'shell') return '#f59e0b';
  if (category === 'high_risk') return '#d946ef';
  if (category === 'structuring') return '#2dd4bf';
  return '#94a3b8';
}

function nodeColors(node: GraphNode): { fill: string; stroke: string; strokeW: number; textColor: string } {
  if (node.type === 'main')       return { fill: '#1e293b', stroke: '#f97316', strokeW: 3,   textColor: '#ffffff' };
  if (node.type === 'sanctioned') return { fill: '#fff1f2', stroke: '#ef4444', strokeW: 2.5, textColor: '#7f1d1d' };
  if (node.type === 'shell')      return { fill: '#fff7ed', stroke: '#f97316', strokeW: 2,   textColor: '#7c2d12' };
  if (node.risk === 'high')       return { fill: '#fff7ed', stroke: '#fb923c', strokeW: 2,   textColor: '#431407' };
  if (node.risk === 'medium')     return { fill: '#fffbeb', stroke: '#fbbf24', strokeW: 1.5, textColor: '#451a03' };
  return { fill: '#f8fafc', stroke: '#94a3b8', strokeW: 1.5, textColor: '#334155' };
}

interface Props {
  caseId: string;
  isLive: boolean;
  initialNodes: GraphNode[];
  edges: GraphEdge[];
  savedPositions?: Record<string, { x: number; y: number }>;
  onNodeSelect?: (id: string | null) => void;
  onPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void;
  isPopout?: boolean;                 // true when rendered in the pop-out window
  isolateCategory?: string | null;    // isolate one risk pattern's subgraph (from RiskPanel)
  initialRenderer?: RendererId;       // pre-selected view (carried through the pop-out URL)
}

export function NetworkGraph({ caseId, isLive, initialNodes, edges, savedPositions, onNodeSelect, onPositionsChange, isPopout = false, isolateCategory = null, initialRenderer = 'canvas' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [modalEntity, setModalEntity] = useState<string | null>(null); // double-click detail
  // Pluggable renderer: the default canvas flow-map, or the vendored Cytoscape /
  // G6 views. The contribution slider, risk-factor isolate, hover overview and
  // entity modal are shared chrome that wrap whichever engine is active.
  const [renderer, setRenderer] = useState<RendererId>(initialRenderer);
  const [resetSignal, setResetSignal] = useState(0); // bumped by "Reset view" → alt renderers re-layout

  // Apply saved positions on first render
  const resolvedNodes: GraphNode[] = initialNodes.map(n =>
    savedPositions?.[n.id] ? { ...n, ...savedPositions[n.id] } : n
  );

  const [nodes, setNodes] = useState<GraphNode[]>(resolvedNodes);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [threshold, setThreshold] = useState(0); // contribution % filter
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null); // tooltip anchor

  const draggingRef = useRef<{ id: string; ox: number; oy: number } | null>(null);
  const wasDragged = useRef(false);
  const selectedIdRef = useRef<string | null>(null);

  // Visible edges = pass the contribution slider AND (if a risk factor is being
  // isolated) match that pattern. Both gates feed node visibility below, so
  // isolating "Circular flow" greys out everything except the circular subgraph.
  const totalVolume = edges.reduce((s, e) => s + e.amountValue, 0);
  const visibleEdgeIds = new Set(
    edges
      .filter(e =>
        (threshold === 0 || (e.amountValue / totalVolume) * 100 >= threshold) &&
        (!isolateCategory || e.category === isolateCategory))
      .map(e => e.id)
  );
  // Nodes with no visible edges get dimmed (unless they are connected to visible ones or they're the main entity)
  const visibleNodeIds = new Set<string>();
  edges.forEach(e => {
    if (visibleEdgeIds.has(e.id)) {
      visibleNodeIds.add(e.from);
      visibleNodeIds.add(e.to);
    }
  });

  const getScale = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return { sx: 1, sy: 1, cx: 0, cy: 0 };
    const W = canvas.width, H = canvas.height;
    const sx = (W / VW) * zoom, sy = (H / VH) * zoom;
    return { sx, sy, cx: (W - VW * sx) / 2, cy: (H - VH * sy) / 2 };
  }, [zoom]);

  const toCanvas = useCallback((vx: number, vy: number) => {
    const { sx, sy, cx, cy } = getScale();
    return { x: vx * sx + cx, y: vy * sy + cy };
  }, [getScale]);

  const toVirtual = useCallback((cx: number, cy: number) => {
    const { sx, sy, cx: ox, cy: oy } = getScale();
    return { x: (cx - ox) / sx, y: (cy - oy) / sy };
  }, [getScale]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#e8eaed';
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = 'rgba(0,0,0,0.045)';
    ctx.lineWidth = 1;
    const gridSize = 32 * zoom;
    const { cx: ox, cy: oy } = getScale();
    for (let x = ox % gridSize; x < W; x += gridSize) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = oy % gridSize; y < H; y += gridSize) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    // Focus set (hover/select)
    const focusId = hoveredId || selectedId;
    const focusNodes = new Set<string>();
    const focusEdges = new Set<string>();
    if (focusId) {
      focusNodes.add(focusId);
      edges.forEach(e => {
        if (e.from === focusId || e.to === focusId) {
          focusEdges.add(e.id);
          focusNodes.add(e.from);
          focusNodes.add(e.to);
        }
      });
    }
    const hasFocus = focusNodes.size > 0;

    // ── Edges ─────────────────────────────────────────────────────
    edges.forEach(edge => {
      const from = nodeMap.get(edge.from);
      const to = nodeMap.get(edge.to);
      if (!from || !to) return;

      const passesFilter = visibleEdgeIds.has(edge.id);
      const highlighted = passesFilter && (!hasFocus || focusEdges.has(edge.id));
      const alpha = !passesFilter ? 0.05 : highlighted ? 1 : 0.12;
      const color = edgeColor(edge.category);
      const lineW = highlighted && edge.suspicious ? 2.5 : 1.5;

      const fc = toCanvas(from.x, from.y);
      const tc = toCanvas(to.x, to.y);
      const { sx } = getScale();
      const fr = from.radius * sx, tr = to.radius * sx;
      const dx = tc.x - fc.x, dy = tc.y - fc.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const angle = Math.atan2(dy, dx);

      const startX = fc.x + fr * Math.cos(angle);
      const startY = fc.y + fr * Math.sin(angle);
      const endX = tc.x - (tr + 7) * Math.cos(angle);
      const endY = tc.y - (tr + 7) * Math.sin(angle);

      const perpAngle = angle + Math.PI / 2;
      const cpX = (fc.x + tc.x) / 2 + Math.cos(perpAngle) * dist * 0.14;
      const cpY = (fc.y + tc.y) / 2 + Math.sin(perpAngle) * dist * 0.14;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = lineW;
      ctx.lineCap = 'round';

      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.quadraticCurveTo(cpX, cpY, endX, endY);
      ctx.stroke();

      // Arrowhead
      const tAngle = Math.atan2(endY - cpY, endX - cpX);
      ctx.save();
      ctx.translate(endX, endY);
      ctx.rotate(tAngle);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-10, -4.5);
      ctx.lineTo(-10, 4.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Amount label on focused edges
      if (highlighted && hasFocus && focusEdges.has(edge.id)) {
        const t = 0.5;
        const lx = (1-t)*(1-t)*startX + 2*(1-t)*t*cpX + t*t*endX;
        const ly = (1-t)*(1-t)*startY + 2*(1-t)*t*cpY + t*t*endY;
        ctx.globalAlpha = 1;
        const tw = ctx.measureText(edge.amount).width + 10;
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillRect(lx - tw/2, ly - 8, tw, 16);
        ctx.fillStyle = color;
        ctx.font = '500 10px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(edge.amount, lx, ly);
      }

      ctx.restore();
    });

    // ── Nodes ──────────────────────────────────────────────────────
    nodes.forEach(node => {
      const inVisibleSet = visibleNodeIds.has(node.id) || node.type === 'main';
      const highlighted = inVisibleSet && (!hasFocus || focusNodes.has(node.id));
      const alpha = !inVisibleSet ? 0.15 : highlighted ? 1 : 0.22;

      const { sx } = getScale();
      const nc = toCanvas(node.x, node.y);
      const r = node.radius * sx;
      const { fill, stroke, strokeW, textColor } = nodeColors(node);

      ctx.save();
      ctx.globalAlpha = alpha;

      if (hoveredId === node.id || selectedId === node.id) {
        ctx.shadowColor = stroke;
        ctx.shadowBlur = 16;
      }

      ctx.beginPath();
      ctx.arc(nc.x, nc.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = selectedId === node.id ? '#6366f1' : stroke;
      ctx.lineWidth = selectedId === node.id ? strokeW + 1 : strokeW;
      ctx.stroke();
      ctx.shadowBlur = 0;

      const fontSize = Math.max(8, r * 0.38);
      ctx.font = `600 ${fontSize}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = textColor;

      if (node.sublabel) {
        ctx.fillText(node.label, nc.x, nc.y - fontSize * 0.55);
        ctx.font = `400 ${Math.max(7, r * 0.3)}px system-ui`;
        ctx.fillStyle = node.type === 'main' ? '#94a3b8' : '#64748b';
        ctx.fillText(node.sublabel, nc.x, nc.y + fontSize * 0.6);
      } else {
        ctx.fillText(node.label, nc.x, nc.y);
      }

      if (node.type === 'sanctioned') {
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(nc.x + r * 0.65, nc.y - r * 0.65, r * 0.2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    });
  }, [nodes, hoveredId, selectedId, zoom, edges, visibleEdgeIds, visibleNodeIds, toCanvas, getScale]);

  // Resize
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const resize = () => {
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      draw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
  }, [draw]);

  useEffect(() => { draw(); }, [draw]);

  const hitTest = useCallback((vx: number, vy: number): GraphNode | null => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = vx - n.x, dy = vy - n.y;
      if (dx * dx + dy * dy <= n.radius * n.radius) return n;
    }
    return null;
  }, [nodes]);

  const canvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return toVirtual(e.clientX - rect.left, e.clientY - rect.top);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = canvasCoords(e);
    const node = hitTest(x, y);
    if (node) {
      draggingRef.current = { id: node.id, ox: x - node.x, oy: y - node.y };
      wasDragged.current = false;
      e.currentTarget.style.cursor = 'grabbing';
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = canvasCoords(e);
    if (draggingRef.current) {
      const { id, ox, oy } = draggingRef.current;
      wasDragged.current = true;
      setNodes(prev => {
        const next = prev.map(n => n.id === id ? { ...n, x: x - ox, y: y - oy } : n);
        // Save positions (debounced via the caller)
        const positions: Record<string, { x: number; y: number }> = {};
        next.forEach(n => { positions[n.id] = { x: n.x, y: n.y }; });
        onPositionsChange?.(positions);
        return next;
      });
    } else {
      const node = hitTest(x, y);
      setHoveredId(node?.id ?? null);
      setHoverPos(node ? { x: e.clientX, y: e.clientY } : null);
      e.currentTarget.style.cursor = node ? 'grab' : 'default';
    }
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggingRef.current) {
      if (!wasDragged.current) {
        const id = draggingRef.current.id;
        const next = selectedIdRef.current === id ? null : id;
        selectedIdRef.current = next;
        setSelectedId(next);
        onNodeSelect?.(next);
      }
      draggingRef.current = null;
      e.currentTarget.style.cursor = 'default';
    }
  };

  const handleMouseLeave = () => {
    setHoveredId(null);
    setHoverPos(null);
    draggingRef.current = null;
  };

  // Double-click a node = open its full entity-detail modal (live case only;
  // demo stubs have no backend detail to fetch).
  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isLive) return;
    const { x, y } = canvasCoords(e);
    const node = hitTest(x, y);
    if (node) setModalEntity(node.id);
  };

  // Open the graph in a SEPARATE browser window via the ?popout route (a fresh
  // React root there, so native events work — a cross-window portal would not).
  const openPopout = () => {
    const url = `${location.pathname}?popout=${encodeURIComponent(caseId)}&renderer=${renderer}`;
    window.open(url, `amlGraph_${caseId}`, 'width=1280,height=860,menubar=no,toolbar=no,location=no');
  };

  const resetLayout = () => {
    selectedIdRef.current = null;
    setNodes(initialNodes);
    setZoom(1);
    setThreshold(0);
    setSelectedId(null);
    onNodeSelect?.(null);
    setResetSignal(s => s + 1); // tell the active alt renderer to re-run its layout
  };

  // Hover/double-click reported up by the alt renderers feed the SAME shared
  // tooltip + entity modal the canvas uses.
  const handleSurfaceHover = (node: GraphNode | null, clientX: number, clientY: number) => {
    setHoveredId(node?.id ?? null);
    setHoverPos(node ? { x: clientX, y: clientY } : null);
  };

  const visibleCount = visibleEdgeIds.size;
  const totalEdges = edges.length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative" ref={containerRef}>
      {/* Toolbar */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 flex-wrap">
        {/* Renderer (view) switcher — Default canvas / Cytoscape / G6 */}
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

        {/* Contribution % slider */}
        <div className="bg-white/90 backdrop-blur-sm rounded-md px-3 py-1.5 border border-gray-200 shadow-sm flex items-center gap-2.5">
          <span className="text-[10px] text-slate-500 whitespace-nowrap">Min. flow contribution</span>
          <input
            type="range"
            min={0}
            max={40}
            step={1}
            value={threshold}
            onChange={e => setThreshold(Number(e.target.value))}
            className="w-24 h-1 accent-indigo-600 cursor-pointer"
          />
          <span className="text-[10px] font-mono font-semibold text-indigo-700 w-8 text-right">{threshold}%</span>
          {threshold > 0 && (
            <span className="text-[9px] text-gray-400">
              {visibleCount}/{totalEdges} flows
            </span>
          )}
        </div>
      </div>

      {/* Zoom controls (canvas only — the alt renderers draw their own, wired to
          their engine's viewport) */}
      {renderer === 'canvas' && (
        <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
          {[
            { icon: <ZoomIn size={13} />, action: () => setZoom(z => Math.min(z + 0.2, 3)), tip: 'Zoom in' },
            { icon: <ZoomOut size={13} />, action: () => setZoom(z => Math.max(z - 0.2, 0.4)), tip: 'Zoom out' },
            { icon: <Maximize2 size={13} />, action: () => setZoom(1), tip: 'Fit' },
          ].map((btn, i) => (
            <button
              key={i}
              onClick={btn.action}
              title={btn.tip}
              className="bg-white/90 backdrop-blur-sm rounded-md p-1.5 border border-gray-200 hover:bg-white shadow-sm text-slate-500 hover:text-slate-800 transition-colors"
            >
              {btn.icon}
            </button>
          ))}
        </div>
      )}

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
      </div>

      {/* Selected node hint */}
      {selectedId && (
        <div className="absolute bottom-4 right-3 z-10 bg-indigo-600 text-white rounded-lg px-3 py-2 text-[11px] shadow-md">
          Isolated: <strong>{nodes.find(n => n.id === selectedId)?.label}</strong> · Click to clear
        </div>
      )}

      {/* Risk-factor isolation hint (driven from the RiskPanel) */}
      {isolateCategory && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 bg-slate-800 text-white rounded-lg px-3 py-1.5 text-[11px] shadow-md">
          Isolating <strong className="capitalize">{isolateCategory}</strong> pattern · clear it from the risk factor card
        </div>
      )}

      {renderer === 'canvas' ? (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onDoubleClick={handleDoubleClick}
        />
      ) : (
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center" style={{ background: renderer === 'g6' ? '#0b0b0f' : '#262626' }}>
              <div className="flex items-center gap-2 text-slate-400 text-xs">
                <div className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
                Loading {renderer === 'g6' ? 'G6' : 'Cytoscape'} renderer…
              </div>
            </div>
          }
        >
          {renderer === 'cytoscape' ? (
            <CytoscapeSurface
              nodes={nodes}
              edges={edges}
              visibleEdgeIds={visibleEdgeIds}
              visibleNodeIds={visibleNodeIds}
              isLive={isLive}
              resetSignal={resetSignal}
              onHover={handleSurfaceHover}
              onOpenEntity={setModalEntity}
            />
          ) : (
            <G6Surface
              nodes={nodes}
              edges={edges}
              visibleEdgeIds={visibleEdgeIds}
              visibleNodeIds={visibleNodeIds}
              isLive={isLive}
              resetSignal={resetSignal}
              onHover={handleSurfaceHover}
              onOpenEntity={setModalEntity}
            />
          )}
        </Suspense>
      )}

      {/* Hover overview — entity at a glance (KYC / World-Check / transactions) */}
      {hoveredId && hoverPos && (() => {
        const n = nodes.find(x => x.id === hoveredId);
        if (!n) return null;
        const sanctioned = n.sanctioned ?? n.type === 'sanctioned';
        const shell = n.shell ?? n.type === 'shell';
        const subject = n.subject ?? n.type === 'main';
        const out = edges.filter(e => e.from === n.id);
        const inc = edges.filter(e => e.to === n.id);
        const sent = out.reduce((s, e) => s + e.amountValue, 0);
        const recv = inc.reduce((s, e) => s + e.amountValue, 0);
        const typeLabel = subject ? 'Subject' : sanctioned ? 'Sanctioned' : shell ? 'Shell' : 'Counterparty';
        return (
          <div
            className="fixed z-[60] pointer-events-none w-60 bg-white rounded-lg shadow-xl border border-gray-200 p-3 text-[11px]"
            style={{
              left: Math.min(hoverPos.x + 16, window.innerWidth - 250),
              top: Math.min(hoverPos.y + 16, window.innerHeight - 190),
            }}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-slate-800 truncate">{n.sublabel || n.label}</span>
              <span className="text-[9px] font-mono text-gray-400 ml-2">{n.id}</span>
            </div>
            <div className="flex items-center gap-1.5 mb-2">
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${
                sanctioned ? 'bg-red-50 border-red-200 text-red-700'
                : shell ? 'bg-amber-50 border-amber-200 text-amber-700'
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
