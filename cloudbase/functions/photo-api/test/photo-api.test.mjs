import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createPhotoApiServer } from '../app.mjs';

const DEVICE_ID = 'goouuu-cam-001';
const DEVICE_TOKEN = 'test-only-device-token-1234567890';
const TOKENS = new Map([[DEVICE_ID, DEVICE_TOKEN]]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0xff, 0xd9]);

function fakeRepository() {
  const batches = new Map();
  const photos = new Map();
  const commands = new Map();
  return {
    batches,
    photos,
    commands,
    async createBatch(batch) { batches.set(batch.batchId, batch); return batch; },
    async getBatch(batchId) { return batches.get(batchId) || null; },
    async savePhoto({ batch, sequence, capturedAt, bytes, sha256 }) {
      const key = `${batch.batchId}:${sequence}`;
      if (!photos.has(key)) photos.set(key, { photoId: `ph_${String(sequence).padStart(24, '0')}`, batchId: batch.batchId, sequence, capturedAt, sizeBytes: bytes.length, sha256 });
      return photos.get(key);
    },
    async completeBatch(batchId) {
      const batch = batches.get(batchId);
      const successCount = [...photos.values()].filter((photo) => photo.batchId === batchId).length;
      const failedCount = batch.requestedCount - successCount;
      return { batchId, requestedCount: batch.requestedCount, successCount, failedCount, status: failedCount ? (successCount ? 'partial_failed' : 'failed') : 'completed' };
    },
    async heartbeat() {},
    async syncAlarmCapture() {},
    async createCaptureCommand(command) { const item = { ...command, status: 'pending' }; commands.set(item.commandId, item); return item; },
    async nextCaptureCommand(deviceId) { return [...commands.values()].find((item) => item.deviceId === deviceId && item.status === 'pending') || null; },
    async getCaptureCommand(commandId) { return commands.get(commandId) || null; },
    async ackCaptureCommand(deviceId, commandId) { const item = commands.get(commandId); if (!item || item.deviceId !== deviceId) return false; item.status = 'accepted'; return true; },
    async listBatches({ page, pageSize }) { return { items: [...batches.values()], page, pageSize, total: batches.size, onlineDevices: 1 }; },
    async getBatchDetail(batchId) { const batch = batches.get(batchId); return batch ? { ...batch, photos: [...photos.values()].filter((photo) => photo.batchId === batchId).sort((a, b) => a.sequence - b.sequence) } : null; },
    async deletePhotos(batchId, photoIds) {
      if (!batches.has(batchId)) return null;
      const selected = [...photos.entries()].filter(([, photo]) => photo.batchId === batchId && photoIds.includes(photo.photoId));
      if (selected.length !== photoIds.length) return null;
      for (const [key] of selected) photos.delete(key);
      return { batchId, deletedPhotoIds: photoIds, deletedCount: selected.length };
    },
    async deleteBatch(batchId) {
      if (!batches.has(batchId)) return null;
      const selected = [...photos.entries()].filter(([, photo]) => photo.batchId === batchId);
      for (const [key] of selected) photos.delete(key);
      batches.delete(batchId);
      return { batchId, deletedPhotoCount: selected.length };
    },
  };
}

async function withServer(t, overrides = {}) {
  const repository = overrides.repository || fakeRepository();
  const server = createPhotoApiServer({
    repository,
    tokens: TOKENS,
    maxPhotoBytes: overrides.maxPhotoBytes || 1024,
    adminAuthorize: overrides.adminAuthorize || (async () => ({ sub: 'operator-1' })),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { server, repository, base: `http://127.0.0.1:${server.address().port}` };
}

function deviceHeaders(token = DEVICE_TOKEN) {
  return { Authorization: `Bearer ${token}`, 'X-Device-Id': DEVICE_ID };
}

async function createBatch(base, requestedCount = 3, token = DEVICE_TOKEN) {
  return fetch(`${base}/api/device/v1/photo-batches`, {
    method: 'POST',
    headers: { ...deviceHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestedCount, capturedAt: '2026-09-15T10:30:00+08:00', firmwareVersion: '0.1.0' }),
  });
}

async function uploadPhoto(base, batchId, sequence, bytes = JPEG, filename = 'capture.jpg', mimeType = 'image/jpeg') {
  const form = new FormData();
  form.append('sequence', String(sequence));
  form.append('capturedAt', '2026-09-15T10:30:01+08:00');
  form.append('photo', new Blob([bytes], { type: mimeType }), filename);
  return fetch(`${base}/api/device/v1/photo-batches/${batchId}/photos`, {
    method: 'POST',
    headers: deviceHeaders(),
    body: form,
  });
}

test('rejects missing or invalid device credentials', async (t) => {
  const { base } = await withServer(t);
  assert.equal((await createBatch(base, 3, 'wrong-token')).status, 401);
});

test('validates requested photo count', async (t) => {
  const { base } = await withServer(t);
  assert.equal((await createBatch(base, 2)).status, 422);
  assert.equal((await createBatch(base, 6)).status, 422);
  assert.equal((await createBatch(base, 1)).status, 201);
  assert.equal((await createBatch(base, 3)).status, 201);
  assert.equal((await createBatch(base, 5)).status, 201);
});

test('web capture command requires login and device acknowledgement', async (t) => {
  const { base } = await withServer(t);
  const request = await fetch(`${base}/api/admin/capture-command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: DEVICE_ID, requestedCount: 5 }),
  });
  assert.equal(request.status, 202);
  const created = await request.json();
  const before = await (await fetch(`${base}/api/admin/capture-command/${created.commandId}`)).json();
  assert.equal(before.status, 'pending');
  const pending = await (await fetch(`${base}/api/device/v1/capture-command`, { headers: deviceHeaders() })).json();
  assert.equal(pending.command.commandId, created.commandId);
  assert.equal(pending.command.requestedCount, 5);
  const ack = await fetch(`${base}/api/device/v1/capture-command/${created.commandId}/ack`, { method: 'POST', headers: deviceHeaders() });
  assert.equal(ack.status, 200);
  const after = await (await fetch(`${base}/api/admin/capture-command/${created.commandId}`)).json();
  assert.equal(after.status, 'accepted');
  const empty = await (await fetch(`${base}/api/device/v1/capture-command`, { headers: deviceHeaders() })).json();
  assert.equal(empty.command, null);
});

test('accepts JPEG and keeps batch sequence idempotent', async (t) => {
  const { base, repository } = await withServer(t);
  const created = await (await createBatch(base)).json();
  assert.equal((await uploadPhoto(base, created.batchId, 1)).status, 200);
  assert.equal((await uploadPhoto(base, created.batchId, 1)).status, 200);
  assert.equal(repository.photos.size, 1);
});

test('rejects non-JPEG and oversized files', async (t) => {
  const { base } = await withServer(t, { maxPhotoBytes: 8 });
  const created = await (await createBatch(base)).json();
  assert.equal((await uploadPhoto(base, created.batchId, 1, Buffer.from('not-jpeg'), 'bad.png', 'image/png')).status, 415);
  assert.equal((await uploadPhoto(base, created.batchId, 1, Buffer.concat([JPEG, JPEG]), 'large.jpg')).status, 413);
});

test('calculates completion from stored photos', async (t) => {
  const { base } = await withServer(t);
  const created = await (await createBatch(base)).json();
  await uploadPhoto(base, created.batchId, 1);
  await uploadPhoto(base, created.batchId, 2);
  const response = await fetch(`${base}/api/device/v1/photo-batches/${created.batchId}/complete`, {
    method: 'POST',
    headers: { ...deviceHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptedCount: 3 }),
  });
  const completed = await response.json();
  assert.equal(completed.successCount, 2);
  assert.equal(completed.failedCount, 1);
  assert.equal(completed.status, 'partial_failed');
});

test('protects admin endpoints with signed-in user authorization', async (t) => {
  const { base } = await withServer(t, { adminAuthorize: async () => null });
  assert.equal((await fetch(`${base}/api/admin/photo-batches`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/photo-batches/delete`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batchIds: ['pb_20260920_12345678'], confirmation: 'DELETE' }) })).status, 401);
});

test('deletes selected photos and batches only after explicit confirmation', async (t) => {
  const { base, repository } = await withServer(t);
  const batchId = (await (await createBatch(base, 3)).json()).batchId;
  await uploadPhoto(base, batchId, 1);
  await uploadPhoto(base, batchId, 2);
  const headers = { 'Content-Type': 'application/json' };
  const photoId = `ph_${String(1).padStart(24, '0')}`;
  const photoUrl = `${base}/api/admin/photo-batches/${batchId}/photos/delete`;
  assert.equal((await fetch(photoUrl, { method: 'POST', headers,
    body: JSON.stringify({ photoIds: [photoId] }) })).status, 422);
  const photoDelete = await fetch(photoUrl, { method: 'POST', headers,
    body: JSON.stringify({ photoIds: [photoId], confirmation: 'DELETE' }) });
  assert.equal(photoDelete.status, 200);
  assert.equal((await photoDelete.json()).deletedCount, 1);
  assert.equal(repository.photos.size, 1);
  const batchDelete = await fetch(`${base}/api/admin/photo-batches/delete`, { method: 'POST', headers,
    body: JSON.stringify({ batchIds: [batchId], confirmation: 'DELETE' }) });
  assert.equal(batchDelete.status, 200);
  assert.deepEqual((await batchDelete.json()).deletedBatchIds, [batchId]);
  assert.equal(repository.photos.size, 0);
  assert.equal(repository.batches.size, 0);
});
