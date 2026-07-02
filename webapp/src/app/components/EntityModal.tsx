import { useEffect, useState } from 'react';
import { X, ShieldAlert, ArrowDownLeft, ArrowUpRight, Loader2, ChevronRight, Crosshair } from 'lucide-react';
import { EntityDetail, fetchEntity } from '../data/api';

interface Props {
  caseId: string;
  entityId: string;
  onClose: () => void;
}

const gbp = (n: number) => '£' + n.toLocaleString();

// Double-click detail modal (backed by GET /api/case/{id}/entity/{id}, i.e.
// Piece B): KYC + World-Check + the entity's risky transaction paths.
export function EntityModal({ caseId, entityId, onClose }: Props) {
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);  // clear any prior entity's data while the new one loads
    setError(null);
    fetchEntity(caseId, entityId)
      .then(d => { if (alive) setDetail(d); })
      .catch(e => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [caseId, entityId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-30 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85%] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <div className="text-[10px] text-gray-400 uppercase tracking-widest font-medium">{entityId}</div>
            <div className="text-base font-semibold text-slate-800">
              {detail?.kyc.name ?? (error ? 'Unavailable' : 'Loading…')}
            </div>
            {detail && (
              <div className="text-[11px] text-gray-500 mt-0.5">
                {detail.kyc.entity_type} · {detail.kyc.jurisdiction}
                {detail.kyc.incorporation_date ? ` · inc. ${detail.kyc.incorporation_date}` : ''}
              </div>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-gray-100 text-gray-400">
            <X size={16} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {error && <p className="text-xs text-red-500">Could not load entity: {error}</p>}
          {!detail && !error && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <Loader2 size={14} className="animate-spin" /> Fetching entity detail…
            </div>
          )}

          {detail && (
            <>
              {/* KYC */}
              <div>
                <div className="text-[10px] text-gray-400 uppercase tracking-widest mb-1.5 font-medium">KYC</div>
                <dl className="grid grid-cols-3 gap-y-1.5 text-[11px]">
                  <dt className="text-gray-400">Risk</dt>
                  <dd className="col-span-2 text-slate-700">
                    {detail.kyc.kyc_risk_rating}{detail.kyc.pep_flag === 'Y' ? ' · PEP' : ''}
                  </dd>
                  <dt className="text-gray-400">Industry</dt>
                  <dd className="col-span-2 text-slate-700">{detail.kyc.industry}</dd>
                  <dt className="text-gray-400">Owner</dt>
                  <dd className="col-span-2 text-slate-700">{detail.kyc.beneficial_owner ?? '—'}</dd>
                </dl>
              </div>

              {/* World-Check */}
              {detail.worldcheck && (
                <div className="rounded-lg border border-red-200 bg-red-50/60 p-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-red-700 mb-1.5">
                    <ShieldAlert size={13} /> World-Check hit
                  </div>
                  <dl className="grid grid-cols-3 gap-y-1 text-[11px]">
                    <dt className="text-red-400">List</dt>
                    <dd className="col-span-2 text-red-800">{detail.worldcheck.watchlist_source} ({detail.worldcheck.match_category})</dd>
                    <dt className="text-red-400">Match</dt>
                    <dd className="col-span-2 text-red-800">{detail.worldcheck.match_score} · {detail.worldcheck.match_status}</dd>
                    <dt className="text-red-400">Severity</dt>
                    <dd className="col-span-2 text-red-800">{detail.worldcheck.severity}</dd>
                    <dt className="text-red-400">Name</dt>
                    <dd className="col-span-2 text-red-800">{detail.worldcheck.screened_name}</dd>
                  </dl>
                </div>
              )}

              {/* Trail back to the subject — the hop-chain (by name) from the
                  alerted subject to this entity, so the risk reads end-to-end
                  rather than as a floating counterparty. */}
              {detail.trail && detail.trail.length > 1 && (
                <div>
                  <div className="text-[10px] text-gray-400 uppercase tracking-widest mb-1.5 font-medium">
                    Trail to subject
                  </div>
                  <div className="flex flex-wrap items-center gap-x-1 gap-y-1 rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2">
                    {detail.trail.map((step, i) => {
                      const isSubject = i === 0;
                      const isEntity = i === detail.trail.length - 1;
                      return (
                        <span key={step.id} className="flex items-center gap-1">
                          <span
                            className={`text-[11px] leading-snug ${
                              isSubject ? 'font-semibold text-indigo-700'
                              : isEntity ? 'font-semibold text-slate-800'
                              : 'text-slate-600'
                            }`}
                            title={step.id}
                          >
                            {isSubject && <Crosshair size={10} className="inline mr-0.5 -mt-0.5" />}
                            {step.name}
                          </span>
                          {!isEntity && <ChevronRight size={12} className="text-gray-300 flex-shrink-0" />}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Risky paths */}
              <div>
                <div className="text-[10px] text-gray-400 uppercase tracking-widest mb-1.5 font-medium">
                  Risky paths ({detail.risky_paths.length})
                </div>
                {detail.risky_paths.length === 0 ? (
                  <p className="text-[11px] text-gray-400">No fired-detector transactions touch this entity.</p>
                ) : (
                  <div className="space-y-1.5">
                    {detail.risky_paths.map((p, i) => (
                      <div key={i} className="flex items-center gap-2.5 rounded-lg border border-gray-100 px-3 py-2">
                        <div className={`flex-shrink-0 ${p.direction === 'debit' ? 'text-orange-500' : 'text-blue-500'}`}>
                          {p.direction === 'debit' ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] text-slate-700">
                            <span className="font-medium">{p.direction === 'debit' ? 'To' : 'From'} {p.counterparty_name}</span>
                            <span className="text-gray-400 font-mono"> · {p.counterparty}</span>
                            <span className="text-gray-400"> · {p.reason}</span>
                          </div>
                          <div className="text-[10px] text-gray-400">{p.txn_ids.join(', ')}</div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className="text-[11px] font-semibold text-slate-700">{gbp(p.amount)}</div>
                          <div className="text-[10px] text-gray-400">{p.contribution_pct}% {p.direction}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
