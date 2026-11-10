import type { Hono } from "hono";
import type { MemoryStore } from "./store.js";

export function mountMemoryRoutes(app: Hono, memory: MemoryStore, dbPath: string): void {
  app.get("/health", (c) => {
    return c.json({ ok: true, db: dbPath, ...memory.stats() });
  });

  app.get("/memory/stats", (c) => c.json(memory.stats()));

  app.get("/memory/search", (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json({ error: "missing q" }, 400);

    const topK = parseInt(c.req.query("top_k") ?? "10", 10);
    const bundle = c.req.query("bundle") ?? null;
    const since = c.req.query("since") ?? null;

    try {
      const hits = memory.search(q, {
        topK,
        bundle,
        since,
        recencyWeight: numQuery(c.req.query("recency_weight"), 0.5),
        dwellWeight: numQuery(c.req.query("dwell_weight"), 0.3),
        recencyHalfLifeDays: numQuery(c.req.query("recency_half_life"), 30),
      });
      return c.json({ hits });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/memory/recent", (c) => {
    const topK = parseInt(c.req.query("top_k") ?? "20", 10);
    const since = c.req.query("since") ?? null;
    const until = c.req.query("until") ?? null;
    const bundle = c.req.query("bundle") ?? null;
    try {
      return c.json({ hits: memory.recent({ topK, since, until, bundle }) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get("/memory/material/:id", (c) => {
    const id = c.req.param("id");
    const m = memory.getMaterial(id);
    if (!m) return c.json({ error: "not found" }, 404);
    return c.json(m);
  });

  app.get("/material/:id", (c) => {
    const id = c.req.param("id");
    const m = memory.getMaterial(id);
    if (!m) return c.json({ error: "not found" }, 404);
    return c.json({
      id: m.material_id,
      text: m.cleaned_text ?? "",
      title: m.title,
      application: m.bundle_id,
      firstSeen: m.first_seen,
      lastSeen: m.last_seen,
      frameCount: m.frame_count,
    });
  });
}

function numQuery(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}
