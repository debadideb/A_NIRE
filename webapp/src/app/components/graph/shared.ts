// Shared graph plumbing for the pluggable renderer layer.
//
// The console can draw the SAME scored network with three different engines —
// the default HTML5-canvas renderer, Cytoscape (force-clustered), and G6
// (radial dendrogram). The visibility rules (contribution slider + risk-factor
// isolate) and the colour vocabulary (one colour per detector pattern) must be
// IDENTICAL across all three, so an investigator reads the same picture whatever
// the view. Anything cross-renderer lives here; engine-specific drawing lives in
// each surface component.

import { GraphNode, GraphEdge } from '../../data/cases';

export type RendererId = 'canvas' | 'cytoscape' | 'g6';

export const RENDERERS: { id: RendererId; label: string; hint: string }[] = [
  { id: 'canvas',    label: 'Default',   hint: 'Subject-centred flow map' },
  { id: 'cytoscape', label: 'Cytoscape', hint: 'Force-directed clusters' },
  { id: 'g6',        label: 'G6',        hint: 'Radial dendrogram' },
];

// One colour per detector pattern — the single source of truth for every
// renderer and the legend.
export function edgeColor(category: GraphEdge['category']): string {
  if (category === 'circular') return '#f97316';
  if (category === 'sanctioned') return '#ef4444';
  if (category === 'shell') return '#f59e0b';
  if (category === 'high_risk') return '#d946ef';
  if (category === 'structuring') return '#2dd4bf';
  return '#94a3b8';
}

export const LEGEND_ITEMS = [
  { color: '#f97316', label: 'Circular flow' },
  { color: '#ef4444', label: 'Sanctioned' },
  { color: '#f59e0b', label: 'Shell linkage' },
  { color: '#d946ef', label: 'High-risk outbound' },
  { color: '#2dd4bf', label: 'Structuring' },
  { color: '#94a3b8', label: 'Normal flow' },
];

// Dark-theme node palette (Cytoscape + G6 draw on a dark canvas, like the
// reference visuals). Nodes read as light discs with a risk-coloured ring;
// labels are light for contrast. The default canvas renderer keeps its own
// light-theme palette.
export function darkNode(n: GraphNode): { fill: string; stroke: string; text: string } {
  if (n.type === 'main')       return { fill: '#f8fafc', stroke: '#f97316', text: '#f8fafc' };
  if (n.type === 'sanctioned') return { fill: '#fecaca', stroke: '#ef4444', text: '#fca5a5' };
  if (n.type === 'shell')      return { fill: '#fde68a', stroke: '#f59e0b', text: '#fcd34d' };
  if (n.risk === 'high')       return { fill: '#fed7aa', stroke: '#fb923c', text: '#fdba74' };
  if (n.risk === 'medium')     return { fill: '#fef3c7', stroke: '#fbbf24', text: '#fde68a' };
  return { fill: '#e2e8f0', stroke: '#94a3b8', text: '#cbd5e1' };
}

// Diameter used by the dark renderers — derived from the same flow-scaled radius
// the adapter assigns (subject largest), clamped so labels stay legible.
export function nodeSize(n: GraphNode): number {
  return Math.round(Math.min(60, Math.max(20, n.radius * 1.7)));
}

export interface Visibility {
  visibleEdgeIds: Set<string>;
  visibleNodeIds: Set<string>;
}

// Visibility gate shared by every renderer: an edge survives the contribution
// slider AND (if a risk factor is isolated) matches that pattern. A node stays
// lit if it touches a surviving edge (the subject is always kept). Everything
// else is dimmed, not removed — context is preserved.
export function computeVisibility(
  edges: GraphEdge[],
  threshold: number,
  isolateCategory: string | null,
): Visibility {
  const totalVolume = edges.reduce((s, e) => s + e.amountValue, 0) || 1;
  const visibleEdgeIds = new Set(
    edges
      .filter(
        (e) =>
          (threshold === 0 || (e.amountValue / totalVolume) * 100 >= threshold) &&
          (!isolateCategory || e.category === isolateCategory),
      )
      .map((e) => e.id),
  );
  const visibleNodeIds = new Set<string>();
  edges.forEach((e) => {
    if (visibleEdgeIds.has(e.id)) {
      visibleNodeIds.add(e.from);
      visibleNodeIds.add(e.to);
    }
  });
  return { visibleEdgeIds, visibleNodeIds };
}

// Props every alternative (non-canvas) surface accepts. Hover/double-click are
// reported UP so the container owns the single tooltip + entity modal — one
// implementation, identical across renderers.
export interface SurfaceProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  visibleEdgeIds: Set<string>;
  visibleNodeIds: Set<string>;
  isLive: boolean;
  resetSignal: number; // bump to re-run layout + fit
  onHover: (node: GraphNode | null, clientX: number, clientY: number) => void;
  onOpenEntity: (id: string) => void;
}
