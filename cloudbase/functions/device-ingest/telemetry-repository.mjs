const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function withoutTransportFields(packet) {
  const { raw, ...data } = packet;
  return data;
}

export function createTelemetryRepository(db, options = {}) {
  const retentionMs = options.retentionMs || DEFAULT_RETENTION_MS;

  return {
    async persist(packet, context = {}) {
      const receivedAt = context.receivedAt || new Date();
      const expiresAt = new Date(receivedAt.getTime() + retentionMs);
      const common = {
        ...withoutTransportFields(packet),
        receivedAt,
        expiresAt,
        requestId: context.requestId || null,
      };

      if (packet.packetType === "sensor") {
        await Promise.all([
          db.collection("sensors").add(common),
          db.collection("device_status").doc(packet.deviceId).set({
            ...common,
            updatedAt: receivedAt,
          }),
        ]);
        return;
      }

      await Promise.all([
        db.collection("locations").add(common),
        db.collection("device_locations").doc(packet.deviceId).set({
          ...common,
          updatedAt: receivedAt,
          location: new db.Geo.Point(packet.longitude, packet.latitude),
        }),
      ]);
    },
  };
}
