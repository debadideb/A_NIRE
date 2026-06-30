import { useRef, useEffect, useState, useCallback } from 'react';
import { ZoomIn, ZoomOut, RotateCcw, Maximize2, Network } from 'lucide-react';
import { GraphNode, GraphEdge } from '../data/cases';
import { EntityModal } from './EntityModal';

// Virtual canvas dimensions
const VW = 720;
const VH = 440;

function edgeColor(category: GraphEdge['category']): string {
  if (category === 'circular') return '#f97316';
  if (category === 'sanctioned') return '#ef4444';
  if (category === 'shell') return '#f59e0b';
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
}

export function NetworkGraph({ caseId, isLive, initialNodes, edges, savedPositions, onNodeSelect, onPositionsChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [modalEntity, setModalEntity] = useState<string | null>(null); // double-click detail

  // Apply saved positions on first render
  const resolvedNodes: GraphNode[] = initialNodes.map(n =>
    savedPositions?.[n.id] ? { ...n, ...savedPositions[n.id] } : n
  );

  const [nodes, setNodes] = useState<GraphNode[]>(resolvedNodes);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [threshold, setThreshold] = useState(0); // contribution % filter

  const draggingRef = useRef<{ id: string; ox: number; oy: number } | null>(null);
  const wasDragged = useRef(false);
  const selectedIdRef = useRef<string | null>(null);

  // Calculate which edges pass the contribution threshold
  const totalVolume = edges.reduce((s, e) => s + e.amountValue, 0);
  const visibleEdgeIds = new Set(
    edges
      .filter(e => threshold === 0 || (e.amountValue / totalVolume) * 100 >= threshold)
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

  const resetLayout = () => {
    selectedIdRef.current = null;
    setNodes(initialNodes);
    setZoom(1);
    setThreshold(0);
    setSelectedId(null);
    onNodeSelect?.(null);
  };

  const visibleCount = visibleEdgeIds.size;
  const totalEdges = edges.length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative" ref={containerRef}>
      {/* Toolbar */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 flex-wrap">
        <button
          className="bg-white/90 backdrop-blur-sm rounded-md px-2.5 py-1.5 text-[11px] text-slate-600 border border-gray-200 hover:bg-white shadow-sm flex items-center gap-1.5 transition-colors"
          onClick={resetLayout}
        >
          <Network size={11} /> Reset view
        </button>

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

      {/* Zoom controls */}
      <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
        {[
          { icon: <ZoomIn size={13} />, action: () => setZoom(z => Math.min(z + 0.2, 3)), tip: 'Zoom in' },
          { icon: <ZoomOut size={13} />, action: () => setZoom(z => Math.max(z - 0.2, 0.4)), tip: 'Zoom out' },
          { icon: <RotateCcw size={13} />, action: resetLayout, tip: 'Reset' },
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

      {/* Legend */}
      <div className="absolute bottom-4 left-3 z-10 bg-white/90 backdrop-blur-sm rounded-lg border border-gray-200 shadow-sm p-2.5 text-[10px] text-gray-600 space-y-1.5">
        {[
          { color: '#f97316', label: 'Circular flow' },
          { color: '#ef4444', label: 'Sanctioned' },
          { color: '#f59e0b', label: 'Shell linkage' },
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

      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onDoubleClick={handleDoubleClick}
      />

      {modalEntity && (
        <EntityModal caseId={caseId} entityId={modalEntity} onClose={() => setModalEntity(null)} />
      )}
    </div>
  );
}
