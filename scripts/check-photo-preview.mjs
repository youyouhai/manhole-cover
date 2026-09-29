// Read-only diagnostic for a private CloudBase photo batch. Never prints URLs or credentials.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import https from 'node:https';
import { createCloudBasePhotoRepository } from '../cloudbase/functions/photo-api/cloudbase-repository.mjs';

const batchId = process.argv[2];
if (!/^pb_[A-Za-z0-9_-]{8,64}$/.test(batchId || '')) throw new Error('pass a batch ID');
const credentials = JSON.parse(await readFile(join(homedir(), '.config', '.cloudbase', 'auth.json'), 'utf8')).credential;
const require = createRequire(resolve('cloudbase/functions/photo-api/package.json'));
const cloudbase = require('@cloudbase/node-sdk');
const app = cloudbase.init({
  env: 'smart-manhole-demo-d4cxwdfdf3c12',
  secretId: credentials.tmpSecretId,
  secretKey: credentials.tmpSecretKey,
  sessionToken: credentials.tmpToken,
});
const detail = await createCloudBasePhotoRepository(app).getBatchDetail(batchId);
if (!detail) throw new Error('batch not found');
const photos = detail.photos || [];
console.log('batch photos:', photos.length, 'preview URLs:', photos.filter((photo) => Boolean(photo.previewUrl)).length);
for (const photo of photos.slice(0, 1)) {
  if (!photo.previewUrl) continue;
  await new Promise((resolveRequest, reject) => {
    https.get(photo.previewUrl, (response) => {
      let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; });
      response.on('end', () => { console.log('signed image HTTP:', response.statusCode, 'bytes:', bytes); resolveRequest(); });
    }).on('error', reject);
  });
}
