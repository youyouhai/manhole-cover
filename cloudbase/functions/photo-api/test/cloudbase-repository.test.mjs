import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudBasePhotoRepository } from '../cloudbase-repository.mjs';

test('deleting selected camera photos removes private files and database records', async () => {
  const batchId = 'pb_20260920_12345678';
  const deviceId = 'goouuu-cam-001';
  const batches = new Map([[batchId, { batchId, deviceId, requestedCount: 3, status: 'completed' }]]);
  const photos = new Map([1, 2].map((sequence) => {
    const photoId = `ph_${String(sequence).padStart(24, '0')}`;
    return [photoId, { photoId, batchId, deviceId, sequence,
      storageFileId: `cloud://example/photo-collection/${deviceId}/2026/09/20/${batchId}/${sequence}.jpg` }];
  }));
  const deletedFiles = [];
  const db = {
    collection(name) {
      const records = name === 'photo_batches' ? batches : photos;
      return {
        doc(id) { return {
          async get() { return { data: records.has(id) ? [{ ...records.get(id) }] : [] }; },
          async update(changes) { records.set(id, { ...records.get(id), ...changes }); },
          async remove() { records.delete(id); },
        }; },
        where({ batchId: selectedBatchId }) { return {
          limit() { return { async get() { return { data: [...records.values()].filter((item) => item.batchId === selectedBatchId) }; } }; },
        }; },
      };
    },
  };
  const app = {
    database() { return db; },
    async deleteFile({ fileList }) {
      deletedFiles.push(...fileList);
      return { fileList: fileList.map((fileID) => ({ fileID, code: 'SUCCESS' })) };
    },
  };
  const repository = createCloudBasePhotoRepository(app);
  const firstPhotoId = `ph_${String(1).padStart(24, '0')}`;
  const deleted = await repository.deletePhotos(batchId, [firstPhotoId]);
  assert.equal(deleted.deletedCount, 1);
  assert.equal(photos.size, 1);
  assert.equal(batches.get(batchId).successCount, 1);
  assert.equal(batches.get(batchId).status, 'partial_failed');

  const batchDeleted = await repository.deleteBatch(batchId);
  assert.equal(batchDeleted.deletedPhotoCount, 1);
  assert.equal(photos.size, 0);
  assert.equal(batches.size, 0);
  assert.equal(deletedFiles.length, 2);
  assert.ok(deletedFiles.every((fileID) => fileID.includes('/photo-collection/goouuu-cam-001/')));
});
