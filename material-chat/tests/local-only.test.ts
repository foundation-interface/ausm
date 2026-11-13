import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { isAllowedOrigin, localOnly } from "../src/local-only.ts";

// Material Chat holds screen memory and an API key: only this Mac's own pages may reach it.
const app = new Hono();
app.use("*", localOnly(["app://allowed"]));
app.get("/x", (c) => c.text("ok"));

const get = (headers: Record<string, string>) => app.request("http://127.0.0.1:8788/x", { headers });

describe("localOnly", () => {
  test("no Origin (node, main process, curl) is allowed", async () => {
    assert.equal((await get({})).status, 200);
  });

  test("local pages and allow-listed origins are allowed", async () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:3000", "https://localhost", "http://[::1]:8080", "file://", "app://allowed"]) {
      assert.equal((await get({ origin })).status, 200, origin);
    }
  });

  test("other websites are refused", async () => {
    for (const origin of ["https://evil.example", "null", "http://localhost.evil.example", "app://other"]) {
      assert.equal((await get({ origin })).status, 403, origin);
    }
  });

  test("a non-local Host header (DNS rebinding) is refused", async () => {
    assert.equal((await get({ host: "evil.example:8788" })).status, 403);
    assert.equal((await get({ host: "localhost:8788" })).status, 200);
    assert.equal((await get({ host: "[::1]:8788" })).status, 200);
  });

  test("isAllowedOrigin rejects malformed origins", () => {
    assert.equal(isAllowedOrigin("not a url", []), false);
  });
});
