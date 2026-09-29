import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createWebApiServer } from "../app.mjs";

const code = "MH-DEMO-2026";
const inviteHash = createHash("sha256").update(code).digest("hex");

async function request(server, invitation) {
  const address = server.address();
  return fetch(`http://127.0.0.1:${address.port}/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "repair@example.com", invitation }),
  });
}

test("accepts the configured invitation code", async (t) => {
  const server = createWebApiServer({ inviteHash });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const result = await request(server, code);
  assert.equal(result.status, 200);
});

test("rejects a wrong invitation code", async (t) => {
  const server = createWebApiServer({ inviteHash });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const result = await request(server, "WRONG-CODE");
  assert.equal(result.status, 403);
});
