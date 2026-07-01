export type CaseStatus = 'ongoing' | 'closed' | 'not_started';
export type RiskLevel = 'high' | 'medium' | 'low' | 'none';
export type NodeType = 'main' | 'entity' | 'shell' | 'sanctioned';
// 'shell' added so shell-linkage flows get their own colour (the backend fires
// three detector patterns, not two).
export type EdgeCategory = 'circular' | 'sanctioned' | 'shell' | 'normal';
export type RiskCategory = 'circular' | 'sanctioned' | 'shell';

export interface GraphNode {
  id: string;
  label: string;
  sublabel?: string;
  x: number;
  y: number;
  radius: number;
  type: NodeType;
  risk: RiskLevel;
  // Entity metadata for the hover overview (populated for the live case).
  jurisdiction?: string;
  kycStatus?: string;
  role?: string;
  sanctioned?: boolean;
  shell?: boolean;
  subject?: boolean;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  amount: string;
  amountValue: number; // raw money value — used for the contribution % slider
  suspicious: boolean;
  category: EdgeCategory;
  txns?: number;       // how many transactions this arc aggregates (live data)
}

export interface RiskFactor {
  name: string;
  detectors: number;
  ai: number;
  category: RiskCategory;
  detail: string;
  contribution?: number; // rule-based weight, e.g. 0.30 (live data; replaces "ai")
}

// Source-integration badge (World-Check / TM / KYC / Watchlist).
export interface SourceBadge {
  key: string;
  label: string;
  count: number;
  detail: string;
}

export interface AMLCase {
  id: string;
  customerName: string;
  status: CaseStatus;
  riskScore: number;
  entityFull: string;
  triggerTags: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  riskFactors: RiskFactor[];
  sarSummary: string;

  // ── Live-contract fields (populated by the adapter for the one real case;
  //    undefined for the static demo stubs). These let the UI show the real
  //    deterministic bands/recommendation instead of the Figma mock assumptions.
  isLive?: boolean;
  subjectId?: string;                       // e.g. E001 — for entity-detail calls
  currency?: string;                        // 'GBP'
  band?: 'SAR' | 'EDD' | 'CLEAR';           // deterministic band from score.bands
  bands?: { sar: number; edd: number };     // real thresholds (0.65 / 0.35)
  engine?: string;                          // scoring engine name
  action?: string;                          // recommendation.action
  headline?: string;                        // recommendation.headline
  rationale?: string;                       // LLM/deterministic rationale text
  rationaleSource?: string;                 // 'anthropic' | 'placeholder' | ...
  model?: string | null;                    // model behind the rationale
  sources?: SourceBadge[];                  // source-integration badges
}

// ── Case 1: Transcend Commerce Ltd ──────────────────────────────────────────

const case1Nodes: GraphNode[] = [
  { id: 'main',     label: 'Transcend',  sublabel: 'Commerce Ltd', x: 330, y: 210, radius: 34, type: 'main',       risk: 'high'   },
  { id: 'veltex',   label: 'E0027',      sublabel: 'Veltex Hold.', x: 150, y: 115, radius: 26, type: 'entity',     risk: 'high'   },
  { id: 'algren',   label: 'E0028',      sublabel: 'Algren Corp',  x: 500, y: 100, radius: 22, type: 'entity',     risk: 'medium' },
  { id: 'mira',     label: 'E0031',      sublabel: 'Mira Invest',  x: 570, y: 250, radius: 20, type: 'entity',     risk: 'medium' },
  { id: 'offshore', label: 'Shell A',    sublabel: 'Offshore Ltd', x: 155, y: 340, radius: 24, type: 'shell',      risk: 'high'   },
  { id: 'meridian', label: 'Meridian',   sublabel: 'OFAC Listed',  x: 340, y: 390, radius: 23, type: 'sanctioned', risk: 'high'   },
  { id: 'praxis',   label: 'E0035',      sublabel: 'Praxis Cap.',  x: 540, y: 370, radius: 18, type: 'entity',     risk: 'low'    },
  { id: 'fenwick',  label: 'E0042',      sublabel: 'Fenwick LLC',  x: 55,  y: 230, radius: 18, type: 'entity',     risk: 'low'    },
  { id: 'nautix',   label: 'E0019',      sublabel: 'Nautix Group', x: 260, y: 90,  radius: 20, type: 'entity',     risk: 'medium' },
  { id: 'creston',  label: 'E0055',      sublabel: 'Creston Ltd',  x: 460, y: 300, radius: 17, type: 'entity',     risk: 'low'    },
];

const case1Edges: GraphEdge[] = [
  { id: 'e1',  from: 'veltex',   to: 'main',      amount: '$2.4M',  amountValue: 2400, suspicious: true,  category: 'circular'   },
  { id: 'e2',  from: 'main',     to: 'offshore',  amount: '$1.8M',  amountValue: 1800, suspicious: true,  category: 'circular'   },
  { id: 'e3',  from: 'offshore', to: 'veltex',    amount: '$1.7M',  amountValue: 1700, suspicious: true,  category: 'circular'   },
  { id: 'e4',  from: 'algren',   to: 'main',      amount: '$890K',  amountValue: 890,  suspicious: false, category: 'normal'     },
  { id: 'e5',  from: 'main',     to: 'meridian',  amount: '$340K',  amountValue: 340,  suspicious: true,  category: 'sanctioned' },
  { id: 'e6',  from: 'meridian', to: 'algren',    amount: '$280K',  amountValue: 280,  suspicious: true,  category: 'sanctioned' },
  { id: 'e7',  from: 'mira',     to: 'main',      amount: '$1.1M',  amountValue: 1100, suspicious: false, category: 'normal'     },
  { id: 'e8',  from: 'main',     to: 'praxis',    amount: '$560K',  amountValue: 560,  suspicious: false, category: 'normal'     },
  { id: 'e9',  from: 'fenwick',  to: 'veltex',    amount: '$200K',  amountValue: 200,  suspicious: false, category: 'normal'     },
  { id: 'e10', from: 'nautix',   to: 'main',      amount: '$450K',  amountValue: 450,  suspicious: false, category: 'normal'     },
  { id: 'e11', from: 'offshore', to: 'meridian',  amount: '$120K',  amountValue: 120,  suspicious: true,  category: 'circular'   },
  { id: 'e12', from: 'creston',  to: 'mira',      amount: '$310K',  amountValue: 310,  suspicious: false, category: 'normal'     },
];

// ── Case 2: Algren Corporation ────────────────────────────────────────────

const case2Nodes: GraphNode[] = [
  { id: 'main',    label: 'Algren',    sublabel: 'Corporation',   x: 350, y: 210, radius: 34, type: 'main',       risk: 'high'   },
  { id: 'rexmore', label: 'E0012',     sublabel: 'Rexmore Ltd',   x: 160, y: 105, radius: 26, type: 'entity',     risk: 'high'   },
  { id: 'callisto',label: 'E0016',     sublabel: 'Callisto Inc',  x: 520, y: 95,  radius: 22, type: 'entity',     risk: 'high'   },
  { id: 'shellx',  label: 'Shell X',   sublabel: 'Intl Offshore', x: 570, y: 250, radius: 24, type: 'shell',      risk: 'high'   },
  { id: 'shelly',  label: 'Shell Y',   sublabel: 'BVI Holdings',  x: 170, y: 350, radius: 24, type: 'shell',      risk: 'high'   },
  { id: 'sancta',  label: 'Listed A',  sublabel: 'UN Sanctioned', x: 90,  y: 230, radius: 22, type: 'sanctioned', risk: 'high'   },
  { id: 'nordex',  label: 'E0044',     sublabel: 'Nordex Cap.',   x: 360, y: 390, radius: 20, type: 'entity',     risk: 'medium' },
  { id: 'braven',  label: 'E0051',     sublabel: 'Braven LLC',    x: 490, y: 355, radius: 17, type: 'entity',     risk: 'low'    },
  { id: 'gantry',  label: 'E0007',     sublabel: 'Gantry Group',  x: 290, y: 95,  radius: 19, type: 'entity',     risk: 'medium' },
];

const case2Edges: GraphEdge[] = [
  { id: 'e1', from: 'rexmore',  to: 'main',     amount: '$3.2M',  amountValue: 3200, suspicious: true,  category: 'circular'   },
  { id: 'e2', from: 'main',     to: 'callisto', amount: '$2.9M',  amountValue: 2900, suspicious: true,  category: 'circular'   },
  { id: 'e3', from: 'callisto', to: 'shellx',   amount: '$2.7M',  amountValue: 2700, suspicious: true,  category: 'circular'   },
  { id: 'e4', from: 'shellx',   to: 'shelly',   amount: '$2.5M',  amountValue: 2500, suspicious: true,  category: 'circular'   },
  { id: 'e5', from: 'shelly',   to: 'rexmore',  amount: '$2.3M',  amountValue: 2300, suspicious: true,  category: 'circular'   },
  { id: 'e6', from: 'main',     to: 'sancta',   amount: '$490K',  amountValue: 490,  suspicious: true,  category: 'sanctioned' },
  { id: 'e7', from: 'sancta',   to: 'rexmore',  amount: '$410K',  amountValue: 410,  suspicious: true,  category: 'sanctioned' },
  { id: 'e8', from: 'nordex',   to: 'main',     amount: '$1.1M',  amountValue: 1100, suspicious: false, category: 'normal'     },
  { id: 'e9', from: 'main',     to: 'braven',   amount: '$640K',  amountValue: 640,  suspicious: false, category: 'normal'     },
  { id: 'e10',from: 'gantry',   to: 'main',     amount: '$760K',  amountValue: 760,  suspicious: false, category: 'normal'     },
];

// ── Case 3: Praxis Capital Group ──────────────────────────────────────────

const case3Nodes: GraphNode[] = [
  { id: 'main',   label: 'Praxis',   sublabel: 'Capital Group', x: 355, y: 195, radius: 32, type: 'main',   risk: 'high'   },
  { id: 'sha',    label: 'Alpha',    sublabel: 'Offshore Ltd',  x: 150, y: 95,  radius: 22, type: 'shell',  risk: 'high'   },
  { id: 'shb',    label: 'Beta',     sublabel: 'BVI Holdings',  x: 510, y: 100, radius: 22, type: 'shell',  risk: 'high'   },
  { id: 'shc',    label: 'Gamma',    sublabel: 'Cayman Trust',  x: 570, y: 275, radius: 22, type: 'shell',  risk: 'high'   },
  { id: 'shd',    label: 'Delta',    sublabel: 'IOM Register',  x: 160, y: 355, radius: 22, type: 'shell',  risk: 'high'   },
  { id: 'norval', label: 'E0066',    sublabel: 'Norval Corp',   x: 355, y: 385, radius: 22, type: 'entity', risk: 'medium' },
  { id: 'fenw',   label: 'E0042',    sublabel: 'Fenwick LLC',   x: 65,  y: 215, radius: 18, type: 'entity', risk: 'low'    },
  { id: 'solvex', label: 'E0071',    sublabel: 'Solvex Inc',    x: 575, y: 380, radius: 17, type: 'entity', risk: 'low'    },
];

const case3Edges: GraphEdge[] = [
  { id: 'e1', from: 'main',  to: 'sha',   amount: '$480K', amountValue: 480, suspicious: true,  category: 'circular' },
  { id: 'e2', from: 'main',  to: 'shb',   amount: '$520K', amountValue: 520, suspicious: true,  category: 'circular' },
  { id: 'e3', from: 'main',  to: 'shc',   amount: '$490K', amountValue: 490, suspicious: true,  category: 'circular' },
  { id: 'e4', from: 'main',  to: 'shd',   amount: '$460K', amountValue: 460, suspicious: true,  category: 'circular' },
  { id: 'e5', from: 'sha',   to: 'norval',amount: '$430K', amountValue: 430, suspicious: true,  category: 'circular' },
  { id: 'e6', from: 'shb',   to: 'norval',amount: '$470K', amountValue: 470, suspicious: true,  category: 'circular' },
  { id: 'e7', from: 'shc',   to: 'norval',amount: '$440K', amountValue: 440, suspicious: true,  category: 'circular' },
  { id: 'e8', from: 'shd',   to: 'norval',amount: '$410K', amountValue: 410, suspicious: true,  category: 'circular' },
  { id: 'e9', from: 'fenw',  to: 'main',  amount: '$1.8M', amountValue: 1800,suspicious: false, category: 'normal'   },
  { id: 'e10',from: 'main',  to: 'solvex',amount: '$290K', amountValue: 290, suspicious: false, category: 'normal'   },
];

// ── Case 4: Meridian Trade Co (closed) ────────────────────────────────────

const case4Nodes: GraphNode[] = [
  { id: 'main',    label: 'Meridian',  sublabel: 'Trade Co',      x: 330, y: 210, radius: 30, type: 'main',   risk: 'medium' },
  { id: 'elyxon',  label: 'E0009',     sublabel: 'Elyxon Corp',   x: 160, y: 110, radius: 22, type: 'entity', risk: 'medium' },
  { id: 'shelf',   label: 'Shelf A',   sublabel: 'Shelf Co',      x: 490, y: 110, radius: 22, type: 'shell',  risk: 'medium' },
  { id: 'tranton', label: 'E0013',     sublabel: 'Tranton Part.', x: 545, y: 260, radius: 20, type: 'entity', risk: 'low'    },
  { id: 'supplier',label: 'E0017',     sublabel: 'Global Supply', x: 165, y: 330, radius: 20, type: 'entity', risk: 'low'    },
  { id: 'finance', label: 'E0022',     sublabel: 'Zara Finance',  x: 350, y: 380, radius: 18, type: 'entity', risk: 'low'    },
  { id: 'consult', label: 'E0031',     sublabel: 'Consult BV',    x: 70,  y: 230, radius: 17, type: 'entity', risk: 'low'    },
];

const case4Edges: GraphEdge[] = [
  { id: 'e1', from: 'elyxon',  to: 'main',    amount: '$890K', amountValue: 890, suspicious: false, category: 'normal'   },
  { id: 'e2', from: 'main',    to: 'shelf',   amount: '$780K', amountValue: 780, suspicious: false, category: 'normal'   },
  { id: 'e3', from: 'shelf',   to: 'elyxon',  amount: '$720K', amountValue: 720, suspicious: false, category: 'normal'   },
  { id: 'e4', from: 'tranton', to: 'main',    amount: '$1.1M', amountValue: 1100,suspicious: false, category: 'normal'   },
  { id: 'e5', from: 'supplier',to: 'main',    amount: '$640K', amountValue: 640, suspicious: false, category: 'normal'   },
  { id: 'e6', from: 'main',    to: 'finance', amount: '$450K', amountValue: 450, suspicious: false, category: 'normal'   },
  { id: 'e7', from: 'consult', to: 'main',    amount: '$330K', amountValue: 330, suspicious: false, category: 'normal'   },
];

// ── Case 5: Veltex Holdings ───────────────────────────────────────────────

const case5Nodes: GraphNode[] = [
  { id: 'main',   label: 'Veltex',    sublabel: 'Holdings LLC',  x: 340, y: 210, radius: 32, type: 'main',       risk: 'high'   },
  { id: 'castra', label: 'E0003',     sublabel: 'Castra Corp',   x: 155, y: 105, radius: 22, type: 'entity',     risk: 'medium' },
  { id: 'darien', label: 'E0011',     sublabel: 'Darien Ltd',    x: 510, y: 100, radius: 22, type: 'entity',     risk: 'medium' },
  { id: 'listedB',label: 'Listed B',  sublabel: 'OFAC SDN',      x: 570, y: 255, radius: 22, type: 'sanctioned', risk: 'high'   },
  { id: 'nova',   label: 'Nova',      sublabel: 'Offshore Ltd',  x: 160, y: 350, radius: 22, type: 'shell',      risk: 'high'   },
  { id: 'apex',   label: 'E0048',     sublabel: 'Apex Traders',  x: 350, y: 385, radius: 20, type: 'entity',     risk: 'medium' },
  { id: 'maxima', label: 'E0059',     sublabel: 'Maxima Inc',    x: 65,  y: 225, radius: 18, type: 'entity',     risk: 'low'    },
  { id: 'stellar',label: 'E0062',     sublabel: 'Stellar Group', x: 535, y: 365, radius: 17, type: 'entity',     risk: 'low'    },
];

const case5Edges: GraphEdge[] = [
  { id: 'e1', from: 'castra',  to: 'main',   amount: '$1.5M', amountValue: 1500, suspicious: false, category: 'normal'     },
  { id: 'e2', from: 'main',    to: 'darien', amount: '$1.2M', amountValue: 1200, suspicious: false, category: 'normal'     },
  { id: 'e3', from: 'darien',  to: 'listedB',amount: '$380K', amountValue: 380,  suspicious: true,  category: 'sanctioned' },
  { id: 'e4', from: 'listedB', to: 'nova',   amount: '$320K', amountValue: 320,  suspicious: true,  category: 'sanctioned' },
  { id: 'e5', from: 'nova',    to: 'main',   amount: '$290K', amountValue: 290,  suspicious: true,  category: 'circular'   },
  { id: 'e6', from: 'maxima',  to: 'main',   amount: '$780K', amountValue: 780,  suspicious: false, category: 'normal'     },
  { id: 'e7', from: 'main',    to: 'apex',   amount: '$560K', amountValue: 560,  suspicious: false, category: 'normal'     },
  { id: 'e8', from: 'main',    to: 'stellar',amount: '$340K', amountValue: 340,  suspicious: false, category: 'normal'     },
  { id: 'e9', from: 'apex',    to: 'castra', amount: '$480K', amountValue: 480,  suspicious: false, category: 'normal'     },
];

// ── Case catalogue ────────────────────────────────────────────────────────

// The LIVE case id — only this one fetches the real backend contract (the rest
// of the catalogue are visibly demo stubs). Must match cases.csv / app.py.
export const LIVE_CASE_ID = 'CASE-2026-0001';

export const CASES: AMLCase[] = [
  {
    // Live stub: shown in the dropdown; App fetches + adapts the real contract on
    // select. nodes/edges/factors are filled at runtime, so they start empty.
    id: LIVE_CASE_ID,
    customerName: 'Tradewind Commerce Ltd',
    status: 'ongoing',
    riskScore: 0.74,
    entityFull: 'Tradewind Commerce Ltd',
    triggerTags: ['Live data', 'Circular flow', 'Sanctioned exposure'],
    nodes: [],
    edges: [],
    riskFactors: [],
    sarSummary: '',
    isLive: true,
  },
  {
    id: 'CASE-234-0001',
    customerName: 'Transcend Commerce Ltd',
    status: 'ongoing',
    riskScore: 0.74,
    entityFull: 'Transcend Commerce Ltd',
    triggerTags: ['High value', 'Sanctioned exposure', 'Jurisdiction risk'],
    nodes: case1Nodes,
    edges: case1Edges,
    riskFactors: [
      { name: 'Circular flow',       detectors: 3, ai: 10, category: 'circular',   detail: 'Three-hop cycle: E0027 → Transcend → Shell A → E0027. Aggregate value $5.9M over 28 days.' },
      { name: 'Sanctioned exposure', detectors: 2, ai: 12, category: 'sanctioned', detail: 'Direct link to Meridian Co (OFAC SDN #23441). Two-hop path via E0028 to Prime China network.' },
      { name: 'Shell linkage',       detectors: 2, ai: 10, category: 'shell',       detail: 'Shell A (Offshore Ltd) shows zero employees, nominee directors, and nil-revenue filing.' },
    ],
    sarSummary: `Filing a SAR for Transcend Commerce Ltd is triggered by a risk score of 0.74, exceeding the 0.50 threshold, with three active detector categories. The circular flow detector identifies a cyclic pattern (E0027 → Transcend → Shell A → E0027, $5.9M over 28 days). The sanctioned exposure detector confirms a direct link to Meridian Co (OFAC SDN #23441) via E0028. Shell A exhibits nominee directors and zero-revenue filing consistent with a layering vehicle. Source integration across World-Check, Refinitiv, and ComplyAdvantage confirms all findings. Overall conclusion: suspicious.`,
  },
  {
    id: 'CASE-234-0002',
    customerName: 'Algren Corporation',
    status: 'ongoing',
    riskScore: 0.88,
    entityFull: 'Algren Corporation',
    triggerTags: ['Circular flow', 'UN Sanctioned', 'Multi-shell relay'],
    nodes: case2Nodes,
    edges: case2Edges,
    riskFactors: [
      { name: 'Circular flow',       detectors: 4, ai: 15, category: 'circular',   detail: 'Five-hop relay: Rexmore → Algren → Callisto → Shell X → Shell Y → Rexmore. Value $13.6M over 19 days.' },
      { name: 'Sanctioned exposure', detectors: 3, ai: 8,  category: 'sanctioned', detail: 'Direct and one-hop exposure to UN-listed party (Listed A). $490K direct transfer identified.' },
      { name: 'Shell linkage',       detectors: 3, ai: 12, category: 'shell',       detail: 'Two shells (X, Y) with matching registered agents; strong nominee director overlap.' },
    ],
    sarSummary: `Algren Corporation presents the highest risk profile in the current queue (0.88). A five-hop circular relay cycling $13.6M through two offshore shells is the primary driver. Direct and indirect links to a UN-sanctioned counterparty compound the concern. Immediate SAR filing is recommended without further delay.`,
  },
  {
    id: 'CASE-234-0003',
    customerName: 'Praxis Capital Group',
    status: 'not_started',
    riskScore: 0.61,
    entityFull: 'Praxis Capital Group',
    triggerTags: ['Smurfing pattern', 'Shell fan-out', 'Layering'],
    nodes: case3Nodes,
    edges: case3Edges,
    riskFactors: [
      { name: 'Shell linkage',  detectors: 2, ai: 10, category: 'shell',    detail: 'Four shells (Alpha, Beta, Gamma, Delta) receive near-identical amounts from Praxis and funnel into Norval Corp — classic smurfing.' },
      { name: 'Circular flow',  detectors: 1, ai: 8,  category: 'circular', detail: 'Layering detected: Praxis → shells → Norval creates a fan-in that obscures the original source.' },
    ],
    sarSummary: `Praxis Capital Group (risk 0.61) shows a structured smurfing pattern: four shell companies in different jurisdictions (BVI, Cayman, IOM, Offshore) each receive amounts just below reporting thresholds from Praxis, then consolidate into Norval Corp. This layering structure is a textbook SAR trigger even at moderate risk scores.`,
  },
  {
    id: 'CASE-234-0004',
    customerName: 'Meridian Trade Co',
    status: 'closed',
    riskScore: 0.43,
    entityFull: 'Meridian Trade Co',
    triggerTags: ['Shell linkage', 'Resolved'],
    nodes: case4Nodes,
    edges: case4Edges,
    riskFactors: [
      { name: 'Shell linkage', detectors: 1, ai: 6, category: 'shell', detail: 'Shelf Co A was identified as a shelf company, later confirmed as a legitimate SPV used for a trade finance facility. Cleared after documentation review.' },
    ],
    sarSummary: `Meridian Trade Co was flagged for a shell linkage (Shelf Co A). After documentary review, Shelf Co A was confirmed as a legitimate SPV for a trade finance facility with Tranton Partners. The apparent circular flow (Elyxon → Meridian → Shelf → Elyxon) reflects normal letter-of-credit mechanics. Case closed — no SAR required.`,
  },
  {
    id: 'CASE-234-0005',
    customerName: 'Veltex Holdings LLC',
    status: 'not_started',
    riskScore: 0.55,
    entityFull: 'Veltex Holdings LLC',
    triggerTags: ['Sanctioned exposure', 'Shell linkage', 'Two-hop'],
    nodes: case5Nodes,
    edges: case5Edges,
    riskFactors: [
      { name: 'Sanctioned exposure', detectors: 2, ai: 10, category: 'sanctioned', detail: 'Two-hop path: Darien Ltd → Listed B (OFAC SDN) → Nova Offshore → Veltex. $320K entered via Nova Offshore.' },
      { name: 'Shell linkage',       detectors: 1, ai: 7,  category: 'shell',       detail: 'Nova Offshore Ltd is registered in a high-risk jurisdiction with no identifiable beneficial owner.' },
    ],
    sarSummary: `Veltex Holdings LLC (risk 0.55) has a two-hop exposure to an OFAC-sanctioned party through Darien Ltd and Nova Offshore. $290K entered Veltex via Nova after passing through the listed entity. Shell Nova Offshore has no traceable beneficial owner. Pending analyst review.`,
  },
];
