import { config } from "../config.js";
import type { Citation, RetrievalHit } from "../types.js";

/**
 * Builds a stable ordered citation table from retrieval hits.
 * The model is instructed to cite as [1], [2], ... using these indices.
 */
export function buildCitations(hits: RetrievalHit[]): Citation[] {
  return hits.map((hit, i) => {
    const index = i + 1;
    if (hit.kind === "personal") {
      return {
        index,
        kind: "personal",
        ref: hit.id,
        title: hit.title?.trim() || hit.id,
        url: `${config.materialUrlScheme}${hit.id}`,
      };
    }
    return {
      index,
      kind: "web",
      ref: hit.url,
      title: hit.title,
      url: hit.url,
    };
  });
}

/** Renders the Sources footer as markdown. URLs are wrapped in <> so parens etc. don't break parsing. */
export function renderSources(citations: Citation[]): string {
  if (!citations.length) return "";
  const lines = citations.map((c) => {
    const tag = c.kind === "personal" ? "📁" : "🌐";
    return `[${c.index}] ${tag} [${c.title}](<${c.url}>)`;
  });
  return `\n\n---\n\n**Sources**\n\n${lines.join("\n")}`;
}

/** Compact context block for each cited source, passed to the synthesizer. */
export function renderContextBlocks(
  hits: RetrievalHit[],
  citations: Citation[]
): string {
  return hits
    .map((hit, i) => {
      const c = citations[i];
      if (hit.kind === "personal") {
        const body = hit.fullText.slice(0, 4000);
        const headerParts = [
          `[${c.index}] PERSONAL material:${hit.id}`,
          hit.title ? `title: ${hit.title}` : null,
          hit.application ? `app: ${hit.application}` : null,
          hit.lastSeen ? `last_seen: ${hit.lastSeen}` : null,
        ].filter(Boolean);
        return `${headerParts.join("\n")}\n${body}`;
      }
      const body = hit.content ?? hit.snippet;
      return `[${c.index}] WEB ${hit.title} <${hit.url}>\n${body}`;
    })
    .join("\n\n---\n\n");
}
