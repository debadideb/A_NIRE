import { useEffect, useState } from 'react';
import { NetworkGraph } from './NetworkGraph';
import { AMLCase, CASES, LIVE_CASE_ID } from '../data/cases';
import { fetchCase } from '../data/api';
import { contractToAMLCase } from '../data/adapter';

// Standalone graph view rendered in the pop-out window (URL `?popout=<caseId>`).
// It is its own React root, so canvas/button events work natively — unlike a
// cross-window portal. The live case fetches the real contract; demo cases use
// their static mock data.
export function PopoutGraph({ caseId }: { caseId: string }) {
  const [amlCase, setAmlCase] = useState<AMLCase | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = `AML Network — ${caseId}`;
    if (caseId === LIVE_CASE_ID) {
      fetchCase(caseId)
        .then(c => setAmlCase(contractToAMLCase(c)))
        .catch(e => setError((e as Error).message));
    } else {
      const found = CASES.find(c => c.id === caseId) ?? null;
      if (found) setAmlCase(found);
      else setError(`Unknown case '${caseId}'`);
    }
  }, [caseId]);

  if (error) {
    return <div className="h-screen flex items-center justify-center text-red-500 text-sm px-6 text-center">{error}</div>;
  }
  if (!amlCase) {
    return <div className="h-screen flex items-center justify-center text-slate-400 text-sm">Loading graph…</div>;
  }

  return (
    <div className="h-screen flex flex-col bg-[#e8eaed]">
      <div className="px-4 py-2 bg-white border-b border-gray-200 flex items-center gap-2 flex-shrink-0">
        <span className="text-sm font-semibold text-slate-800">{amlCase.customerName}</span>
        <span className="text-[10px] font-mono text-slate-400">{amlCase.id}</span>
        <span className="text-[10px] text-slate-400 ml-auto">
          Pop-out view · hover a node for detail · double-click for full entity
        </span>
      </div>
      <div className="flex-1 flex">
        <NetworkGraph
          caseId={amlCase.id}
          isLive={!!amlCase.isLive}
          isPopout
          initialNodes={amlCase.nodes}
          edges={amlCase.edges}
        />
      </div>
    </div>
  );
}
