import type { ContentFetcher } from "../../types.js";

const MAX_CONTENT_CHARS = 12_000;

export class JinaReaderFetcher implements ContentFetcher {
  async fetch(url: string): Promise<string> {
    const proxied = `https://r.jina.ai/${url}`;
    const res = await fetch(proxied, {
      headers: { Accept: "text/markdown" },
    });
    if (!res.ok) throw new Error(`Fetch failed for ${url}: ${res.status}`);
    const text = await res.text();
    return text.slice(0, MAX_CONTENT_CHARS);
  }
}
