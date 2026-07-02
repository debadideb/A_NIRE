import { useEffect, useRef } from 'react';
import cytoscape, { Core, ElementDefinition } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { GraphNode } from '../../data/cases';
import { SurfaceProps, edgeColor, darkNode, nodeSize } from './shared';
import { ZoomControls } from './ZoomControls';

// Register the f-CoSE layout once (idempotent — guard against React StrictMode
// double-invoke / hot reload re-running this module).
let fcoseRegistered = false;
function ensureFcose() {
  if (!fcoseRegistered) {
    cytoscape.use(fcose);
    fcoseRegistered = true;
  }
}

// Cytoscape renderer — a force-directed (f-CoSE) clustering view on a dark
// canvas, echoing the "organic clusters / warm edges" reference visual. Same
// data, same colour vocabulary and same visibility rules as the other engines;
// only the layout and styling differ.
export function CytoscapeSurface({
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
  const cyRef = useRef<Core | null>(null);
  const nodeById = useRef(new Map<string, GraphNode>());

  // Keep callbacks/visibility in refs so the cytoscape instance (built once)
  // always sees the latest without being torn down and rebuilt.
  const cb = useRef({ onHover, onOpenEntity, isLive });
  cb.current = { onHover, onOpenEntity, isLive };
  const vis = useRef({ visibleEdgeIds, visibleNodeIds, revealLabels });
  vis.current = { visibleEdgeIds, visibleNodeIds, revealLabels };

  // Re-apply the slider/isolate gate as a `.faded` class (dim, never removed) and
  // the label gate as a `.nolabel` class: counterparty names stay hidden unless a
  // subgraph is selected / a factor is isolated (revealLabels) and the node is
  // in-view. Subjects always keep their label; hover reveals via `.spot`.
  const applyVisibility = () => {
    const cy = cyRef.current;
    if (!cy) return;
    const { visibleEdgeIds: ve, visibleNodeIds: vn, revealLabels: rl } = vis.current;
    cy.batch(() => {
      cy.elements().removeClass('faded dim spot nolabel');
      cy.edges().forEach((e) => { if (!ve.has(e.id())) e.addClass('faded'); });
      cy.nodes().forEach((n) => {
        const t = n.data('type');
        if (!vn.has(n.id()) && t !== 'main') n.addClass('faded');
        const showLabel = t === 'main' || t === 'peer_subject' || (rl && vn.has(n.id()));
        if (!showLabel) n.addClass('nolabel');
      });
    });
  };

  // ── build the instance once per node/edge set ────────────────────────────
  useEffect(() => {
    ensureFcose();
    const box = boxRef.current;
    if (!box) return;

    nodeById.current = new Map(nodes.map((n) => [n.id, n]));

    const elements: ElementDefinition[] = [
      ...nodes.map((n) => {
        const c = darkNode(n);
        return {
          data: {
            id: n.id,
            label: n.sublabel || n.label,
            size: nodeSize(n),
            fill: c.fill,
            stroke: c.stroke,
            text: c.text,
            bw: (n.type === 'main' || n.type === 'peer_subject') ? 4 : 2,
            type: n.type,
          },
        };
      }),
      ...edges.map((e) => ({
        data: {
          id: e.id,
          source: e.from,
          target: e.to,
          color: edgeColor(e.category),
          w: e.suspicious ? 2.9 : 1.5,
        },
      })),
    ];

    const cy = cytoscape({
      container: box,
      elements,
      minZoom: 0.2,
      maxZoom: 4,
      wheelSensitivity: 0.2,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(fill)',
            'border-color': 'data(stroke)',
            'border-width': 'data(bw)',
            width: 'data(size)',
            height: 'data(size)',
            label: 'data(label)',
            color: 'data(text)',
            'font-size': 9,
            'font-weight': 600,
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 3,
            'min-zoomed-font-size': 6,
            'text-background-color': '#171717',
            'text-background-opacity': 0.55,
            'text-background-padding': 2,
            'text-background-shape': 'roundrectangle',
            'overlay-opacity': 0,
          },
        },
        {
          selector: 'node[type="main"]',
          style: {
            'font-size': 11,
            color: '#ffffff',
            'background-color': '#1e293b',
            'text-background-opacity': 0.7,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 'data(w)',
            'line-color': 'data(color)',
            'target-arrow-color': 'data(color)',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.85,
            'curve-style': 'bezier',
            'line-cap': 'round',
            opacity: 0.62,
          },
        },
        // Order matters: `.spot` (hover) comes last so it re-reveals the label of a
        // hovered node even when it was hidden by `.faded`/`.nolabel`.
        { selector: '.dim', style: { opacity: 0.12 } },
        { selector: '.faded', style: { opacity: 0.05, 'text-opacity': 0 } },
        { selector: 'node.nolabel', style: { 'text-opacity': 0 } },
        { selector: 'edge.spot', style: { opacity: 1, width: 3 } },
        { selector: 'node.spot', style: { 'border-width': 4, 'text-opacity': 1 } },
      ],
      layout: {
        name: 'fcose',
        // @ts-expect-error fcose-specific options aren't in the base layout type
        quality: 'default',
        animate: true,
        animationDuration: 500,
        randomize: true,
        // fit the viewport once the force layout settles (fitting on `ready`
        // would frame the pre-layout positions and leave the nodes off-screen).
        fit: true,
        padding: 36,
        nodeRepulsion: 6500,
        idealEdgeLength: 70,
        edgeElasticity: 0.45,
        gravity: 0.3,
        gravityRange: 3.8,
        numIter: 2500,
        nodeSeparation: 75,
      },
    });
    cyRef.current = cy;
    cy.on('layoutstop', () => cy.fit(undefined, 40));

    // Cytoscape caches the container size at init and only re-measures on
    // window resize. Inside our flex layout the box can still be 0-height on the
    // first frame (the canvas would be invisible), and the right rail can change
    // its width — so observe the box and re-measure + re-fit. (G6 does this
    // itself via autoResize.)
    const ro = new ResizeObserver(() => {
      if (cy.destroyed()) return;
      cy.resize();
      cy.fit(undefined, 40);
    });
    ro.observe(box);

    // Hover: spotlight the node + its closed neighbourhood, dim the rest, and
    // report the node up for the shared tooltip.
    const map = nodeById.current;
    cy.on('mouseover', 'node', (evt) => {
      const n = evt.target;
      const nbr = n.closedNeighborhood();
      cy.batch(() => {
        cy.elements().addClass('dim');
        nbr.removeClass('dim').addClass('spot');
      });
      const oe = evt.originalEvent as MouseEvent;
      cb.current.onHover(map.get(n.id()) ?? null, oe.clientX, oe.clientY);
    });
    cy.on('mousemove', 'node', (evt) => {
      const oe = evt.originalEvent as MouseEvent;
      cb.current.onHover(map.get(evt.target.id()) ?? null, oe.clientX, oe.clientY);
    });
    cy.on('mouseout', 'node', () => {
      cy.elements().removeClass('dim spot');
      applyVisibility();
      cb.current.onHover(null, 0, 0);
    });
    cy.on('dbltap', 'node', (evt) => {
      if (cb.current.isLive) cb.current.onOpenEntity(evt.target.id());
    });

    applyVisibility();

    return () => { ro.disconnect(); cy.destroy(); cyRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  // React to slider / isolate / label-reveal changes.
  useEffect(applyVisibility, [visibleEdgeIds, visibleNodeIds, revealLabels]);

  // Reset = re-run the force layout and re-fit.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || resetSignal === 0) return;
    // @ts-expect-error fcose options
    cy.layout({ name: 'fcose', animate: true, animationDuration: 500, randomize: true, padding: 36 }).run();
    cy.one('layoutstop', () => cy.fit(undefined, 40));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  const center = () => {
    const r = boxRef.current?.getBoundingClientRect();
    return { x: (r?.width ?? 0) / 2, y: (r?.height ?? 0) / 2 };
  };
  const zoomTo = (factor: number) => {
    const cy = cyRef.current;
    if (cy) cy.zoom({ level: cy.zoom() * factor, renderedPosition: center() });
  };

  return (
    // The box is sized via flex (not `absolute inset-0`): cytoscape forces
    // `container.style.position = 'relative'`, which would cancel inset-stretch
    // and collapse the height to 0. A flex child stretches regardless.
    <div className="flex-1 relative flex">
      <div ref={boxRef} className="flex-1" style={{ background: '#262626' }} />
      <ZoomControls
        onZoomIn={() => zoomTo(1.25)}
        onZoomOut={() => zoomTo(0.8)}
        onFit={() => cyRef.current?.fit(undefined, 40)}
      />
    </div>
  );
}
