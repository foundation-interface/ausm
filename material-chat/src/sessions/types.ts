import type { Citation, RetrievalHit, RetrievalPlan } from "../types.js";

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  plan?: RetrievalPlan;
  hits?: RetrievalHit[];
  citations?: Citation[];
  error?: string;
  createdAt: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export type SessionStore = Record<string, Session>;
