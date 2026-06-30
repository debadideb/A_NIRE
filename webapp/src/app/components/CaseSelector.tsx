import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Search, Clock, CheckCircle2, Circle, X } from 'lucide-react';
import { CASES, AMLCase, CaseStatus } from '../data/cases';

const STATUS_CONFIG: Record<CaseStatus, { label: string; color: string; icon: React.ReactNode }> = {
  ongoing:     { label: 'Ongoing',     color: 'text-blue-700 bg-blue-50 border-blue-200',   icon: <Clock size={10} /> },
  closed:      { label: 'Closed',      color: 'text-green-700 bg-green-50 border-green-200', icon: <CheckCircle2 size={10} /> },
  not_started: { label: 'Not started', color: 'text-gray-500 bg-gray-100 border-gray-200',   icon: <Circle size={10} /> },
};

interface Props {
  selectedCaseId: string | null;
  onSelect: (c: AMLCase) => void;
}

export function CaseSelector({ selectedCaseId, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedCase = CASES.find(c => c.id === selectedCaseId) ?? null;

  const filtered = CASES.filter(c => {
    const q = query.toLowerCase();
    return (
      !q ||
      c.customerName.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q)
    );
  });

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
    else setQuery('');
  }, [open]);

  // Colour by the real bands (SAR ≥ 0.65 · EDD ≥ 0.35), not the Figma mock's
  // 0.55/0.75 — so a 0.74 case reads red (SAR), consistent with the risk panel.
  const bandClasses = (score: number) =>
    score >= 0.65 ? 'border-red-300 bg-red-50 text-red-600'
    : score >= 0.35 ? 'border-orange-300 bg-orange-50 text-orange-600'
    : 'border-green-300 bg-green-50 text-green-600';

  return (
    <div className="relative" ref={ref}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs transition-colors ${
          open
            ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
            : 'bg-white border-gray-200 text-slate-600 hover:border-gray-300 hover:bg-gray-50'
        }`}
      >
        {selectedCase ? (
          <>
            <span className="font-medium max-w-[140px] truncate">{selectedCase.customerName}</span>
            <span className={`text-[10px] border px-1.5 py-0.5 rounded-full font-medium ${STATUS_CONFIG[selectedCase.status].color}`}>
              {STATUS_CONFIG[selectedCase.status].label}
            </span>
          </>
        ) : (
          <span className="text-gray-400">Select a case…</span>
        )}
        <ChevronDown size={12} className={`ml-0.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-80 bg-white border border-gray-200 rounded-xl shadow-xl z-50 overflow-hidden">
          {/* Search */}
          <div className="px-3 py-2.5 border-b border-gray-100 flex items-center gap-2">
            <Search size={13} className="text-gray-400 flex-shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by name or case ID…"
              className="flex-1 text-xs outline-none placeholder:text-gray-400 bg-transparent"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-gray-400 hover:text-gray-600">
                <X size={12} />
              </button>
            )}
          </div>

          {/* Case list */}
          <div className="max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-gray-400">No cases match "{query}"</div>
            ) : (
              filtered.map(c => {
                const st = STATUS_CONFIG[c.status];
                const isSelected = c.id === selectedCaseId;
                return (
                  <div
                    key={c.id}
                    onClick={() => { onSelect(c); setOpen(false); }}
                    className={`flex items-start gap-3 px-4 py-3 cursor-pointer border-b border-gray-50 last:border-0 transition-colors ${
                      isSelected ? 'bg-indigo-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    {/* Risk score circle */}
                    <div className={`w-9 h-9 rounded-full border-2 flex items-center justify-center flex-shrink-0 text-[11px] font-bold ${bandClasses(c.riskScore)}`}>
                      {c.riskScore.toFixed(2).replace('0.', '.')}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className={`text-xs font-semibold truncate ${isSelected ? 'text-indigo-700' : 'text-slate-800'}`}>
                          {c.customerName}
                          {c.isLive && (
                            <span className="ml-1.5 align-middle text-[8px] font-bold tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1 py-px">LIVE</span>
                          )}
                        </span>
                        <span className={`text-[9px] border px-1.5 py-0.5 rounded-full font-medium flex items-center gap-1 flex-shrink-0 ${st.color}`}>
                          {st.icon}
                          {st.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
                        <span className="font-mono">{c.id}</span>
                        {c.triggerTags.slice(0, 2).map(tag => (
                          <span key={tag} className="bg-gray-100 rounded px-1">{tag}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-[10px] text-gray-400">
            {filtered.length} of {CASES.length} cases
          </div>
        </div>
      )}
    </div>
  );
}
