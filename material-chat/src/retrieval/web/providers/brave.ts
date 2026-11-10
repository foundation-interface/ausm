import type { WebProvider, WebSearchResult } from "../../../types.js";
import { config } from "../../../config.js";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

interface BraveResponse {
  web?: {
    results?: Array<{ title: string; url: string; description: string }>;
  };
}

export class BraveProvider implements WebProvider {
  async search(query: string, topK: number): Promise<WebSearchResult[]> {
    if (!config.braveKey) {
      throw new Error("Missing env var: BRAVE_API_KEY (needed for web search)");
    }
    const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&count=${topK}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": config.braveKey,
      },
    });
    if (!res.ok) {
      throw new Error(`Brave search failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as BraveResponse;
    const results = data.web?.results ?? [];
    return results.slice(0, topK).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: stripHtml(r.description),
    }));
  }
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
