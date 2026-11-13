import crypto from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { config } from "./config.js";
import { isAllowedOrigin, localOnly } from "./local-only.js";
import { ask, askStream } from "./engine/pipeline.js";
import { listPipelines } from "./engine/pipelines/index.js";
import type { MemoryStore } from "./memory/store.js";
import { mountMemoryRoutes } from "./memory/routes.js";
import { JinaReaderFetcher } from "./retrieval/web/fetch.js";
import { getSessionStore } from "./sessions/store.js";
import type { Session, StoredMessage } from "./sessions/types.js";

// .trim() first so a whitespace-only question is rejected before any model call.
const AskBody = z.object({ question: z.string().trim().min(1) });
const ChatBody = z.object({
  question: z.string().trim().min(1),
  sessionId: z.string().optional().nullable(),
});
const RenameBody = z.object({ title: z.string().min(1) });

function stripSourcesFooter(md: string): string {
  const idx = md.lastIndexOf("\n\n---\n\n**Sources**");
  return idx >= 0 ? md.slice(0, idx) : md;
}

export function createApp(memory: MemoryStore): Hono {
  const app = new Hono();
  app.use("*", localOnly(config.allowedOrigins));
  // Echo the origin only for local or allow-listed pages (localOnly has already rejected others).
  app.use("*", cors({
    origin: (origin) => (isAllowedOrigin(origin, config.allowedOrigins) ? origin : null),
    allowHeaders: ["Content-Type"],
  }));
  mountMemoryRoutes(app, memory, config.dbPath);

  const store = getSessionStore(config.sessionsPath);
  const fetcher = new JinaReaderFetcher();

  app.get("/pipelines", (c) =>
    c.json({
      defaultId: config.defaultPipeline,
      pipelines: listPipelines().map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
      })),
    }),
  );

  app.post("/ask", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const parsed = AskBody.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    if (!config.anthropicKey) {
      return c.json({ error: "ANTHROPIC_API_KEY is not set" }, 500);
    }
    try {
      return c.json(await ask(parsed.data.question));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  function toSummary(s: Session) {
    return {
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
    };
  }

  app.get("/sessions", async (c) => {
    const list = await store.list();
    return c.json(list.map(toSummary));
  });

  app.post("/sessions", async (c) => {
    const session = await store.create();
    return c.json(session);
  });

  app.get("/sessions/:id", async (c) => {
    const s = await store.get(c.req.param("id"));
    if (!s) return c.json({ error: "not found" }, 404);
    return c.json(s);
  });

  app.patch("/sessions/:id", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const parsed = RenameBody.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    try {
      const s = await store.rename(c.req.param("id"), parsed.data.title);
      return c.json(s);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  app.delete("/sessions/:id", async (c) => {
    await store.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/chat/stream", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const parsed = ChatBody.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { question, sessionId } = parsed.data;

    if (!config.anthropicKey) {
      return c.json({ error: "ANTHROPIC_API_KEY is not set" }, 500);
    }

    let session: Session;
    if (sessionId) {
      const existing = await store.get(sessionId);
      if (!existing) return c.json({ error: "session not found" }, 404);
      session = existing;
    } else {
      session = await store.create();
    }

    const history = session.messages
      .filter((m) => !m.error && m.content.length > 0)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.role === "assistant" ? stripSourcesFooter(m.content) : m.content,
      }));

    const userMsg: StoredMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: question,
      createdAt: Date.now(),
    };
    await store.appendMessage(session.id, userMsg);

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "session",
        data: JSON.stringify({ type: "session", sessionId: session.id, title: session.title }),
      });

      const assistantId = crypto.randomUUID();
      let hits: StoredMessage["hits"];
      let citations: StoredMessage["citations"];
      let fullMarkdown = "";
      let errorMessage: string | undefined;

      for await (const evt of askStream(question, { history })) {
        await stream.writeSSE({ event: evt.type, data: JSON.stringify(evt) });
        switch (evt.type) {
          case "done":
            fullMarkdown = evt.markdown;
            hits = evt.hits;
            citations = evt.citations;
            break;
          case "error":
            errorMessage = evt.message;
            break;
        }
        if (evt.type === "done" || evt.type === "error") break;
      }

      const assistantMsg: StoredMessage = {
        id: assistantId,
        role: "assistant",
        content: fullMarkdown,
        hits,
        citations,
        error: errorMessage,
        createdAt: Date.now(),
      };
      await store.appendMessage(session.id, assistantMsg);
    });
  });

  app.get("/proxy", async (c) => {
    const url = c.req.query("url");
    if (!url) return c.json({ error: "missing url" }, 400);
    try {
      const markdown = await fetcher.fetch(url);
      return c.json({ url, markdown });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  return app;
}
