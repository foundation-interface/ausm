import type { LLM, LLMMessage } from "../llm/index.js";
import type { RetrievalPlan } from "../types.js";
import { config } from "../config.js";
import { loadPrompt } from "./prompts.js";
import { userContextBlock } from "./user.js";

// Legacy planner system prompt — loaded from prompts/planner_system.txt.
// Not used by the live agent loop.
const SYSTEM = loadPrompt("planner_system");

export async function plan(
  llm: LLM,
  question: string,
  history: LLMMessage[] = [],
): Promise<RetrievalPlan> {
  const recent = history.slice(-4); // brief context for pronoun resolution
  const contextBlock =
    recent.length > 0
      ? `\n\n# Recent turns (for context only)\n${recent
          .map((m) => `${m.role}: ${m.content.slice(0, 400)}`)
          .join("\n")}\n\n# Latest question\n${question}`
      : question;

  const raw = await llm.complete({
    model: config.plannerModel,
    system: SYSTEM + userContextBlock(),
    messages: [{ role: "user", content: contextBlock }],
    maxTokens: 400,
    temperature: 0,
  });

  return parsePlan(raw, question);
}

function parsePlan(raw: string, question: string): RetrievalPlan {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      needPersonal: Boolean(parsed.needPersonal),
      needWeb: Boolean(parsed.needWeb),
      queries:
        Array.isArray(parsed.queries) && parsed.queries.length > 0
          ? parsed.queries.map(String)
          : [question],
      reasoning:
        typeof parsed.reasoning === "string" ? parsed.reasoning : undefined,
    };
  } catch {
    return { needPersonal: true, needWeb: true, queries: [question] };
  }
}
