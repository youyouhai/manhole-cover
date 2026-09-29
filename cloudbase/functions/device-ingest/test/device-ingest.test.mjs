import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createDeviceIngestServer } from "../app.mjs";
import { parsePacket, ProtocolError } from "../protocol.mjs";
import { createTelemetryRepository } from "../telemetry-repository.mjs";

const sensorPacket =
  "V1,S,MH001,7,60000,2,TILT_WARNING,21.35,1,18.60,1,1.24,BOTH_PRESENT,1,1,1,1,0";

test("parses the ESP32 sensor packet", () => {
  const packet = parsePacket(sensorPacket);
  assert.equal(packet.packetType, "sensor");
  assert.equal(packet.deviceId, "MH001");
  assert.equal(packet.sequence, 7);
  assert.equal(packet.angleDeg, 21.35);
  assert.equal(packet.clearanceCm, 18.6);
  assert.equal(packet.hallState, "BOTH_PRESENT");
});

test("parses and signs GNSS coordinates", () => {
  const packet = parsePacket("V1,G,MH001,W,104.123456,S,30.123456");
  assert.equal(packet.packetType, "gps");
  assert.equal(packet.longitude, -104.123456);
  assert.equal(packet.latitude, -30.123456);
});

test("parses extended LBS coordinates and configured interval", () => {
  const packet = parsePacket("V1,G,MH001,LBS,20,E,87.573301,N,43.819889");
  assert.equal(packet.packetType, "gps");
  assert.equal(packet.locationMode, "LBS");
  assert.equal(packet.configuredIntervalSec, 20);
  assert.equal(packet.longitude, 87.573301);
  assert.equal(packet.latitude, 43.819889);
});

test("rejects malformed packets", () => {
  assert.throws(() => parsePacket("V1,S,MH001"), ProtocolError);
  assert.throws(() => parsePacket("V2,G,MH001,E,104,N,30"), ProtocolError);
});

test("HTTP endpoint authenticates, logs and acknowledges a packet", async (t) => {
  const logEntries = [];
  const persisted = [];
  const logger = {
    log: (value) => logEntries.push(value),
    warn: (value) => logEntries.push(value),
    error: (value) => logEntries.push(value),
  };
  const server = createDeviceIngestServer({
    tokens: new Map([["MH001", "test-token"]]),
    logger,
    repository: { persist: (packet) => persisted.push(packet) },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/device/telemetry`,
    {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Device-Token": "test-token",
      },
      body: sensorPacket,
    },
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ACK,7\r\n");
  assert.match(logEntries.join("\n"), /telemetry\.accepted/);
  assert.equal(persisted.length, 1);
});

test("HTTP endpoint echoes accepted GPS coordinates", async (t) => {
  const server = createDeviceIngestServer({
    tokens: new Map([["MH001", "test-token"]]),
    logger: { log() {}, warn() {}, error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/`, {
    method: "POST",
    headers: { "X-Device-Token": "test-token" },
    body: "V1,G,MH001,E,104.123456,N,30.654321",
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ACK,GPS,104.123456,30.654321\r\n");
});

test("HTTP endpoint accepts extended LBS location packets", async (t) => {
  const persisted = [];
  const server = createDeviceIngestServer({
    tokens: new Map([["MH001", "test-token"]]),
    logger: { log() {}, warn() {}, error() {} },
    repository: { persist: (packet) => persisted.push(packet) },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/`, {
    method: "POST",
    headers: { "X-Device-Token": "test-token" },
    body: "V1,G,MH001,LBS,20,E,87.573301,N,43.819889",
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ACK,LBS,87.573301,43.819889\r\n");
  assert.equal(persisted[0].locationMode, "LBS");
  assert.equal(persisted[0].configuredIntervalSec, 20);
});

test("HTTP endpoint accepts a device token in the URL for headerless DTUs", async (t) => {
  const server = createDeviceIngestServer({
    tokens: new Map([["MH001", "test-token"]]),
    logger: { log() {}, warn() {}, error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/device/telemetry?token=test-token`,
    {
      method: "POST",
      body: "V1,G,MH001,E,104.123456,N,30.654321",
    },
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ACK,GPS,104.123456,30.654321\r\n");
});

test("stores sensor history and latest device state with a seven-day expiry", async () => {
  const writes = [];
  const db = {
    Geo: { Point: class Point {} },
    collection(name) {
      return {
        add(data) {
          writes.push({ operation: "add", name, data });
          return Promise.resolve();
        },
        doc(id) {
          return {
            set(data) {
              writes.push({ operation: "set", name, id, data });
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  const repository = createTelemetryRepository(db);
  const receivedAt = new Date("2026-08-25T00:00:00.000Z");
  await repository.persist(parsePacket(sensorPacket), { receivedAt, requestId: "req-1" });

  assert.deepEqual(writes.map(({ name, operation }) => [name, operation]), [
    ["sensors", "add"],
    ["device_status", "set"],
  ]);
  assert.equal(writes[0].data.expiresAt.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(writes[1].id, "MH001");
});

test("HTTP endpoint rejects a wrong device token", async (t) => {
  const server = createDeviceIngestServer({
    tokens: new Map([["MH001", "test-token"]]),
    logger: { log() {}, warn() {}, error() {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/device/telemetry`,
    {
      method: "POST",
      headers: { "X-Device-Token": "wrong-token" },
      body: sensorPacket,
    },
  );

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "ERR,UNAUTHORIZED\r\n");
});
