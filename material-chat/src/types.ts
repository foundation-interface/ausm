export type SourceKind = "personal" | "web";

export interface PersonalDoc {
  id: string;
  text: string;
}

export interface PersonalHit {
  kind: "personal";
  id: string;
  score: number;
  snippet: string;
  fullText: string;
  /** Display title from the source system (e.g. window title). Falls back to id when absent. */
  title?: string;
  /** Application bundle id (e.g. "com.tinyspeck.slackmacgap"). */
  application?: string;
  /** ISO datetime of most recent observation, if known. */
  lastSeen?: string;
  /** ISO datetime of first observation, if known. */
  firstSeen?: string;
  /** Importance proxy: how many distinct frames AUSM captured for this material. */
  frameCount?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebHit {
  kind: "web";
  title: string;
  url: string;
  snippet: string;
  content?: string;
}

export type RetrievalHit = PersonalHit | WebHit;

export interface RetrievalPlan {
  needPersonal: boolean;
  needWeb: boolean;
  queries: string[];
  reasoning?: string;
}

export interface PersonalRetriever {
  search(query: string, topK: number): Promise<PersonalHit[]>;
}

export interface WebProvider {
  search(query: string, topK: number): Promise<WebSearchResult[]>;
}

export interface ContentFetcher {
  fetch(url: string): Promise<string>;
}

export interface Citation {
  index: number;
  kind: SourceKind;
  ref: string;
  title: string;
  url: string;
}

export interface AnswerResult {
  question: string;
  markdown: string;
  citations: Citation[];
  hits: RetrievalHit[];
  plan: RetrievalPlan;
  timings: Record<string, number>;
}
