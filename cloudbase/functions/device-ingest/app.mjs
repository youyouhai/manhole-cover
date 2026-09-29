import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { parsePacket, ProtocolError } from "./protocol.mjs";

const MAX_BODY_BYTES = 2048;

function json(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function text(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function safeTokenEqual(received, expected) {
  const receivedBuffer = Buffer.from(received || "", "utf8");
  const expectedBuffer = Buffer.from(expected || "", "utf8");
  return receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ProtocolError("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function loadTokens(value = process.env.DEVICE_TOKENS_JSON) {
  const tokens = new Map();
  if (process.env.DEVICE_TOKEN_MH001) {
    tokens.set("MH001", process.env.DEVICE_TOKEN_MH001);
  }
  if (!value) return tokens;
  const parsed = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("DEVICE_TOKENS_JSON must be a JSON object");
  }
  for (const [deviceId, token] of Object.entries(parsed)) {
    if (typeof token !== "string") {
      throw new Error(`token for ${deviceId} must be a string`);
    }
    tokens.set(deviceId, token);
  }
  return tokens;
}

function requestMetadata(req) {
  return {
    requestId: req.headers["x-request-id"] || null,
    remoteAddress:
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      null,
    userAgent: req.headers["user-agent"] || null,
  };
}

export function createDeviceIngestServer(options = {}) {
  const tokens = options.tokens || loadTokens();
  const logger = options.logger || console;
  const repository = options.repository || null;

  return createServer(async (req, res) => {
    const requestUrl = new URL(req.url, "http://localhost");
    const path = requestUrl.pathname;
    if (req.method === "GET" && path === "/health") {
      return json(res, 200, { ok: true, service: "device-ingest", version: "V1" });
    }
    // CloudBase may expose the function at the gateway path while forwarding
    // either the original path or "/" to the HTTP process.
    if (path !== "/" && path !== "/api/v1/device/telemetry") {
      return json(res, 404, { ok: false, error: "not_found" });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { ok: false, error: "method_not_allowed" });
    }
    if (tokens.size === 0) {
      logger.error(JSON.stringify({ event: "ingest.configuration_error" }));
      return text(res, 503, "ERR,SERVER_CONFIG\r\n");
    }

    try {
      const rawBody = await readBody(req);
      const packet = parsePacket(rawBody);
      const expectedToken = tokens.get(packet.deviceId);
      // Some DTU firmware cannot add custom HTTP headers. Keep the header as
      // the preferred transport, while allowing those devices to put the same
      // per-device token in the request URL.
      const receivedToken =
        req.headers["x-device-token"] || requestUrl.searchParams.get("token");
      if (!expectedToken || !safeTokenEqual(receivedToken, expectedToken)) {
        logger.warn(JSON.stringify({
          event: "telemetry.rejected",
          reason: "unauthorized",
          deviceId: packet.deviceId,
          ...requestMetadata(req),
        }));
        return text(res, 401, "ERR,UNAUTHORIZED\r\n");
      }

      const receivedAt = new Date();
      const metadata = requestMetadata(req);
      if (repository) {
        try {
          await repository.persist(packet, {
            receivedAt,
            requestId: metadata.requestId,
          });
        } catch (error) {
          logger.error(JSON.stringify({
            event: "telemetry.storage_failed",
            deviceId: packet.deviceId,
            message: error instanceof Error ? error.message : String(error),
            ...metadata,
          }));
          return text(res, 503, "ERR,STORAGE\r\n");
        }
      }

      logger.log(JSON.stringify({
        event: "telemetry.accepted",
        receivedAt: receivedAt.toISOString(),
        persisted: Boolean(repository),
        packet,
        ...metadata,
      }));

      const locationAck = packet.locationMode === "LBS" ? "LBS" : "GPS";
      const acknowledgement = packet.packetType === "sensor"
        ? `ACK,${packet.sequence}\r\n`
        : `ACK,${locationAck},${packet.longitude.toFixed(6)},${packet.latitude.toFixed(6)}\r\n`;
      return text(res, 200, acknowledgement);
    } catch (error) {
      if (error instanceof ProtocolError) {
        logger.warn(JSON.stringify({
          event: "telemetry.rejected",
          reason: error.message,
          ...requestMetadata(req),
        }));
        return text(res, 422, `ERR,PACKET,${error.message}\r\n`);
      }
      logger.error(error);
      return text(res, 500, "ERR,INTERNAL\r\n");
    }
  });
}
