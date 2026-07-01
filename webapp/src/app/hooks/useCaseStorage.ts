import { useCallback } from 'react';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface FindingEntry {
  timestamp: string;
  type: 'note' | 'decision' | 'chat' | 'case_opened' | 'case_resumed';
  content: string;
}

export interface CaseProgress {
  caseId: string;
  notes: string;
  decision: 'pending' | 'filed' | 'cleared' | 'escalated';
  nodePositions: Record<string, { x: number; y: number }>;
  lastViewed: string;
  chatHistory: ChatMessage[];
  findings: FindingEntry[];
}

const STORAGE_KEY = (caseId: string) => `aml_progress_${caseId}`;
const USER_KEY = 'aml_user';

export function saveCaseProgress(progress: CaseProgress): void {
  try {
    localStorage.setItem(STORAGE_KEY(progress.caseId), JSON.stringify(progress));
  } catch {
    // localStorage unavailable — silently ignore
  }
}

export function loadCaseProgress(caseId: string): CaseProgress | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(caseId));
    return raw ? (JSON.parse(raw) as CaseProgress) : null;
  } catch {
    return null;
  }
}

export function defaultProgress(caseId: string): CaseProgress {
  return {
    caseId,
    notes: '',
    decision: 'pending',
    nodePositions: {},
    lastViewed: new Date().toISOString(),
    chatHistory: [],
    findings: [
      {
        timestamp: new Date().toISOString(),
        type: 'case_opened',
        content: `Case ${caseId} opened for review.`,
      },
    ],
  };
}

export function saveUser(userId: string): void {
  try { localStorage.setItem(USER_KEY, userId); } catch { /* */ }
}

export function loadUser(): string | null {
  try { return localStorage.getItem(USER_KEY); } catch { return null; }
}

export function addFinding(
  progress: CaseProgress,
  type: FindingEntry['type'],
  content: string,
): CaseProgress {
  const entry: FindingEntry = { timestamp: new Date().toISOString(), type, content };
  return { ...progress, findings: [...progress.findings, entry] };
}

export function exportLog(progress: CaseProgress, caseId: string): void {
  const data = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      caseId,
      decision: progress.decision,
      notes: progress.notes,
      findings: progress.findings,
      chatHistory: progress.chatHistory,
    },
    null,
    2,
  );
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${caseId}_log.json`;
  a.click();
  URL.revokeObjectURL(url);
}
