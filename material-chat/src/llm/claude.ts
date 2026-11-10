import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { LLM, LLMRequest } from "./index.js";

export class ClaudeLLM implements LLM {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: config.anthropicKey });
  }

  async complete(req: LLMRequest): Promise<string> {
    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.2,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    const block = res.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  }

  async *stream(req: LLMRequest): AsyncIterable<string> {
    const s = this.client.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.2,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    for await (const event of s) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }
  }
}

let cached: ClaudeLLM | null = null;
export function getLLM(): ClaudeLLM {
  if (!cached) cached = new ClaudeLLM();
  return cached;
}
