export type DataSource = "live" | "cache" | "fallback";

export interface Member {
  name: string;
  loves: string[];
}

export interface TasteEntity {
  id: string;
  name: string;
  type: string;
  tags: string[];
  image?: string;
  description?: string;
}

export interface ResolvedMember {
  name: string;
  entities: TasteEntity[];
  unresolved: string[];
}

export interface Place {
  id: string;
  name: string;
  address?: string;
  rating?: number;
  priceLevel?: number;
  affinity: number;
  tags: string[];
  image?: string;
  description?: string;
  lat?: number;
  lon?: number;
}

export type CategoryKey = "dining" | "coffee" | "culture" | "nightlife";

export interface ScoredPlace extends Place {
  category: CategoryKey;
  groupScore: number;
  fairness: number;
  memberFit: Record<string, { score: number; reasons: string[] }>;
}

export interface PlanPick {
  category: CategoryKey;
  place: ScoredPlace;
  why: string;
  perMember: Record<string, string>;
  status?: "new" | "kept" | "changed";
}

export interface Plan {
  title: string;
  summary: string;
  city: string;
  sharedTaste: { tag: string; members: string[] }[];
  picks: PlanPick[];
  alternatives: Partial<Record<CategoryKey, ScoredPlace[]>>;
}

export interface PlanRequest {
  city: string;
  occasion: string;
  members: Member[];
  categories: CategoryKey[];
  previousPickIds?: string[];
  changeNote?: string;
}

export type AgentEvent =
  | { type: "status"; qloo: string; llm: string }
  | { type: "step"; id: number; tool: string; label: string; detail?: string; source?: DataSource; ms?: number }
  | { type: "thought"; text: string }
  | { type: "plan"; plan: Plan }
  | { type: "generic"; text: string; source: "llm" | "static" }
  | { type: "error"; message: string }
  | { type: "done"; ms: number; mode: "llm" | "deterministic"; qlooCalls: Record<DataSource, number>; llmTurns?: number; model?: string };
