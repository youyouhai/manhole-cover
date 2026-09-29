import cloudbase from '@cloudbase/node-sdk';
import { createHash } from 'node:crypto';

function plainDate(value) {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function dateMillis(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : 0;
}

function dataOf(result) {
  return Array.isArray(result?.data) ? result.data : [];
}

export function createCloudBasePhotoRepository(app, options = {}) {
  const db = app.database();
  const storagePrefix = options.storagePrefix || process.env.PHOTO_STORAGE_PREFIX || 'photo-collection';
  const urlTtlSeconds = Number(options.urlTtlSeconds || process.env.PHOTO_URL_TTL_SECONDS || 900);
  const closedStatuses = new Set(['completed', 'partial_failed', 'failed']);
  async function storedPhotos(batchId) {
    const result = await db.collection('photos').where({ batchId }).limit(5).get();
    return dataOf(result);
  }
  async function removeStoragePhoto(photo) {
    const fileId = String(photo.storageFileId || '');
    if (!fileId.includes(`/${storagePrefix}/${photo.deviceId}/`)) {
      throw new Error('photo storage path is outside the camera collection');
    }
    const result = await app.deleteFile({ fileList: [fileId] });
    const deleted = result?.fileList?.find((item) => item.fileID === fileId);
    const code = String(deleted?.code ?? '').toUpperCase();
    if (!['SUCCESS', '0', 'FILE_NOT_FOUND', 'FILE_NOT_EXIST'].includes(code)) {
      throw new Error(`private photo storage deletion failed: ${code || 'no result'}`);
    }
  }
  async function updateBatchPhotoCount(batch) {
    const successCount = (await storedPhotos(batch.batchId)).length;
    const requestedCount = Number(batch.requestedCount) || 0;
    await db.collection('photo_batches').doc(batch.batchId).update({
      successCount,
      failedCount: Math.max(0, requestedCount - successCount),
      status: successCount === requestedCount ? 'completed' : successCount > 0 ? 'partial_failed' : 'failed',
      updatedAt: new Date(),
    });
  }
  let commandCollectionsReady;
  async function ensureCommandCollections() {
    if (!commandCollectionsReady) {
      commandCollectionsReady = (async () => {
        for (const name of ['camera_commands', 'camera_alarm_state']) {
          try {
            await db.collection(name).limit(1).get();
          } catch {
            try {
              await db.createCollection(name);
            } catch (createError) {
              // Concurrent cold starts may have created it already.
              try { await db.collection(name).limit(1).get(); }
              catch { throw createError; }
            }
          }
        }
      })().catch((error) => { commandCollectionsReady = null; throw error; });
    }
    return commandCollectionsReady;
  }

  return {
    async createBatch(batch) {
      const { _id, ...fields } = batch;
      await db.collection('photo_batches').doc(batch.batchId).set(fields);
      return batch;
    },

    async getBatch(batchId) {
      const result = await db.collection('photo_batches').doc(batchId).get();
      return Array.isArray(result.data) ? result.data[0] || null : result.data || null;
    },

    async getPhoto(photoId) {
      const result = await db.collection('photos').doc(photoId).get();
      return Array.isArray(result.data) ? result.data[0] || null : result.data || null;
    },

    async deletePhotos(batchId, photoIds) {
      const batch = await this.getBatch(batchId);
      if (!batch) return null;
      if (!closedStatuses.has(batch.status)) throw new Error('cannot delete a batch while uploading');
      const photos = await storedPhotos(batchId);
      const selected = photos.filter((photo) => photoIds.includes(photo.photoId));
      if (selected.length !== photoIds.length) return null;
      let deletedCount = 0;
      try {
        for (const photo of selected) {
          await removeStoragePhoto(photo);
          await db.collection('photos').doc(photo.photoId).remove();
          deletedCount += 1;
        }
      } finally {
        if (deletedCount > 0) await updateBatchPhotoCount(batch);
      }
      return { batchId, deletedPhotoIds: selected.map((photo) => photo.photoId), deletedCount };
    },

    async deleteBatch(batchId) {
      const batch = await this.getBatch(batchId);
      if (!batch) return null;
      if (!closedStatuses.has(batch.status)) throw new Error('cannot delete a batch while uploading');
      const photos = await storedPhotos(batchId);
      if (photos.length) {
        await this.deletePhotos(batchId, photos.map((photo) => photo.photoId));
      }
      await db.collection('photo_batches').doc(batchId).remove();
      return { batchId, deletedPhotoCount: photos.length };
    },

    async savePhoto({ batch, sequence, capturedAt, bytes, sha256 }) {
      const photoId = `ph_${createHash('sha256').update(`${batch.batchId}:${sequence}`).digest('hex').slice(0, 24)}`;
      const existing = await this.getPhoto(photoId);
      if (existing) return existing;

      const captured = plainDate(capturedAt);
      const yyyy = String(captured.getUTCFullYear());
      const mm = String(captured.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(captured.getUTCDate()).padStart(2, '0');
      const cloudPath = `${storagePrefix}/${batch.deviceId}/${yyyy}/${mm}/${dd}/${batch.batchId}/${sequence}.jpg`;
      const upload = await app.uploadFile({ cloudPath, fileContent: bytes });
      const now = new Date();
      const photo = {
        _id: photoId,
        photoId,
        batchId: batch.batchId,
        deviceId: batch.deviceId,
        sequence,
        storageFileId: upload.fileID,
        mimeType: 'image/jpeg',
        sizeBytes: bytes.length,
        width: null,
        height: null,
        sha256,
        capturedAt: captured,
        createdAt: now,
        status: 'uploaded',
      };
      const { _id, ...fields } = photo;
      await db.collection('photos').doc(photoId).set(fields);
      await db.collection('photo_batches').doc(batch.batchId).update({ status: 'uploading', updatedAt: now });
      return photo;
    },

    async completeBatch(batchId, attemptedCount) {
      const batch = await this.getBatch(batchId);
      if (!batch) return null;
      const photoResult = await db.collection('photos').where({ batchId }).limit(5).get();
      const successCount = dataOf(photoResult).length;
      const requestedCount = Number(batch.requestedCount);
      const effectiveAttempts = Math.max(requestedCount, Number(attemptedCount) || 0);
      const failedCount = Math.max(0, effectiveAttempts - successCount);
      const status = successCount === requestedCount
        ? 'completed'
        : successCount > 0 ? 'partial_failed' : 'failed';
      const completedAt = new Date();
      await db.collection('photo_batches').doc(batchId).update({
        successCount,
        failedCount,
        status,
        completedAt,
        updatedAt: completedAt,
      });
      return { batchId, requestedCount, successCount, failedCount, status, completedAt };
    },

    async heartbeat(deviceId, data) {
      const now = new Date();
      await db.collection('camera_devices').doc(deviceId).set({
        deviceId,
        name: data.name || deviceId,
        enabled: true,
        lastSeenAt: now,
        firmwareVersion: data.firmwareVersion || null,
        rssi: Number.isFinite(Number(data.rssi)) ? Number(data.rssi) : null,
        localIp: data.localIp || null,
        updatedAt: now,
      });
    },

    async createCaptureCommand(input) {
      await ensureCommandCollections();
      const now = new Date();
      const command = {
        commandId: input.commandId,
        deviceId: input.deviceId,
        requestedCount: input.requestedCount,
        source: input.source,
        requestedBy: input.requestedBy || null,
        status: 'pending',
        createdAt: now,
        expiresAt: new Date(now.getTime() + 2 * 60 * 1000),
      };
      await db.collection('camera_commands').doc(command.commandId).set(command);
      return command;
    },

    async nextCaptureCommand(deviceId) {
      await ensureCommandCollections();
      const result = await db.collection('camera_commands')
        .where({ deviceId, status: 'pending' })
        .orderBy('createdAt', 'asc').limit(10).get();
      const now = Date.now();
      return dataOf(result).find((command) => dateMillis(command.expiresAt) > now) || null;
    },

    async getCaptureCommand(commandId) {
      await ensureCommandCollections();
      const result = await db.collection('camera_commands').doc(commandId).get();
      return Array.isArray(result.data) ? result.data[0] || null : result.data || null;
    },

    async ackCaptureCommand(deviceId, commandId) {
      await ensureCommandCollections();
      const result = await db.collection('camera_commands').doc(commandId).get();
      const command = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!command || command.deviceId !== deviceId) return false;
      if (command.status === 'pending') {
        await db.collection('camera_commands').doc(commandId).update({ status: 'accepted', acceptedAt: new Date() });
      }
      return true;
    },

    async syncAlarmCapture(deviceId) {
      await ensureCommandCollections();
      // MH001 firmware confirms the tilt danger only after 10 continuous seconds.
      // This relay reacts to that confirmed state; it does not reinterpret raw angle samples.
      const sourceId = process.env.PHOTO_ALARM_DEVICE_ID || 'MH001';
      const result = await db.collection('device_status').doc(sourceId).get();
      const status = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!status || !status.receivedAt || Date.now() - dateMillis(status.receivedAt) > 2 * 60 * 1000) return;
      const tiltStates = new Set(['SLIGHT_TILT', 'TILT_WARNING', 'TILTED', 'FLIPPED', 'INVERTED']);
      const active = tiltStates.has(String(status.state)) && Number(status.risk) > 0 && status.alarmLatched === true;
      const stateRef = db.collection('camera_alarm_state').doc(deviceId);
      const stateResult = await stateRef.get();
      const prior = Array.isArray(stateResult.data) ? stateResult.data[0] : stateResult.data;
      if (Boolean(prior?.active) === active) return;
      if (active) {
        await this.createCaptureCommand({
          commandId: `cc_${createHash('sha256').update(`${deviceId}:${sourceId}:${status.sequence}`).digest('hex').slice(0, 24)}`,
          deviceId,
          requestedCount: 3,
          source: 'tilt-alarm',
        });
      }
      await stateRef.set({ active, sourceDeviceId: sourceId, updatedAt: new Date(), sequence: status.sequence });
    },

    async listBatches({ page, pageSize, deviceId, status, startTime, endTime }) {
      const where = {};
      if (deviceId) where.deviceId = deviceId;
      if (status) where.status = status;
      if (startTime || endTime) {
        const command = db.command;
        if (startTime && endTime) where.capturedAt = command.gte(new Date(startTime)).and(command.lte(new Date(endTime)));
        else if (startTime) where.capturedAt = command.gte(new Date(startTime));
        else where.capturedAt = command.lte(new Date(endTime));
      }
      const query = db.collection('photo_batches').where(where);
      const [itemsResult, countResult, devicesResult] = await Promise.all([
        query.orderBy('createdAt', 'desc').skip((page - 1) * pageSize).limit(pageSize).get(),
        query.count(),
        db.collection('camera_devices').limit(100).get(),
      ]);
      const onlineThreshold = Date.now() - 5 * 60 * 1000;
      const onlineDevices = dataOf(devicesResult).filter((device) => dateMillis(device.lastSeenAt) >= onlineThreshold).length;
      return { items: dataOf(itemsResult), page, pageSize, total: Number(countResult.total || 0), onlineDevices };
    },

    async getBatchDetail(batchId) {
      const batch = await this.getBatch(batchId);
      if (!batch) return null;
      const result = await db.collection('photos').where({ batchId }).limit(5).get();
      const photos = dataOf(result).sort((left, right) => Number(left.sequence) - Number(right.sequence));
      if (!photos.length) return { ...batch, photos: [] };
      const temporary = await app.getTempFileURL({
        fileList: photos.map((photo) => ({ fileID: photo.storageFileId, maxAge: urlTtlSeconds })),
      });
      const urlById = new Map((temporary.fileList || []).map((item) => [item.fileID, item.tempFileURL]));
      return {
        ...batch,
        photos: photos.map((photo) => ({ ...photo, previewUrl: urlById.get(photo.storageFileId) || null,
          previewError: urlById.get(photo.storageFileId) ? null : 'private storage did not return a preview URL' })),
      };
    },
  };
}

export function createCloudBasePhotoRepositoryFromEnv(env = process.env) {
  const options = {};
  if (env.CLOUDBASE_ENV_ID) options.env = env.CLOUDBASE_ENV_ID;
  if (env.CLOUDBASE_APIKEY) options.accessKey = env.CLOUDBASE_APIKEY;
  const app = cloudbase.init(options);
  return createCloudBasePhotoRepository(app);
}
