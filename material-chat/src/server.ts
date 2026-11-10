#!/usr/bin/env node
/**
 * Material Chat HTTP host — memory search + agent, one process.
 *
 * Env:
 *   AUSM_DB                 path to ausm-materials.db
 *   AUSM_PORT               default 8788
 *   MATERIAL_CHAT_DATA_DIR  sessions / prefs
 */

import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./http.js";
import { initMemory } from "./memory/index.js";

const memory = initMemory(config.dbPath);
const app = createApp(memory);

const shutdown = () => {
  console.error("[material-chat] shutting down");
  memory.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.error(`[material-chat] listening on http://localhost:${info.port}`);
  console.error(`[material-chat] db: ${config.dbPath}`);
  const s = memory.stats();
  console.error(
    `[material-chat] materials: ${s.total} total, ${s.with_text} with text, ${s.fts_indexed} indexed`,
  );
});
