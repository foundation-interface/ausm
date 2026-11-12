import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Input validation for the HTTP routes the runtime's HttpHost exposes.
 * No Anthropic key is ever set, so LLM-backed routes stop at validation;
 * fetch is blocked so nothing can reach the network.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "material-chat-http-"));
const savedEnv = { ...process.env };
delete process.env.ANTHROPIC_API_KEY;
process.env.SESSIONS_PATH = path.join(tmp, "sessions.json");
process.env.MATERIAL_CHAT_DATA_DIR = tmp;
process.env.AUSM_DB = ":memory:";

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error("network access is blocked in tests"); }) as typeof fetch;

const { createApp } = require("../src/http.ts");

const searches: any[] = [];
const recents: any[] = [];
const fakeMemory = {
  stats: () => ({ total: 2, with_text: 1, fts_indexed: 1 }),
  search: (q: string, opts: any) => { searches.push({ q, ...opts }); return [{ material_id: "m1" }]; },
  recent: (opts: any) => { recents.push(opts); return []; },
  getMaterial: (id: string) => id === "m1"
    ? { material_id: "m1", cleaned_text: null, title: "T", bundle_id: "com.x", first_seen: 1, last_seen: 2, frame_count: 3 }
    : null,
};

let app: any;
before(() => { app = createApp(fakeMemory); });
after(() => {
  globalThis.fetch = realFetch;
  process.env = savedEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const json = (method: string, url: string, body?: unknown, raw?: string) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });

describe("health and memory routes", () => {
  test("/health reports db and stats", async () => {
    const res = await app.request("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, db: ":memory:", total: 2, with_text: 1, fts_indexed: 1 });
  });

  test("/memory/search requires a non-blank q", async () => {
    assert.equal((await app.request("/memory/search")).status, 400);
    assert.equal((await app.request("/memory/search?q=%20%20")).status, 400);
  });

  test("/memory/search passes defaults and parsed weights", async () => {
    searches.length = 0;
    const res = await app.request("/memory/search?q=hello&recency_weight=0.9&dwell_weight=abc&bundle=com.x&since=2026-01-01");
    assert.equal(res.status, 200);
    assert.deepEqual(searches[0], {
      q: "hello", topK: 10, bundle: "com.x", since: "2026-01-01", recencyWeight: 0.9, dwellWeight: 0.3, recencyHalfLifeDays: 30,
    });
  });

  test("/memory/search: non-numeric or non-positive top_k falls back to the default", async () => {
    for (const bad of ["abc", "0", "-5", ""]) {
      searches.length = 0;
      await app.request(`/memory/search?q=x&top_k=${bad}`);
      assert.equal(searches[0].topK, 10, `top_k=${bad}`);
    }
    searches.length = 0;
    await app.request("/memory/search?q=x&top_k=3");
    assert.equal(searches[0].topK, 3);
  });

  test("/memory/recent: invalid top_k falls back to 20", async () => {
    recents.length = 0;
    await app.request("/memory/recent?top_k=NaN");
    await app.request("/memory/recent");
    assert.deepEqual(recents.map((r) => r.topK), [20, 20]);
  });

  test("/memory/search surfaces store errors as 500", async () => {
    const broken = createApp({ ...fakeMemory, search: () => { throw new Error("fts5 syntax error"); } });
    const res = await broken.request("/memory/search?q=%22");
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /fts5/);
  });

  test("material lookups: 404 for unknown ids, mapped shape for known", async () => {
    assert.equal((await app.request("/memory/material/nope")).status, 404);
    assert.equal((await app.request("/material/nope")).status, 404);
    assert.deepEqual(await (await app.request("/material/m1")).json(), {
      id: "m1", text: "", title: "T", application: "com.x", firstSeen: 1, lastSeen: 2, frameCount: 3,
    });
  });
});

describe("LLM-backed routes stop at validation without a key", () => {
  test("/ask rejects invalid JSON, missing or blank questions with 400", async () => {
    assert.equal((await json("POST", "/ask", undefined, "{not json")).status, 400);
    assert.equal((await json("POST", "/ask", {})).status, 400);
    assert.equal((await json("POST", "/ask", { question: "" })).status, 400);
    assert.equal((await json("POST", "/ask", { question: "   " })).status, 400);
    assert.equal((await json("POST", "/ask", { question: 42 })).status, 400);
  });

  test("/ask with a valid question but no API key returns 500 without calling the model", async () => {
    const res = await json("POST", "/ask", { question: "what did I read?" });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /ANTHROPIC_API_KEY/);
  });

  test("/chat/stream validates body and requires the key before touching sessions", async () => {
    assert.equal((await json("POST", "/chat/stream", undefined, "nope")).status, 400);
    assert.equal((await json("POST", "/chat/stream", { question: "\n\t" })).status, 400);
    assert.equal((await json("POST", "/chat/stream", { question: "q", sessionId: 5 })).status, 400);
    const res = await json("POST", "/chat/stream", { question: "q", sessionId: null });
    assert.equal(res.status, 500);
    const sessions = await (await app.request("/sessions")).json();
    assert.equal(sessions.length, 0, "no session created when the request cannot be served");
  });

  test("/proxy requires a url", async () => {
    assert.equal((await app.request("/proxy")).status, 400);
  });

  test("/pipelines lists the default pipeline", async () => {
    const body = await (await app.request("/pipelines")).json();
    assert.equal(body.defaultId, 1);
    assert.ok(body.pipelines.some((p: any) => p.id === 1));
  });
});

describe("session routes", () => {
  test("create, get, rename, list, delete", async () => {
    const created = await (await json("POST", "/sessions")).json();
    assert.equal(created.title, "New chat");
    assert.equal((await app.request(`/sessions/${created.id}`)).status, 200);

    assert.equal((await json("PATCH", `/sessions/${created.id}`, undefined, "{")).status, 400);
    assert.equal((await json("PATCH", `/sessions/${created.id}`, { title: "" })).status, 400);
    const renamed = await (await json("PATCH", `/sessions/${created.id}`, { title: "  Trip notes  " })).json();
    assert.equal(renamed.title, "Trip notes");
    const blank = await (await json("PATCH", `/sessions/${created.id}`, { title: "   " })).json();
    assert.equal(blank.title, "New chat", "whitespace title resets to the default");

    const list = await (await app.request("/sessions")).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].messageCount, 0);

    assert.deepEqual(await (await app.request(`/sessions/${created.id}`, { method: "DELETE" })).json(), { ok: true });
    assert.equal((await app.request(`/sessions/${created.id}`)).status, 404);
    assert.deepEqual(await (await app.request("/sessions/missing", { method: "DELETE" })).json(), { ok: true });
  });

  test("renaming an unknown session is a 404", async () => {
    assert.equal((await json("PATCH", "/sessions/missing", { title: "x" })).status, 404);
  });

  test("sessions are persisted under the configured path only", () => {
    assert.ok(fs.existsSync(path.join(tmp, "sessions.json")));
  });
});
