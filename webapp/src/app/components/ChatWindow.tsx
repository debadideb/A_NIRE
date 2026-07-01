import { useState, useRef, useEffect } from 'react';
import { MessageSquare, X, Send, Cpu, ChevronDown } from 'lucide-react';
import { AMLCase } from '../data/cases';
import { gbpCompact } from '../data/adapter';
import { ChatMessage } from '../hooks/useCaseStorage';

// ── Canned, contract-grounded assistant ───────────────────────────────────
// NOT a real LLM Q&A (that is out of scope) — a deterministic responder over the
// loaded case. Uses the real bands (SAR ≥ 0.65 · EDD ≥ 0.35) and GBP, so its
// numbers match the rest of the console.

function bandLabel(score: number, bands?: { sar: number; edd: number }): string {
  const sar = bands?.sar ?? 0.65;
  const edd = bands?.edd ?? 0.35;
  return score >= sar ? 'SAR' : score >= edd ? 'EDD' : 'CLEAR';
}

function generateResponse(msg: string, amlCase: AMLCase | null): string {
  if (!amlCase) {
    return 'Please select a case first so I can provide relevant analysis.';
  }

  const q = msg.toLowerCase();
  const score = amlCase.riskScore;
  const name = amlCase.customerName;
  const factors = amlCase.riskFactors.map(f => f.name).join(', ');
  const band = bandLabel(score, amlCase.bands);
  const sarThreshold = amlCase.bands?.sar ?? 0.65;

  if (q.includes('risk score') || q.includes('score')) {
    return `The risk score for ${name} is **${score.toFixed(2)}** → band **${band}**. This is driven by ${factors}. Bands: SAR ≥ ${sarThreshold}, EDD ≥ ${amlCase.bands?.edd ?? 0.35}, else clear.`;
  }

  if (q.includes('circular') || q.includes('cycle') || q.includes('loop')) {
    const cf = amlCase.riskFactors.find(f => f.category === 'circular');
    if (cf) return `**Circular flow** detected: ${cf.detail} This pattern is a classic money-laundering typology — funds cycle through the network to make the origin untraceable.`;
    return `No circular flow pattern has been detected for ${name} in the current network.`;
  }

  if (q.includes('sanction') || q.includes('ofac') || q.includes('listed') || q.includes('sdn')) {
    const sf = amlCase.riskFactors.find(f => f.category === 'sanctioned');
    if (sf) return `**Sanctioned exposure**: ${sf.detail} OFAC violations carry strict liability — even indirect exposure can trigger mandatory reporting and potential penalties.`;
    return `No direct sanctioned exposure has been identified for ${name}. However, always verify second-degree connections.`;
  }

  if (q.includes('shell') || q.includes('offshore') || q.includes('bvi') || q.includes('nominee')) {
    const sf = amlCase.riskFactors.find(f => f.category === 'shell');
    if (sf) return `**Shell linkage**: ${sf.detail} Shell companies are frequently used in the placement and layering stages of money laundering. Zero-employee, nominee-director structures are significant red flags.`;
    return `No clear shell company linkage detected for ${name}. The entities appear to have identifiable beneficial owners.`;
  }

  if (q.includes('sar') || q.includes('suspicious activity') || q.includes('file') || q.includes('report')) {
    return `${band === 'SAR' ? `✓ Filing a SAR is **recommended** for ${name}.` : band === 'EDD' ? `Enhanced Due Diligence is **recommended** for ${name} (not an automatic SAR).` : `SAR filing is not triggered for ${name}.`} Risk score: ${score.toFixed(2)} → band ${band} (SAR threshold ${sarThreshold}). Key factors: ${factors}. ${amlCase.sarSummary.slice(0, 140)}…`;
  }

  if (q.includes('how many') || q.includes('nodes') || q.includes('entities') || q.includes('connections')) {
    const nodeCount = amlCase.nodes.length;
    const edgeCount = amlCase.edges.length;
    const suspicious = amlCase.edges.filter(e => e.suspicious).length;
    return `The network for ${name} contains **${nodeCount} entities** and **${edgeCount} transaction flows**, of which **${suspicious} are flagged as suspicious**. The main entity type breakdown includes shells, sanctioned parties, and regular entities.`;
  }

  if (q.includes('total') || q.includes('volume') || q.includes('amount') || q.includes('value')) {
    const total = amlCase.edges.reduce((sum, e) => sum + e.amountValue, 0);
    const suspicious = amlCase.edges.filter(e => e.suspicious).reduce((sum, e) => sum + e.amountValue, 0);
    const pct = total ? Math.round((suspicious / total) * 100) : 0;
    return `Total transaction volume across the ${name} network: **${gbpCompact(total)}**. Of this, **${gbpCompact(suspicious)} (${pct}%)** flows through suspicious paths. This proportion is ${pct > 50 ? 'very high' : pct > 25 ? 'elevated' : 'moderate'} and warrants attention.`;
  }

  if (q.includes('recommend') || q.includes('what should') || q.includes('next step') || q.includes('action')) {
    if (band === 'SAR') return `Given the score ${score.toFixed(2)} → **SAR** band, the recommended next step for ${name} is to **file a SAR**. Also consider escalating to the senior AML analyst and freezing incoming transactions pending investigation.`;
    if (band === 'EDD') return `For ${name} (score ${score.toFixed(2)} → **EDD** band), I recommend **Enhanced Due Diligence** before any filing. Review beneficial ownership, request transaction explanations, and check for prior SARs. Re-score after review.`;
    return `${name} scores ${score.toFixed(2)} → **CLEAR** band, below the EDD threshold. Consider a standard review and a watch period.`;
  }

  if (q.includes('status') || q.includes('case status')) {
    return `Case ${amlCase.id} for ${name} is currently **${amlCase.status.replace('_', ' ')}**. Trigger events: ${amlCase.triggerTags.join(', ')}.`;
  }

  if (q.includes('explain') || q.includes('what is') || q.includes('define')) {
    if (q.includes('layering')) return 'Layering is the second stage of money laundering — funds are moved through multiple accounts, jurisdictions, or entities to obscure their trail. Shell companies and circular flows are classic layering tools.';
    if (q.includes('smurfing') || q.includes('structuring')) return 'Smurfing (structuring) involves breaking large transactions into smaller ones to avoid reporting thresholds. In this network, the fan-out pattern through multiple shells at near-identical values is a strong smurfing indicator.';
    if (q.includes('placement')) return 'Placement is the first AML stage — illegal funds enter the financial system. High-value cash deposits, trade-based laundering, and real estate purchases are common placement methods.';
    if (q.includes('integration')) return 'Integration is the final AML stage — laundered funds re-enter the legitimate economy, appearing as clean money through investments, loans, or purchases.';
  }

  if (q.includes('hello') || q.includes('hi') || q.includes('hey')) {
    return `Hello! I'm the AML network assistant for **${name}** (Case ${amlCase.id}). I can help you analyze the network, explain risk factors, evaluate SAR obligations, or summarize transaction patterns. What would you like to know?`;
  }

  // Fallback
  const suggestions = ['risk score', 'circular flow', 'sanctioned exposure', 'total volume', 'SAR filing', 'recommendations'];
  return `I can help you analyze the **${name}** network. Try asking about: ${suggestions.map(s => `*${s}*`).join(', ')}.`;
}

// ── Component ─────────────────────────────────────────────────────────────

interface Props {
  amlCase: AMLCase | null;
  history: ChatMessage[];
  onNewMessages: (msgs: ChatMessage[]) => void;
}

export function ChatWindow({ amlCase, history, onNewMessages }: Props) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open, history.length]);

  const send = () => {
    const content = input.trim();
    if (!content) return;

    const userMsg: ChatMessage = { role: 'user', content, timestamp: new Date().toISOString() };
    setInput('');
    setTyping(true);

    const updated = [...history, userMsg];
    onNewMessages(updated);

    setTimeout(() => {
      const reply = generateResponse(content, amlCase);
      const assistantMsg: ChatMessage = { role: 'assistant', content: reply, timestamp: new Date().toISOString() };
      onNewMessages([...updated, assistantMsg]);
      setTyping(false);
    }, 700 + Math.random() * 400);
  };

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const renderContent = (text: string) => {
    // Simple markdown-like bold rendering
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, i) =>
      part.startsWith('**') && part.endsWith('**')
        ? <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
        : part.startsWith('*') && part.endsWith('*')
        ? <em key={i}>{part.slice(1, -1)}</em>
        : <span key={i}>{part}</span>
    );
  };

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(v => !v)}
        className={`fixed bottom-5 right-5 z-50 w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all ${
          open ? 'bg-slate-700 rotate-0' : 'bg-indigo-600 hover:bg-indigo-500'
        }`}
        title="AML Network Assistant"
      >
        {open ? <ChevronDown size={18} className="text-white" /> : <MessageSquare size={18} className="text-white" />}
        {!open && history.length === 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-orange-400 border-2 border-white flex items-center justify-center text-[8px] text-white font-bold">AI</span>
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div className="fixed bottom-20 right-5 z-50 w-80 bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden"
          style={{ height: '420px' }}>
          {/* Header */}
          <div className="bg-slate-800 px-4 py-3 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center">
                <Cpu size={13} className="text-white" />
              </div>
              <div>
                <div className="text-white text-xs font-semibold">AML Assistant</div>
                <div className="text-slate-400 text-[9px]">
                  {amlCase ? `Analyzing ${amlCase.customerName}` : 'No case selected'}
                </div>
              </div>
            </div>
            <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-white transition-colors">
              <X size={14} />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-slate-50">
            {history.length === 0 && (
              <div className="text-center py-4">
                <div className="text-slate-400 text-xs mb-3">Ask me anything about this network</div>
                {['What is the risk score?', 'Explain the circular flow', 'Should I file a SAR?'].map(q => (
                  <button
                    key={q}
                    onClick={() => { setInput(q); setTimeout(() => inputRef.current?.focus(), 50); }}
                    className="block w-full text-left text-[11px] bg-white border border-gray-200 rounded-lg px-3 py-2 mb-1.5 text-slate-600 hover:bg-indigo-50 hover:border-indigo-200 transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}

            {history.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center flex-shrink-0 mr-1.5 mt-0.5">
                    <Cpu size={10} className="text-white" />
                  </div>
                )}
                <div className={`max-w-[85%] rounded-xl px-3 py-2 text-[11px] leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white rounded-tr-sm'
                    : 'bg-white border border-gray-200 text-slate-700 rounded-tl-sm'
                }`}>
                  <p>{renderContent(msg.content)}</p>
                  <div className={`text-[9px] mt-1 ${msg.role === 'user' ? 'text-indigo-200' : 'text-gray-400'}`}>
                    {formatTime(msg.timestamp)}
                  </div>
                </div>
              </div>
            ))}

            {typing && (
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center flex-shrink-0">
                  <Cpu size={10} className="text-white" />
                </div>
                <div className="bg-white border border-gray-200 rounded-xl rounded-tl-sm px-3 py-2 flex gap-1">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"
                      style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-2.5 border-t border-gray-100 bg-white flex items-center gap-2 flex-shrink-0">
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
              placeholder={amlCase ? 'Ask about the network…' : 'Select a case first…'}
              disabled={!amlCase}
              className="flex-1 text-xs outline-none placeholder:text-gray-400 bg-transparent disabled:opacity-50"
            />
            <button
              onClick={send}
              disabled={!input.trim() || !amlCase}
              className="w-7 h-7 rounded-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 flex items-center justify-center transition-colors flex-shrink-0"
            >
              <Send size={12} className="text-white" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
