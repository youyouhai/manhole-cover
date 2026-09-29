import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const MAX_BODY_BYTES = 1024;

function response(res, status, body) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function validInvitation(value, expectedHex) {
  if (!expectedHex || !/^[a-f0-9]{64}$/i.test(expectedHex)) return false;
  const received = hash(String(value || "").trim().toUpperCase());
  const expected = Buffer.from(expectedHex, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function createWebApiServer(options = {}) {
  const inviteHash = options.inviteHash || process.env.INVITE_CODE_SHA256;
  return createServer(async (req, res) => {
    if (req.method === "OPTIONS") return response(res, 204, {});
    const path = new URL(req.url, "http://localhost").pathname;
    if (path !== "/" && path !== "/invite") {
      return response(res, 404, { ok: false, error: "not_found" });
    }
    if (req.method !== "POST") return response(res, 405, { ok: false, error: "method_not_allowed" });
    try {
      const body = await readJson(req);
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return response(res, 422, { ok: false, error: "invalid_email" });
      }
      if (!validInvitation(body.invitation, inviteHash)) {
        return response(res, 403, { ok: false, error: "invalid_invitation" });
      }
      return response(res, 200, { ok: true });
    } catch {
      return response(res, 400, { ok: false, error: "invalid_request" });
    }
  });
}
