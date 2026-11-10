import type { LLM, LLMMessage } from "../llm/index.js";
import type { Citation, RetrievalHit } from "../types.js";
import { config } from "../config.js";
import { renderContextBlocks } from "./citations.js";
import { loadPrompt } from "./prompts.js";
import { userContextBlock } from "./user.js";

// Legacy synthesizer system prompt — loaded from prompts/synthesizer_system.txt.
// Not used by the live agent loop; kept for the non-streaming `ask()` shim
// and for A/B comparison.
const SYSTEM_BASE = loadPrompt("synthesizer_system");

/** Build the user message for this turn — question + numbered sources. */
function buildTurnMessage(
  question: string,
  hits: RetrievalHit[],
  citations: Citation[],
): string {
  const ctx = renderContextBlocks(hits, citations);
  return `# Question\n${question}\n\n# Sources (this turn)\n${ctx}\n\n# Task\nAnswer using the sources above. Cite inline with [N].`;
}

export async function synthesize(
  llm: LLM,
  question: string,
  hits: RetrievalHit[],
  citations: Citation[],
  history: LLMMessage[] = [],
): Promise<string> {
  if (!hits.length) {
    return `I couldn't find relevant information in your materials or on the web for: "${question}".`;
  }
  const messages: LLMMessage[] = [
    ...history,
    { role: "user", content: buildTurnMessage(question, hits, citations) },
  ];
  return llm.complete({
    model: config.synthModel,
    system: synthSystem(),
    messages,
    maxTokens: 2048,
    temperature: 0.2,
  });
}

/**
 * The full system prompt used by the synthesizer, including any user-identity
 * context. Computed lazily so changing USER_NAME / USER_ALIASES at runtime
 * (e.g. tests) doesn't require restarting.
 */
export function synthSystem(): string {
  return SYSTEM_BASE + userContextBlock();
}

export { buildTurnMessage };
