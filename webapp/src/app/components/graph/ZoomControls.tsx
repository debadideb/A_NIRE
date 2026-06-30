import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';

// Shared top-right zoom cluster. Each renderer wires these to its own viewport
// (canvas zoom state, cy.zoom, graph.zoomBy) so the control looks and sits
// identically whatever engine is active.
export function ZoomControls({
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  const btns = [
    { icon: <ZoomIn size={13} />, action: onZoomIn, tip: 'Zoom in' },
    { icon: <ZoomOut size={13} />, action: onZoomOut, tip: 'Zoom out' },
    { icon: <Maximize2 size={13} />, action: onFit, tip: 'Fit' },
  ];
  return (
    <div className="absolute top-3 right-3 z-10 flex flex-col gap-1">
      {btns.map((b, i) => (
        <button
          key={i}
          onClick={b.action}
          title={b.tip}
          className="bg-white/90 backdrop-blur-sm rounded-md p-1.5 border border-gray-200 hover:bg-white shadow-sm text-slate-500 hover:text-slate-800 transition-colors"
        >
          {b.icon}
        </button>
      ))}
    </div>
  );
}
