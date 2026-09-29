const DEVICE_ID_PATTERN = /^[A-Z0-9_-]{1,32}$/;
const SENSOR_STATES = new Set([
  "NORMAL",
  "SLIGHT_TILT",
  "TILT_WARNING",
  "TILTED",
  "FLIPPED",
  "INVERTED",
  "CALIBRATION_REQUIRED",
  "SENSOR_FAULT",
]);
const HALL_STATES = new Set([
  "BOTH_PRESENT",
  "LEFT_MISSING",
  "RIGHT_MISSING",
  "BOTH_MISSING",
]);

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolError";
  }
}

function requireDeviceId(value) {
  if (!DEVICE_ID_PATTERN.test(value)) {
    throw new ProtocolError("invalid deviceId");
  }
  return value;
}

function integer(value, name, minimum, maximum) {
  if (!/^-?\d+$/.test(value)) throw new ProtocolError(`invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProtocolError(`invalid ${name}`);
  }
  return parsed;
}

function number(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProtocolError(`invalid ${name}`);
  }
  return parsed;
}

function bit(value, name) {
  return integer(value, name, 0, 1) === 1;
}

function parseSensor(fields, raw) {
  if (fields.length !== 18) {
    throw new ProtocolError(`sensor field count must be 18, got ${fields.length}`);
  }
  if (!SENSOR_STATES.has(fields[6])) throw new ProtocolError("invalid state");
  if (!HALL_STATES.has(fields[12])) throw new ProtocolError("invalid hallState");

  const waterValid = bit(fields[8], "waterValid");
  const riseRateValid = bit(fields[10], "riseRateValid");
  const clearanceCm = number(fields[9], "clearanceCm", -1, 450);
  if (waterValid && clearanceCm < 0) {
    throw new ProtocolError("valid water measurement requires non-negative clearanceCm");
  }

  return {
    protocolVersion: "V1",
    packetType: "sensor",
    deviceId: requireDeviceId(fields[2]),
    sequence: integer(fields[3], "sequence", 0, 0xffffffff),
    uptimeMs: integer(fields[4], "uptimeMs", 0, 0xffffffff),
    risk: integer(fields[5], "risk", 0, 5),
    state: fields[6],
    angleDeg: number(fields[7], "angleDeg", 0, 180),
    waterValid,
    clearanceCm: waterValid ? clearanceCm : null,
    riseRateValid,
    riseRateCmPerMin: riseRateValid
      ? number(fields[11], "riseRateCmPerMin", -10000, 10000)
      : null,
    hallState: fields[12],
    hallLeftPresent: bit(fields[13], "hallLeftPresent"),
    hallRightPresent: bit(fields[14], "hallRightPresent"),
    sensorOnline: bit(fields[15], "sensorOnline"),
    calibrated: bit(fields[16], "calibrated"),
    alarmLatched: bit(fields[17], "alarmLatched"),
    raw,
  };
}

function parseGps(fields, raw) {
  if (fields.length !== 7 && fields.length !== 9) {
    throw new ProtocolError(`gps field count must be 7 or 9, got ${fields.length}`);
  }

  const extended = fields.length === 9;
  const locationMode = extended ? fields[3].toUpperCase() : "UNKNOWN";
  if (extended && !new Set(["GPS", "LBS"]).has(locationMode)) {
    throw new ProtocolError("invalid locationMode");
  }
  const configuredIntervalSec = extended
    ? integer(fields[4], "configuredIntervalSec", 1, 86400)
    : null;
  const coordinateOffset = extended ? 2 : 0;
  const longitudeHemisphere = fields[3 + coordinateOffset].toUpperCase();
  const latitudeHemisphere = fields[5 + coordinateOffset].toUpperCase();
  if (!new Set(["E", "W"]).has(longitudeHemisphere)) {
    throw new ProtocolError("invalid longitude hemisphere");
  }
  if (!new Set(["N", "S"]).has(latitudeHemisphere)) {
    throw new ProtocolError("invalid latitude hemisphere");
  }

  const longitudeMagnitude = number(fields[4 + coordinateOffset], "longitude", 0, 180);
  const latitudeMagnitude = number(fields[6 + coordinateOffset], "latitude", 0, 90);
  return {
    protocolVersion: "V1",
    packetType: "gps",
    deviceId: requireDeviceId(fields[2]),
    locationMode,
    configuredIntervalSec,
    longitude:
      longitudeHemisphere === "W" ? -longitudeMagnitude : longitudeMagnitude,
    latitude:
      latitudeHemisphere === "S" ? -latitudeMagnitude : latitudeMagnitude,
    longitudeHemisphere,
    latitudeHemisphere,
    raw,
  };
}

export function parsePacket(input) {
  const raw = String(input).trim();
  if (!raw) throw new ProtocolError("empty body");
  if (raw.length > 1024) throw new ProtocolError("packet too large");

  const fields = raw.split(",").map((value) => value.trim());
  if (fields[0] !== "V1") throw new ProtocolError("unsupported protocol version");
  if (fields[1] === "S") return parseSensor(fields, raw);
  if (fields[1] === "G") return parseGps(fields, raw);
  throw new ProtocolError("unsupported packet type");
}
