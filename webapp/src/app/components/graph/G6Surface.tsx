import { useEffect, useRef } from 'react';
import { Graph } from '@antv/g6';
import { GraphNode } from '../../data/cases';
import { SurfaceProps, edgeColor, darkNode, nodeSize } from './shared';
import { ZoomControls } from './ZoomControls';

// G6 (AntV) renderer — a radial dendrogram on a near-black canvas with the
// subject at the centre and suspicious flows glowing in their pattern colour,
// echoing the "radial tree with a highlighted risk path" reference visual. Same
// data, colours and visibility rules as the other engines; only layout/styling
// differ. G6's event objects are heavily generic, so handlers take `any`.
export function G6Surface({
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
  const graphRef = useRef<Graph | null>(null);
  const readyRef = useRef(false); // true once the first async render has drawn
  const nodeById = useRef(new Map<string, GraphNode>());

  // Latest callbacks/visibility via refs — the Graph is built once and never
  // torn down on a callback change.
  const cb = useRef({ onHover, onOpenEntity, isLive });
  cb.current = { onHover, onOpenEntity, isLive };
  const vis = useRef({ visibleEdgeIds, visibleNodeIds, revealLabels });
  vis.current = { visibleEdgeIds, visibleNodeIds, revealLabels };

  // Slider/isolate gate → dim filtered-out elements with the `inactive` state;
  // label gate → visible-but-not-revealed counterparties get the `nolabel` state
  // (hides the name only). Subjects always keep their label; hover sets `active`
  // (labelOpacity 1) so the hovered node's name shows.
  const applyVisibility = () => {
    const g = graphRef.current;
    if (!g || !readyRef.current) return; // elements aren't drawn until render resolves
    const { visibleEdgeIds: ve, visibleNodeIds: vn, revealLabels: rl } = vis.current;
    const states: Record<string, string[]> = {};
    nodes.forEach((n) => {
      const visible = vn.has(n.id) || n.type === 'main';
      if (!visible) { states[n.id] = ['inactive']; return; }
      const showLabel = n.type === 'main' || n.type === 'peer_subject' || (rl && vn.has(n.id));
      states[n.id] = showLabel ? [] : ['nolabel'];
    });
    edges.forEach((e) => { states[e.id] = ve.has(e.id) ? [] : ['inactive']; });
    g.setElementState(states, false);
  };

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    nodeById.current = new Map(nodes.map((n) => [n.id, n]));
    const subjectId = nodes.find((n) => n.type === 'main')?.id ?? nodes[0]?.id;

    const data = {
      nodes: nodes.map((n) => {
        const c = darkNode(n);
        return {
          id: n.id,
          style: {
            size: nodeSize(n),
            fill: c.fill,
            stroke: c.stroke,
            lineWidth: (n.type === 'main' || n.type === 'peer_subject') ? 4 : 1.5,
            labelText: n.sublabel || n.label,
            labelFill: c.text,
            labelFontSize: (n.type === 'main' || n.type === 'peer_subject') ? 11 : 9,
            labelFontWeight: (n.type === 'main' || n.type === 'peer_subject') ? 700 : 500,
            labelPlacement: 'bottom',
            labelBackground: true,
            labelBackgroundFill: '#0b0b0f',
            labelBackgroundOpacity: 0.65,
            labelBackgroundRadius: 3,
            labelPadding: [1, 4],
          },
          data: { type: n.type },
        };
      }),
      edges: edges.map((e) => {
        const col = edgeColor(e.category);
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          style: {
            stroke: col,
            lineWidth: e.suspicious ? 2.7 : 1.5,
            endArrow: true,
            opacity: e.suspicious ? 0.85 : 0.55,
            // Suspicious flows glow so the risk path stands out on black.
            shadowColor: col,
            shadowBlur: e.suspicious ? 8 : 0,
          },
        };
      }),
    };

    const g = new Graph({
      container: box,
      autoResize: true,
      background: '#0b0b0f',
      data,
      node: {
        state: {
          active: { lineWidth: 3, shadowColor: '#ffffff', shadowBlur: 14, labelOpacity: 1 },
          inactive: { opacity: 0.18, labelOpacity: 0 },
          nolabel: { labelOpacity: 0 }, // node visible, name hidden (label gate)
        },
      },
      edge: {
        state: {
          active: { lineWidth: 3, opacity: 1 },
          inactive: { opacity: 0.05, shadowBlur: 0 },
        },
      },
      layout: {
        type: 'radial',
        focusNode: subjectId,
        unitRadius: 130,
        linkDistance: 140,
        preventOverlap: true,
        nodeSize: 60,
        strictRadial: false,
      },
      behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element'],
      // Re-fit the viewport on each render.
      autoFit: 'view',
    } as never);
    graphRef.current = g;

    const map = nodeById.current;
    const clientXY = (e: any): [number, number] => {
      const ne = e?.nativeEvent as PointerEvent | undefined;
      return [ne?.clientX ?? e?.client?.x ?? 0, ne?.clientY ?? e?.client?.y ?? 0];
    };

    // Hover spotlight: the node + its neighbours go `active`, everything else
    // `inactive` — then restore the filter state on leave.
    const spotlight = (id: string) => {
      const keepN = new Set<string>([id, ...g.getNeighborNodesData(id).map((n: any) => n.id)]);
      const keepE = new Set<string>(g.getRelatedEdgesData(id).map((e: any) => e.id));
      const states: Record<string, string[]> = {};
      nodes.forEach((n) => { states[n.id] = keepN.has(n.id) ? ['active'] : ['inactive']; });
      edges.forEach((e) => { states[e.id] = keepE.has(e.id) ? ['active'] : ['inactive']; });
      g.setElementState(states, false);
    };

    g.on('node:pointerenter', (e: any) => {
      const id = e.target.id as string;
      spotlight(id);
      const [x, y] = clientXY(e);
      cb.current.onHover(map.get(id) ?? null, x, y);
    });
    g.on('node:pointermove', (e: any) => {
      const [x, y] = clientXY(e);
      cb.current.onHover(map.get(e.target.id as string) ?? null, x, y);
    });
    g.on('node:pointerleave', () => {
      applyVisibility();
      cb.current.onHover(null, 0, 0);
    });
    g.on('node:dblclick', (e: any) => {
      if (cb.current.isLive) cb.current.onOpenEntity(e.target.id as string);
    });

    g.render()
      .then(() => { readyRef.current = true; applyVisibility(); })
      .catch(() => {});

    return () => { readyRef.current = false; g.destroy(); graphRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  // React to slider / isolate / label-reveal changes.
  useEffect(applyVisibility, [visibleEdgeIds, visibleNodeIds, revealLabels]);

  // Reset = re-run the radial layout and re-fit.
  useEffect(() => {
    const g = graphRef.current;
    if (!g || !readyRef.current || resetSignal === 0) return;
    g.layout().then(() => g.fitView()).catch(() => {});
  }, [resetSignal]);

  return (
    <div className="flex-1 relative">
      <div ref={boxRef} className="absolute inset-0" style={{ background: '#0b0b0f' }} />
      <ZoomControls
        onZoomIn={() => graphRef.current?.zoomBy(1.25)}
        onZoomOut={() => graphRef.current?.zoomBy(0.8)}
        onFit={() => graphRef.current?.fitView()}
      />
    </div>
  );
}
