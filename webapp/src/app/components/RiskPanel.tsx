import { useState, useEffect } from 'react';
import { FileText, ArrowUpCircle, CheckCircle, Clock, User, Cpu, ChevronDown, Download, Loader2, Hourglass } from 'lucide-react';
import { AMLCase, RiskCategory } from '../data/cases';
import { CaseProgress, addFinding, saveCaseProgress, exportLog } from '../hooks/useCaseStorage';
import { fetchModels, ModelsInfo, postDecision, regenerateRationale } from '../data/api';

const FACTOR_COLORS: Record<RiskCategory, { dot: string; badge: string; text: string }> = {
  circular:    { dot: 'bg-orange-400',  badge: 'bg-orange-50 border-orange-200 text-orange-700',    text: 'text-orange-700'  },
  sanctioned:  { dot: 'bg-red-500',     badge: 'bg-red-50 border-red-200 text-red-700',              text: 'text-red-700'     },
  shell:       { dot: 'bg-amber-400',   badge: 'bg-amber-50 border-amber-200 text-amber-700',        text: 'text-amber-700'   },
  high_risk:   { dot: 'bg-fuchsia-500', badge: 'bg-fuchsia-50 border-fuchsia-200 text-fuchsia-700',  text: 'text-fuchsia-700' },
  structuring: { dot: 'bg-teal-500',    badge: 'bg-teal-50 border-teal-200 text-teal-700',           text: 'text-teal-700'    },
};

// The deterministic band — derived from the real thresholds (default 0.65/0.35),
// NOT the Figma mock's 0.50/0.55/0.75. This is what fixes 0.74 -> SAR.
type Band = 'SAR' | 'EDD' | 'CLEAR';
function bandOf(score: number, bands?: { sar: number; edd: number }): Band {
  const sar = bands?.sar ?? 0.65;
  const edd = bands?.edd ?? 0.35;
  return score >= sar ? 'SAR' : score >= edd ? 'EDD' : 'CLEAR';
}
const BAND_UI: Record<Band, { label: string; badge: string; text: string; marker: string }> = {
  SAR:   { label: 'SAR',   badge: 'bg-red-100 text-red-700 border-red-200',       text: 'text-red-600',    marker: '#ef4444' },
  EDD:   { label: 'EDD',   badge: 'bg-orange-100 text-orange-700 border-orange-200', text: 'text-orange-500', marker: '#f97316' },
  CLEAR: { label: 'CLEAR', badge: 'bg-green-100 text-green-700 border-green-200',   text: 'text-green-600',  marker: '#22c55e' },
};
const HEADLINE: Record<Band, string> = {
  SAR: 'File a Suspicious Activity Report (SAR)',
  EDD: 'Escalate to Enhanced Due Diligence (EDD)',
  CLEAR: 'No action — clear the alert',
};

// UI decision -> backend action (the backend only knows SAR/EDD/CLEAR).
const DECISION_ACTION: Record<'filed' | 'escalated' | 'cleared', string> = {
  filed: 'SAR',
  escalated: 'EDD',
  cleared: 'CLEAR',
};

interface Props {
  amlCase: AMLCase | null;
  progress: CaseProgress | null;
  loading?: boolean;   // a case is being fetched/scored — show a working indicator
  decidedBy: string;
  isolatedCategory: string | null;
  onIsolate: (category: string) => void;
  onProgressChange: (p: CaseProgress) => void;
}

export function RiskPanel({ amlCase, progress, loading = false, decidedBy, isolatedCategory, onIsolate, onProgressChange }: Props) {
  const [expandedFactors, setExpandedFactors] = useState<Set<number>>(new Set());
  const [activeTab, setActiveTab] = useState<'sar' | 'trail'>('sar');
  const [models, setModels] = useState<ModelsInfo | null>(null);
  const [rationale, setRationale] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [posting, setPosting] = useState(false);

  const isLive = !!amlCase?.isLive;

  // Keep the shown rationale in sync with the loaded case; load the model list
  // for the live case so the analyst can switch the model behind the rationale.
  useEffect(() => {
    setRationale(amlCase?.sarSummary ?? '');
  }, [amlCase?.id, amlCase?.sarSummary]);

  useEffect(() => {
    if (isLive) fetchModels().then(setModels).catch(() => setModels(null));
    else setModels(null);
  }, [amlCase?.id, isLive]);

  // While a case is loading, show a working indicator (a turning hourglass) — not
  // the empty "no case" state — so the panel reads as "analysing", not "cleared".
  if (loading) {
    return (
      <div className="w-[380px] flex-shrink-0 flex flex-col items-center justify-center bg-white border-l border-gray-200 text-center px-8">
        <Hourglass
          size={30}
          className="text-indigo-500 mb-3 animate-spin"
          style={{ animationDuration: '1.6s' }}
        />
        <p className="text-sm font-medium text-gray-600 mb-1">Analyzing the data</p>
        <p className="text-xs text-gray-400">Building the scored network and risk assessment…</p>
      </div>
    );
  }

  if (!amlCase || !progress) {
    return (
      <div className="w-[380px] flex-shrink-0 flex flex-col items-center justify-center bg-white border-l border-gray-200 text-center px-8">
        <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
          <FileText size={20} className="text-gray-400" />
        </div>
        <p className="text-sm font-medium text-gray-600 mb-1">No case selected</p>
        <p className="text-xs text-gray-400">Select an alerted customer from the dropdown to load the risk analysis.</p>
      </div>
    );
  }

  const { riskScore, riskFactors, id: caseId, sources } = amlCase;
  const band: Band = (amlCase.band as Band) ?? bandOf(riskScore, amlCase.bands);
  const bands = amlCase.bands ?? { sar: 0.65, edd: 0.35 };
  const bandUi = BAND_UI[band];
  const headline = amlCase.headline ?? HEADLINE[band];
  const decision = progress.decision;
  const notes = progress.notes;

  const toggleFactor = (i: number) => {
    setExpandedFactors(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  const update = (patch: Partial<CaseProgress>) => {
    const next = { ...progress, ...patch };
    onProgressChange(next);
    saveCaseProgress(next);
  };

  const handleDecision = async (type: 'filed' | 'escalated' | 'cleared') => {
    const labels = { filed: 'SAR filed', cleared: 'Case cleared', escalated: 'Escalated to EDD' };
    // Persist to the backend audit trail for the live case (carry the analyst's
    // 6-digit id as decided_by). Local findings are recorded either way.
    if (isLive) {
      setPosting(true);
      try {
        await postDecision(caseId, { action: DECISION_ACTION[type], decided_by: decidedBy, notes });
      } catch {
        /* keep the local record even if the API write fails */
      } finally {
        setPosting(false);
      }
    }
    const next = addFinding(progress, 'decision', `Decision recorded: ${labels[type]} by ${decidedBy}.`);
    update({ ...next, decision: type });
  };

  const handleNotesBlur = () => {
    if (notes) {
      const next = addFinding(progress, 'note', `Note added: "${notes.slice(0, 80)}${notes.length > 80 ? '…' : ''}"`);
      update(next);
    }
  };

  const onModelChange = async (model: string) => {
    if (!isLive || !model) return;
    setRegenerating(true);
    try {
      const r = await regenerateRationale(caseId, model);
      setRationale(r.rationale);
      setModels(prev => (prev ? { ...prev, current: model } : prev));
    } catch {
      /* leave the existing rationale on failure */
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="w-[380px] flex-shrink-0 flex flex-col bg-white border-l border-gray-200 overflow-hidden">

      {/* ── Risk Score ───────────────────────────────────────────── */}
      <div className="px-4 pt-4 pb-3 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-gray-400 uppercase tracking-widest font-medium">Entity Risk Score</span>
          <span className={`text-[10px] border px-2 py-0.5 rounded-full font-semibold ${bandUi.badge}`}>
            {bandUi.label}
          </span>
        </div>

        <div className="flex items-end gap-3 mb-2.5">
          <span className={`text-5xl font-thin leading-none tracking-tight ${bandUi.text}`}>{riskScore.toFixed(2)}</span>
          <div className="flex-1 pb-1">
            <div className="relative h-2.5 rounded-full overflow-hidden" style={{
              background: 'linear-gradient(to right, #22c55e 0%, #eab308 45%, #f97316 70%, #ef4444 100%)',
            }}>
              {/* EDD + SAR threshold ticks (the real bands) */}
              <div className="absolute top-0 bottom-0 w-px bg-white/70" style={{ left: `${bands.edd * 100}%` }} />
              <div className="absolute top-0 bottom-0 w-px bg-white/70" style={{ left: `${bands.sar * 100}%` }} />
              <div
                className="absolute top-1/2 w-3.5 h-3.5 rounded-full bg-white border-2 shadow-md"
                style={{ left: `${riskScore * 100}%`, transform: 'translate(-50%, -50%)', borderColor: bandUi.marker }}
              />
            </div>
            <div className="flex justify-between text-[9px] text-gray-400 mt-1 px-0.5">
              <span>Clear</span>
              <span>EDD {bands.edd}</span>
              <span>SAR {bands.sar}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {riskFactors.map(f => (
            <span key={f.name} className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${FACTOR_COLORS[f.category].badge}`}>
              {f.name}
            </span>
          ))}
        </div>
      </div>

      {/* ── Risk Factors ─────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-gray-100 flex-shrink-0">
        <div className="text-[10px] text-gray-400 uppercase tracking-widest mb-2 font-medium">
          Risk Factors {isLive && <span className="text-gray-300 normal-case tracking-normal">· rule-based</span>}
        </div>
        <div className="space-y-1.5">
          {riskFactors.map((factor, i) => (
            <div key={factor.name} className="rounded-lg border border-gray-100 overflow-hidden">
              <div
                onClick={() => toggleFactor(i)}
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-50 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${FACTOR_COLORS[factor.category].dot}`} />
                  <span className="text-xs font-medium text-slate-700">{factor.name}</span>
                </div>
                <div className="flex items-center gap-2.5">
                  {/* Rule-based contribution (replaces the misleading "AI" term) */}
                  {factor.contribution != null
                    ? <span className="text-[10px] font-mono text-slate-500">+{factor.contribution.toFixed(2)}</span>
                    : <span className="text-[10px] text-gray-400">{factor.detectors} det.</span>}
                  {/* Isolate this pattern's subgraph in the network view */}
                  <button
                    onClick={e => { e.stopPropagation(); onIsolate(factor.category); }}
                    className={`text-[10px] font-medium px-1.5 py-0.5 rounded border transition-colors ${
                      isolatedCategory === factor.category
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : 'border-gray-200 text-gray-500 hover:border-indigo-300 hover:text-indigo-600'
                    }`}
                    title={isolatedCategory === factor.category ? 'Show the whole network' : 'Isolate this pattern in the graph'}
                  >
                    {isolatedCategory === factor.category ? 'Isolated' : 'Isolate'}
                  </button>
                  <span className="text-[10px] text-indigo-600 font-medium">
                    {expandedFactors.has(i) ? 'Less' : 'Examine'}
                  </span>
                  <ChevronDown size={12} className={`text-gray-400 transition-transform ${expandedFactors.has(i) ? 'rotate-180' : ''}`} />
                </div>
              </div>
              {expandedFactors.has(i) && (
                <div className={`px-3 py-2 text-[11px] leading-relaxed border-t border-gray-100 bg-gray-50/60 ${FACTOR_COLORS[factor.category].text}`}>
                  {factor.detail}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Source-integration badges (World-Check / TM / KYC / Watchlist) */}
        {sources && sources.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
            {sources.map(s => (
              <span key={s.key} title={s.detail}
                className="text-[9px] px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 text-gray-500">
                {s.label} <span className="font-semibold text-slate-600">{s.count}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────── */}
      <div className="flex border-b border-gray-100 flex-shrink-0">
        {(['sar', 'trail'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2 text-[11px] font-medium transition-colors border-b-2 ${
              activeTab === tab ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}
          >
            {tab === 'sar' ? 'Recommendation' : `Trail (${progress.findings.length})`}
          </button>
        ))}
      </div>

      {/* ── Recommendation Tab ───────────────────────────────────── */}
      {activeTab === 'sar' && (
        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] text-gray-400 uppercase tracking-widest font-medium">{headline}</div>
            </div>

            {/* Model selector for the rationale (live only) */}
            {isLive && models && models.models.length > 0 && (
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] text-gray-400">Rationale model</span>
                <select
                  value={models.current ?? ''}
                  disabled={regenerating}
                  onChange={e => onModelChange(e.target.value)}
                  className="text-[10px] border border-gray-200 rounded px-1.5 py-1 bg-white text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                >
                  {models.models.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                {regenerating && <Loader2 size={12} className="text-indigo-500 animate-spin" />}
              </div>
            )}

            <div className="text-[11px] text-slate-600 leading-relaxed p-3 bg-amber-50/60 border border-amber-100 rounded-lg mb-3 whitespace-pre-wrap">
              {regenerating ? 'Regenerating rationale…' : rationale}
            </div>

            {decision !== 'pending' && (
              <div className={`flex items-center gap-2 rounded-lg px-3 py-2.5 mb-3 text-[11px] font-medium ${
                decision === 'filed'     ? 'bg-green-50 text-green-700 border border-green-200' :
                decision === 'escalated' ? 'bg-orange-50 text-orange-700 border border-orange-200' :
                                           'bg-gray-100 text-gray-600 border border-gray-200'
              }`}>
                <CheckCircle size={13} />
                {decision === 'filed'     && 'SAR filed — recorded in the audit trail'}
                {decision === 'escalated' && 'Escalated to Enhanced Due Diligence (EDD)'}
                {decision === 'cleared'   && 'Alert cleared — no further action'}
              </div>
            )}

            <div className="flex gap-2 mb-3">
              <button
                onClick={() => handleDecision('filed')}
                disabled={decision !== 'pending' || posting}
                className="flex-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white text-[11px] py-2 px-3 rounded-lg transition-colors flex items-center justify-center gap-1.5 font-medium"
              >
                <FileText size={12} /> File SAR
              </button>
              <button
                onClick={() => handleDecision('escalated')}
                disabled={decision !== 'pending' || posting}
                className="flex-1 bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white text-[11px] py-2 px-3 rounded-lg transition-colors flex items-center justify-center gap-1.5 font-medium"
              >
                <ArrowUpCircle size={12} /> Escalate EDD
              </button>
              <button
                onClick={() => handleDecision('cleared')}
                disabled={decision !== 'pending' || posting}
                className="px-3 py-2 text-[11px] border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors text-gray-600 font-medium"
              >
                Clear
              </button>
            </div>

            <div className="mb-3">
              <label className="text-[10px] text-gray-400 uppercase tracking-widest font-medium block mb-1.5">
                Review notes
              </label>
              <textarea
                value={notes}
                onChange={e => update({ notes: e.target.value })}
                onBlur={handleNotesBlur}
                placeholder="Add analyst notes or observations..."
                className="w-full border border-gray-200 rounded-lg p-2.5 text-[11px] resize-none h-16 focus:outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 placeholder:text-gray-400 bg-gray-50/60"
              />
            </div>

            <div className="text-[9px] text-gray-400 flex items-center justify-between">
              <span>Analyst: {decidedBy}</span>
              {amlCase.engine && <span>engine: {amlCase.engine}</span>}
            </div>
          </div>
        </div>
      )}

      {/* ── Trail Tab ────────────────────────────────────────────── */}
      {activeTab === 'trail' && (
        <div className="flex-1 overflow-y-auto flex flex-col">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-50 flex-shrink-0">
            <span className="text-[10px] text-gray-400 uppercase tracking-widest">Case log · {caseId}</span>
            <button
              onClick={() => exportLog(progress, caseId)}
              className="flex items-center gap-1 text-[10px] text-indigo-600 hover:text-indigo-800 transition-colors"
            >
              <Download size={10} /> Export log
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-0.5">
            {/* System recommendation (the deterministic engine output) */}
            <div className="flex gap-3 py-3 border-b border-gray-50">
              <div className="w-7 h-7 rounded-full bg-indigo-100 border border-indigo-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Cpu size={12} className="text-indigo-600" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[11px] font-semibold text-slate-700">System recommendation</span>
                  <span className="text-[9px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full font-semibold">auto</span>
                </div>
                <p className="text-[10px] text-gray-500 leading-relaxed mb-1">
                  {headline} — score {riskScore.toFixed(2)} → band {band}. Detected: {riskFactors.map(f => f.name).join(', ') || 'none'}.
                </p>
                <span className="text-[9px] text-gray-400 flex items-center gap-1"><Clock size={9} /> On case load · automated</span>
              </div>
            </div>

            {/* Progress findings */}
            {[...progress.findings].reverse().map((entry, i) => (
              <div key={i} className="flex gap-3 py-3 border-b border-gray-50 last:border-0">
                <div className="w-7 h-7 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <User size={12} className="text-gray-500" />
                </div>
                <div className="flex-1">
                  <div className="text-[10px] text-gray-500 leading-relaxed mb-0.5">{entry.content}</div>
                  <div className="flex items-center gap-1 text-[9px] text-gray-400">
                    <Clock size={9} />
                    <span>{new Date(entry.timestamp).toLocaleString()}</span>
                    <span>·</span>
                    <span>{entry.type.replace('_', ' ')}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
