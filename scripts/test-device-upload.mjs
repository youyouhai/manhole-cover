import { readFile } from 'node:fs/promises';
import dns from 'node:dns';

const apiBase = String(process.env.PHOTO_API_BASE || '').replace(/\/$/, '');
const deviceId = process.env.PHOTO_DEVICE_ID || 'goouuu-cam-001';
const token = process.env.PHOTO_DEVICE_TOKEN || '';
const overrideIp = process.env.PHOTO_API_IP || '';
if (overrideIp) {
  const targetHost = new URL(apiBase).hostname;
  const lookup = dns.lookup;
  dns.lookup = function (hostname, options, callback) {
    if (hostname !== targetHost) return lookup.call(dns, hostname, options, callback);
    if (typeof options === 'function') return options(null, overrideIp, 4);
    if (options?.all) return callback(null, [{ address: overrideIp, family: 4 }]);
    return callback(null, overrideIp, 4);
  };
}
const files = String(process.env.PHOTO_FILES || '').split(';').map((item) => item.trim()).filter(Boolean);
const fallbackJpeg = await (await import('../web/node_modules/sharp/lib/index.js')).default({
  create: { width: 1, height: 1, channels: 3, background: '#2563eb' },
}).jpeg().toBuffer();

if (!apiBase || !token) {
  console.error('请设置 PHOTO_API_BASE 和 PHOTO_DEVICE_TOKEN 环境变量');
  process.exit(2);
}

const authHeaders = { Authorization: `Bearer ${token}`, 'X-Device-Id': deviceId };

async function expectJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

const created = await expectJson(await fetch(`${apiBase}/api/device/v1/photo-batches`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestedCount: 3, capturedAt: new Date().toISOString(), firmwareVersion: 'camera-test-script/0.1.0' }),
}));
console.log(`batchId=${created.batchId}`);

for (let sequence = 1; sequence <= 3; sequence += 1) {
  const bytes = files[sequence - 1] ? await readFile(files[sequence - 1]) : fallbackJpeg;
  const form = new FormData();
  form.append('sequence', String(sequence));
  form.append('capturedAt', new Date().toISOString());
  form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), `capture-${sequence}.jpg`);
  const uploaded = await expectJson(await fetch(`${apiBase}/api/device/v1/photo-batches/${created.batchId}/photos`, {
    method: 'POST', headers: authHeaders, body: form,
  }));
  console.log(`photo ${sequence}: ${uploaded.status} (${uploaded.photoId})`);
}

const completed = await expectJson(await fetch(`${apiBase}/api/device/v1/photo-batches/${created.batchId}/complete`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({ attemptedCount: 3 }),
}));
console.log(JSON.stringify(completed, null, 2));
