// Fetch layer for the A_NIRE backend. Same-origin in production (FastAPI serves
// this build); in dev, vite proxies /api -> :8000 (see vite.config.ts). These
// types mirror the backend contract exactly; adapter.ts maps them to the
// AMLCase view-model the components consume.

export interface ContractNode {
  id: string;
  label: string;
  type: string;
  jurisdiction: string;
  kyc_status: string;
  role: string;
  flags: { subject: boolean; sanctioned: boolean; shell: boolean };
}

export interface ContractEdge {
  id: string;
  source: string;
  target: string;
  amount_gbp: number;
  txn_date: string;
  channel: string;
  pattern: string | null;
}

export interface Detector {
  key: string;
  name: string;
  fired: boolean;
  contribution: number;
  entities: string[];
  txns: string[];
  explanation: string;
}

export interface CaseContract {
  case: {
    case_id: string;
    subject_entity_id: string;
    trigger_code: string;
    trigger_desc: string;
    created_at: string;
    subject_name: string;
  };
  graph: { nodes: ContractNode[]; edges: ContractEdge[] };
  detectors: Detector[];
  score: { total: number; band: string; bands: { sar: number; edd: number }; engine: string };
  recommendation: {
    action: string;
    headline: string;
    rationale: string;
    rationale_source: string;
    model: string | null;
  };
  sources: { key: string; label: string; count: number; detail: string }[];
}

export interface RiskyPath {
  counterparty: string;
  direction: 'debit' | 'credit';
  reason: string;
  txn_ids: string[];
  amount: number;
  currency: string;
  contribution_pct: number;
}

export interface EntityDetail {
  entity_id: string;
  kyc: {
    entity_id: string;
    name: string;
    entity_type: string;
    jurisdiction: string;
    incorporation_year: number | null;
    kyc_status: string;
    registered_address: string | null;
  };
  worldcheck: {
    entity_id: string;
    source: string;
    list_name: string;
    category: string;
    match_strength: number;
    hit_date: string;
    screened_name: string;
  } | null;
  risky_paths: RiskyPath[];
}

export interface ModelsInfo {
  provider: string;
  ready: boolean;
  default: string | null;
  current: string | null;
  models: string[];
}

export interface DecisionRow {
  id: number;
  case_id: string;
  action: string;
  decided_by: string;
  notes: string;
  score_total: number;
  band: string;
  rationale_source: string;
  scoring_engine: string | null;
  created_at: string;
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.json() as Promise<T>;
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return r.json() as Promise<T>;
}

export const fetchCase = (id: string) => getJSON<CaseContract>(`/api/case/${id}`);
export const fetchModels = () => getJSON<ModelsInfo>('/api/models');
export const fetchEntity = (id: string, entityId: string) =>
  getJSON<EntityDetail>(`/api/case/${id}/entity/${entityId}`);

export const postDecision = (
  id: string,
  body: { action: string; decided_by?: string; notes?: string },
) => postJSON<{ decision: DecisionRow; audit: unknown }>(`/api/case/${id}/decision`, body);

export const regenerateRationale = (id: string, model: string) =>
  postJSON<{ model: string; rationale: string; rationale_source: string }>(
    `/api/case/${id}/rationale`,
    { model },
  );
