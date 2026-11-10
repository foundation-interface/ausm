import type { PersonalHit, PersonalRetriever } from "../../types.js";
import { getMemoryStore } from "../../memory/index.js";

/**
 * Personal retriever over the in-process MemoryStore (same SQLite the
 * HTTP /memory/* routes use).
 */
export class AusmMemoryClient implements PersonalRetriever {
  search(query: string, topK: number): Promise<PersonalHit[]> {
    const hits = getMemoryStore().search(query, { topK });
    if (!hits.length) return Promise.resolve([]);

    const memory = getMemoryStore();
    const hydrated = hits.map((h): PersonalHit => {
      const material = memory.getMaterial(h.material_id);
      return {
        kind: "personal",
        id: h.material_id,
        score: h.score,
        snippet: stripHighlightMarkers(h.snippet),
        fullText: material?.cleaned_text ?? "",
        title: h.title ?? undefined,
        application: h.bundle_id ?? undefined,
        lastSeen: h.last_seen ?? undefined,
        firstSeen: h.first_seen ?? undefined,
        frameCount: h.frame_count,
      };
    });
    return Promise.resolve(hydrated);
  }
}

function stripHighlightMarkers(s: string): string {
  return s.replace(/⟦|⟧/g, "");
}
