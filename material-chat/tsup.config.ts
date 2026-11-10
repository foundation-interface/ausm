import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node18",
    outDir: "dist",
    external: [
      "@anthropic-ai/sdk",
      "@hono/node-server",
      "better-sqlite3",
      "hono",
      "zod",
    ],
  },
  {
    entry: { server: "src/server.ts" },
    format: ["cjs"],
    dts: false,
    clean: false,
    sourcemap: true,
    target: "node18",
    outDir: "dist",
    external: [
      "@anthropic-ai/sdk",
      "@hono/node-server",
      "better-sqlite3",
      "hono",
      "zod",
    ],
  },
]);
