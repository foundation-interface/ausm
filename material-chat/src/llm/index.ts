export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  model: string;
  system?: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface LLM {
  complete(req: LLMRequest): Promise<string>;
  stream(req: LLMRequest): AsyncIterable<string>;
}
