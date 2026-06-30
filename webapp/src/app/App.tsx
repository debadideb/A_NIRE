import { useState, useCallback } from 'react';
import { LoginPage } from './components/LoginPage';
import { Header } from './components/Header';
import { NetworkGraph } from './components/NetworkGraph';
import { RiskPanel } from './components/RiskPanel';
import { ChatWindow } from './components/ChatWindow';
import { AMLCase } from './data/cases';
import { fetchCase } from './data/api';
import { contractToAMLCase } from './data/adapter';
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
  const [progress, setProgress] = useState<CaseProgress | null>(null);
  const [loadingCase, setLoadingCase] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Risk-factor isolation: which pattern's subgraph the graph should isolate
  // (set from the RiskPanel cards). null = show the whole network.
  const [isolateCategory, setIsolateCategory] = useState<string | null>(null);

  const handleLogin = (userId: string, name: string, role: string) => {
    saveUser(userId);
    setAuth({ userId, userName: name, userRole: role });
  };

  const handleLogout = () => {
    setAuth(null);
    setSelectedCase(null);
    setProgress(null);
  };

  const handleCaseSelect = useCallback(async (c: AMLCase) => {
    setLoadError(null);
    setIsolateCategory(null); // clear any prior isolation when switching cases

    // Only the live case fetches the real backend contract; demo stubs render
    // their static mock data as-is (visibly demo).
    let resolved = c;
    if (c.isLive) {
      setLoadingCase(true);
      try {
        resolved = contractToAMLCase(await fetchCase(c.id));
      } catch (err) {
        setLoadError(
          `Could not load the live case (${(err as Error).message}). ` +
          `Is the backend running and Neo4j reachable?`,
        );
        setLoadingCase(false);
        return; // leave the prior selection untouched on failure
      }
      setLoadingCase(false);
    }

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

  const handleProgressChange = useCallback((p: CaseProgress) => {
    setProgress(p);
    saveCaseProgress(p);
  }, []);

  const handlePositionsChange = useCallback((positions: Record<string, { x: number; y: number }>) => {
    if (!progress) return;
    const next = { ...progress, nodePositions: positions };
    setProgress(next);
    saveCaseProgress(next);
  }, [progress]);

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
        selectedCaseId={selectedCase?.id ?? null}
        onCaseSelect={handleCaseSelect}
        onLogout={handleLogout}
      />

      <div className="flex flex-1 overflow-hidden">
        {selectedCase ? (
          <NetworkGraph
            key={selectedCase.id}
            caseId={selectedCase.id}
            isLive={!!selectedCase.isLive}
            initialNodes={selectedCase.nodes}
            edges={selectedCase.edges}
            savedPositions={progress?.nodePositions}
            isolateCategory={isolateCategory}
            onNodeSelect={() => {}}
            onPositionsChange={handlePositionsChange}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center bg-[#e8eaed]">
            <div className="text-center max-w-sm px-6">
              <div className="w-16 h-16 rounded-2xl bg-white/70 border border-gray-200 flex items-center justify-center mx-auto mb-4 shadow-sm">
                {loadingCase
                  ? <div className="w-6 h-6 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                  : <div className="w-7 h-7 border-2 border-slate-300 rounded" />}
              </div>
              <p className="text-slate-500 text-sm font-medium mb-1">
                {loadingCase ? 'Loading live case…' : 'No network loaded'}
              </p>
              <p className="text-slate-400 text-xs">
                {loadingCase ? 'Building the scored network from the backend' : 'Select an alerted customer from the dropdown above'}
              </p>
              {loadError && (
                <p className="text-red-500 text-xs mt-3 leading-relaxed">{loadError}</p>
              )}
            </div>
          </div>
        )}

        <RiskPanel
          amlCase={selectedCase}
          progress={progress}
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
