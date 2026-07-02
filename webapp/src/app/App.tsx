import { useState, useCallback } from 'react';
import { LoginPage } from './components/LoginPage';
import { Header } from './components/Header';
import { NetworkGraph } from './components/NetworkGraph';
import { RiskPanel } from './components/RiskPanel';
import { ChatWindow } from './components/ChatWindow';
import { AMLCase } from './data/cases';
import { fetchCase, fetchCaseGraph, Duration } from './data/api';
import { contractToAMLCase, graphToViewModel } from './data/adapter';
import {
  CaseProgress,
  loadCaseProgress,
  saveCaseProgress,
  defaultProgress,
  addFinding,
  saveUser,
  loadUser,
  ChatMessage,
} from './hooks/useCaseStorage';

interface AuthState {
  userId: string;
  userName: string;
  userRole: string;
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(() => {
    const saved = loadUser();
    return saved ? { userId: saved, userName: `Analyst ${saved}`, userRole: 'AML Analyst' } : null;
  });

  const [selectedCase, setSelectedCase] = useState<AMLCase | null>(null);
  // The case id the analyst picked — tracked separately from the resolved case so
  // the header dropdown keeps showing the selection WHILE the case is loading
  // (selectedCase is briefly null during the fetch so the panels reset).
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [progress, setProgress] = useState<CaseProgress | null>(null);
  const [loadingCase, setLoadingCase] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Risk-factor isolation: which pattern's subgraph the graph should isolate
  // (set from the RiskPanel cards). null = show the whole network.
  const [isolateCategory, setIsolateCategory] = useState<string | null>(null);
  // Graph time-window (duration dropdown). 12m = full network. Owned here because
  // narrowing it refetches a windowed graph from the backend (view-only — the
  // score/recommendation are unaffected).
  const [duration, setDuration] = useState<Duration>('12m');
  const [graphLoading, setGraphLoading] = useState(false);

  const handleLogin = (userId: string, name: string, role: string) => {
    saveUser(userId);
    setAuth({ userId, userName: name, userRole: role });
  };

  const handleLogout = () => {
    setAuth(null);
    setSelectedCase(null);
    setSelectedCaseId(null);
    setProgress(null);
  };

  const handleCaseSelect = useCallback(async (c: AMLCase) => {
    setLoadError(null);
    setIsolateCategory(null); // clear any prior isolation when switching cases
    setDuration('12m');       // every case opens on the full window
    setSelectedCaseId(c.id);  // keep the dropdown on the picked case while it loads
    // Reset every view immediately so nothing from the previous case lingers:
    // the network canvas shows the "Analyzing the data" banner, and the risk
    // score / factors / recommendation / trail panels show a working indicator
    // (amlCase + progress = null + loadingCase) until the new case resolves.
    setSelectedCase(null);
    setProgress(null);
    setLoadingCase(true);

    // Only the live case fetches the real backend contract; demo stubs render
    // their static mock data as-is (visibly demo).
    let resolved = c;
    if (c.isLive) {
      try {
        resolved = contractToAMLCase(await fetchCase(c.id));
      } catch (err) {
        setLoadError(
          `Could not load the live case (${(err as Error).message}). ` +
          `Is the backend running and Neo4j reachable?`,
        );
        setLoadingCase(false);
        return; // leave the view reset (banner clears; empty state shows the error)
      }
    }
    setLoadingCase(false);

    setSelectedCase(resolved);

    const saved = loadCaseProgress(resolved.id);
    if (saved) {
      // Resume — add a resume entry
      const resumed = addFinding(saved, 'case_resumed', `Case resumed by ${auth?.userName ?? 'analyst'}.`);
      setProgress(resumed);
      saveCaseProgress(resumed);
    } else {
      const fresh = defaultProgress(resolved.id);
      setProgress(fresh);
      saveCaseProgress(fresh);
    }
  }, [auth]);

  // Duration dropdown: refetch a windowed graph and swap in just the nodes/edges
  // (the score/recommendation/risk factors are the full-case assessment and don't
  // change with the view window). Only the live case talks to the backend.
  const handleDurationChange = useCallback(async (w: Duration) => {
    setDuration(w);
    if (!selectedCase || !selectedCase.isLive || !selectedCase.subjectId) return;
    const { id, subjectId } = selectedCase;
    setGraphLoading(true);
    try {
      const g = await fetchCaseGraph(id, w);
      const { nodes, edges } = graphToViewModel(g, subjectId);
      setSelectedCase((cur) => (cur && cur.id === id ? { ...cur, nodes, edges } : cur));
    } catch (err) {
      setLoadError(`Could not load the ${w} window (${(err as Error).message}).`);
    } finally {
      setGraphLoading(false);
    }
  }, [selectedCase]);

  const handleProgressChange = useCallback((p: CaseProgress) => {
    setProgress(p);
    saveCaseProgress(p);
  }, []);

  const handleChatMessages = useCallback((msgs: ChatMessage[]) => {
    if (!progress) return;
    const next = { ...progress, chatHistory: msgs };
    setProgress(next);
    saveCaseProgress(next);
  }, [progress]);

  if (!auth) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50 overflow-hidden">
      <Header
        userId={auth.userId}
        userName={auth.userName}
        userRole={auth.userRole}
        selectedCaseId={selectedCaseId}
        onCaseSelect={handleCaseSelect}
        onLogout={handleLogout}
      />

      <div className="flex flex-1 overflow-hidden">
        {loadingCase ? (
          // Case switching: the network canvas shows the analysing banner (white
          // background, red letters) while the panels beside it sit blank/reset.
          <div className="flex-1 flex items-center justify-center bg-white">
            <div className="text-red-600 text-2xl font-semibold tracking-wide animate-pulse">
              Analyzing the data
            </div>
          </div>
        ) : selectedCase ? (
          <NetworkGraph
            key={selectedCase.id}
            caseId={selectedCase.id}
            isLive={!!selectedCase.isLive}
            subjectId={selectedCase.subjectId}
            initialNodes={selectedCase.nodes}
            edges={selectedCase.edges}
            isolateCategory={isolateCategory}
            duration={duration}
            onDurationChange={handleDurationChange}
            graphLoading={graphLoading}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center bg-[#e8eaed]">
            <div className="text-center max-w-sm px-6">
              <div className="w-16 h-16 rounded-2xl bg-white/70 border border-gray-200 flex items-center justify-center mx-auto mb-4 shadow-sm">
                <div className="w-7 h-7 border-2 border-slate-300 rounded" />
              </div>
              <p className="text-slate-500 text-sm font-medium mb-1">No network loaded</p>
              <p className="text-slate-400 text-xs">Select an alerted customer from the dropdown above</p>
              {loadError && (
                <p className="text-red-500 text-xs mt-3 leading-relaxed">{loadError}</p>
              )}
            </div>
          </div>
        )}

        <RiskPanel
          amlCase={selectedCase}
          progress={progress}
          loading={loadingCase}
          decidedBy={auth.userId}
          isolatedCategory={isolateCategory}
          onIsolate={(cat) => setIsolateCategory(prev => (prev === cat ? null : cat))}
          onProgressChange={handleProgressChange}
        />
      </div>

      <ChatWindow
        amlCase={selectedCase}
        history={progress?.chatHistory ?? []}
        onNewMessages={handleChatMessages}
      />
    </div>
  );
}
