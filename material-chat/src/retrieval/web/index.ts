import type { WebHit, WebProvider, ContentFetcher } from "../../types.js";
import { BraveProvider } from "./providers/brave.js";
import { JinaReaderFetcher } from "./fetch.js";

export class WebRetriever {
  constructor(
    private provider: WebProvider = new BraveProvider(),
    private fetcher: ContentFetcher = new JinaReaderFetcher()
  ) {}

  async search(query: string, topK: number, fetchTopK: number): Promise<WebHit[]> {
    const results = await this.provider.search(query, topK);
    const hits: WebHit[] = results.map((r) => ({
      kind: "web",
      title: r.title,
      url: r.url,
      snippet: r.snippet,
    }));

    const toFetch = hits.slice(0, fetchTopK);
    const fetched = await Promise.allSettled(
      toFetch.map((h) => this.fetcher.fetch(h.url))
    );
    fetched.forEach((res, i) => {
      if (res.status === "fulfilled") toFetch[i].content = res.value;
    });

    return hits;
  }
}

let cached: WebRetriever | null = null;
export function getWebRetriever(): WebRetriever {
  if (!cached) cached = new WebRetriever();
  return cached;
}
