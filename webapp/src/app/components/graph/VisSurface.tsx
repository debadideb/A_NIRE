import { useEffect, useRef } from 'react';
import { Network, DataSet } from 'vis-network/standalone';
import { GraphNode } from '../../data/cases';
import { SurfaceProps, edgeColor, darkNode, nodeSize } from './shared';
import { ZoomControls } from './ZoomControls';

// vis.js (vis-network) renderer — a physics-driven force layout on the same dark
// canvas, with the SAME colour vocabulary and visibility rules as the Cytoscape
// and G6 surfaces (only the engine + layout differ). Hover / double-click are
// reported UP so the container owns the single tooltip + entity modal.
export function VisSurface({
  nodes,
  edges,
  visibleEdgeIds,
  visibleNodeIds,
  isLive,
  resetSignal,
  revealLabels,
  onHover,
  onOpenEntity,
}: SurfaceProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const netRef = useRef<Network | null>(null);
  const dsRef = useRef<{ nodes: DataSet<any>; edges: DataSet<any> } | null>(null);
  const nodeById = useRef(new Map<string, GraphNode>());

  // Latest callbacks / visibility in refs, so the network (built once) always
  // sees current values without a teardown.
  const cb = useRef({ onHover, onOpenEntity, isLive });
  cb.current = { onHover, onOpenEntity, isLive };
  const vis = useRef({ visibleEdgeIds, visibleNodeIds, revealLabels });
  vis.current = { visibleEdgeIds, visibleNodeIds, revealLabels };
  const ptr = useRef({ x: 0, y: 0 }); // last pointer position for the tooltip anchor

  // Re-apply the slider/isolate gate by dimming (never removing) elements, and the
  // label gate: counterparty names are blanked unless a subgraph is selected / a
  // factor is isolated (revealLabels) and the node is in-view. Subjects keep names.
  const applyVisibility = () => {
    const ds = dsRef.current;
    if (!ds) return;
    const { visibleEdgeIds: ve, visibleNodeIds: vn, revealLabels: rl } = vis.current;
    ds.nodes.update(nodes.map((n) => {
      const lit = n.type === 'main' || vn.has(n.id);
      const showLabel = n.type === 'main' || n.type === 'peer_subject' || (rl && vn.has(n.id));
      const c = darkNode(n);
      return {
        id: n.id,
        opacity: lit ? 1 : 0.12,
        label: showLabel ? (n.sublabel || n.label) : '',
        font: { color: lit ? c.text : 'rgba(203,213,225,0.12)' },
      };
    }));
    ds.edges.update(edges.map((e) => {
      const lit = ve.has(e.id);
      return { id: e.id, color: { color: edgeColor(e.category), opacity: lit ? 0.65 : 0.04 } };
    }));
  };

  // ── build the network once per node/edge set ─────────────────────────────
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    nodeById.current = new Map(nodes.map((n) => [n.id, n]));

    const visNodes = new DataSet<any>(
      nodes.map((n) => {
        const c = darkNode(n);
        return {
          id: n.id,
          label: n.sublabel || n.label,
          shape: 'dot',
          size: nodeSize(n) / 2,
          color: { background: c.fill, border: c.stroke },
          borderWidth: (n.type === 'main' || n.type === 'peer_subject') ? 4 : 2,
          font: { color: c.text, size: n.type === 'main' ? 15 : n.type === 'peer_subject' ? 13 : 11, strokeWidth: 3, strokeColor: '#171717' },
        };
      }),
    );
    const visEdges = new DataSet<any>(
      edges.map((e) => ({
        id: e.id,
        from: e.from,
        to: e.to,
        width: e.suspicious ? 2.9 : 1.5,
        color: { color: edgeColor(e.category), opacity: 0.65 },
        arrows: { to: { enabled: true, scaleFactor: 0.6 } },
        smooth: { enabled: true, type: 'continuous', roundness: 0.5 },
      })),
    );
    dsRef.current = { nodes: visNodes, edges: visEdges };

    const network = new Network(
      box,
      { nodes: visNodes, edges: visEdges },
      {
        autoResize: true,
        interaction: { hover: true, dragNodes: true, dragView: true, zoomView: true, tooltipDelay: 100000 },
        physics: {
          stabilization: { iterations: 250, fit: true },
          barnesHut: { gravitationalConstant: -9000, springLength: 110, springConstant: 0.03, avoidOverlap: 0.4 },
        },
        nodes: { shadow: false },
        edges: { selectionWidth: 0 },
      },
    );
    netRef.current = network;
    // Freeze physics once settled so the graph stops jittering (like the others'
    // one-shot layouts); dragging a node still nudges neighbours briefly.
    network.once('stabilizationIterationsDone', () => {
      network.setOptions({ physics: false });
      network.fit({ animation: false });
    });

    const map = nodeById.current;
    box.addEventListener('mousemove', (e) => { ptr.current = { x: e.clientX, y: e.clientY }; });
    network.on('hoverNode', (p: any) => {
      const gn = map.get(p.node);
      // Reveal the hovered node's name on-canvas (restored on blur by applyVisibility).
      if (gn) dsRef.current?.nodes.update({ id: p.node, label: gn.sublabel || gn.label });
      cb.current.onHover(gn ?? null, ptr.current.x, ptr.current.y);
    });
    network.on('blurNode', () => { applyVisibility(); cb.current.onHover(null, 0, 0); });
    network.on('doubleClick', (p: any) => {
      if (cb.current.isLive && p.nodes && p.nodes.length) cb.current.onOpenEntity(p.nodes[0]);
    });

    applyVisibility();
    return () => { network.destroy(); netRef.current = null; dsRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  // React to slider / isolate / label-reveal changes.
  useEffect(applyVisibility, [visibleEdgeIds, visibleNodeIds, revealLabels]);

  // Reset = re-stabilise the physics layout and re-fit.
  useEffect(() => {
    const net = netRef.current;
    if (!net || resetSignal === 0) return;
    net.setOptions({ physics: true });
    net.stabilize();
    net.once('stabilizationIterationsDone', () => {
      net.setOptions({ physics: false });
      net.fit({ animation: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  const zoomTo = (factor: number) => {
    const net = netRef.current;
    if (net) net.moveTo({ scale: net.getScale() * factor });
  };

  return (
    <div className="flex-1 relative flex">
      <div ref={boxRef} className="flex-1" style={{ background: '#262626' }} />
      <ZoomControls
        onZoomIn={() => zoomTo(1.25)}
        onZoomOut={() => zoomTo(0.8)}
        onFit={() => netRef.current?.fit({ animation: true })}
      />
    </div>
  );
}
