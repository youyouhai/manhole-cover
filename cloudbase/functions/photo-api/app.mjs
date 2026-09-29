import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { MultipartError, parseMultipart } from './multipart.mjs';

const DEFAULT_MAX_PHOTO_BYTES = 1024 * 1024;
const JSON_LIMIT = 16 * 1024;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BATCH_ID_PATTERN = /^pb_[A-Za-z0-9_-]{8,64}$/;
const PHOTO_ID_PATTERN = /^ph_[0-9a-f]{24}$/;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    // CloudBase HTTP gateway owns CORS. Adding another Allow-Origin here makes
    // its valid origin response become "https://site.example,*", which browsers
    // reject with the misleading generic "Failed to fetch" error.
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'payload_too_large', 'request body exceeds the configured limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const bytes = await readBody(req, JSON_LIMIT);
  try {
    return bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
  } catch {
    throw new ApiError(400, 'invalid_json', 'request body must be valid JSON');
  }
}

function parseTokens(value = process.env.PHOTO_DEVICE_TOKENS_JSON) {
  if (!value) return new Map();
  const parsed = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('PHOTO_DEVICE_TOKENS_JSON must be a JSON object');
  return new Map(Object.entries(parsed).filter(([, token]) => typeof token === 'string' && token.length >= 24));
}

function constantTimeEqual(received, expected) {
  const a = Buffer.from(received || '', 'utf8');
  const b = Buffer.from(expected || '', 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireDevice(req, tokens) {
  const deviceId = String(req.headers['x-device-id'] || '');
  const authorization = String(req.headers.authorization || '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expected = tokens.get(deviceId);
  if (!DEVICE_ID_PATTERN.test(deviceId) || !expected || !constantTimeEqual(token, expected)) {
    throw new ApiError(401, 'unauthorized_device', 'device credentials are invalid');
  }
  return deviceId;
}

async function requireAdmin(req, options) {
  if (options.adminAuthorize) {
    const user = await options.adminAuthorize(req);
    if (!user) throw new ApiError(401, 'unauthorized_user', 'a signed-in CloudBase user is required');
    return user;
  }
  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Bearer ')) throw new ApiError(401, 'unauthorized_user', 'a signed-in CloudBase user is required');
  const envId = process.env.CLOUDBASE_ENV_ID;
  if (!envId) throw new ApiError(503, 'auth_not_configured', 'CloudBase authentication is not configured');
  const verification = await fetch(`https://${envId}.api.tcloudbasegateway.com/auth/v1/token/introspect`, {
    headers: { Authorization: authorization },
  });
  if (!verification.ok) throw new ApiError(401, 'unauthorized_user', 'the CloudBase session is invalid');
  const user = await verification.json();
  if (!user?.sub) throw new ApiError(401, 'unauthorized_user', 'the CloudBase session is invalid');
  return user;
}

function parseDate(value, fieldName) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) throw new ApiError(422, `invalid_${fieldName}`, `${fieldName} must be an ISO 8601 timestamp`);
  return date;
}

function makeBatchId(now = new Date()) {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `pb_${date}_${randomBytes(8).toString('hex')}`;
}

function isJpeg(bytes) {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
}

export function createPhotoApiServer(options = {}) {
  const repository = options.repository;
  if (!repository) throw new Error('photo repository is required');
  const tokens = options.tokens || parseTokens();
  const maxPhotoBytes = Number(options.maxPhotoBytes || process.env.PHOTO_MAX_BYTES || DEFAULT_MAX_PHOTO_BYTES);

  return createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname === '/photo-api'
      ? '/'
      : url.pathname.startsWith('/photo-api/') ? url.pathname.slice('/photo-api'.length) : url.pathname;

    try {
      if (req.method === 'GET' && path === '/health') {
        return sendJson(res, 200, { ok: true, service: 'photo-api', maxPhotoBytes });
      }

      if (req.method === 'POST' && path === '/api/device/v1/photo-batches') {
        const deviceId = requireDevice(req, tokens);
        const body = await readJson(req);
        const requestedCount = Number(body.requestedCount);
        if (![1, 3, 5].includes(requestedCount)) {
          throw new ApiError(422, 'invalid_requested_count', 'requestedCount must be 1, 3, or 5');
        }
        const now = new Date();
        const batch = {
          _id: makeBatchId(now),
          batchId: '',
          deviceId,
          requestedCount,
          successCount: 0,
          failedCount: 0,
          status: 'created',
          capturedAt: parseDate(body.capturedAt, 'capturedAt'),
          completedAt: null,
          firmwareVersion: String(body.firmwareVersion || '').slice(0, 64) || null,
          createdAt: now,
          updatedAt: now,
        };
        batch.batchId = batch._id;
        await repository.createBatch(batch);
        await repository.heartbeat(deviceId, { firmwareVersion: batch.firmwareVersion });
        return sendJson(res, 201, { batchId: batch.batchId, status: batch.status, maxPhotoBytes });
      }

      const photoMatch = path.match(/^\/api\/device\/v1\/photo-batches\/([^/]+)\/photos$/);
      if (req.method === 'POST' && photoMatch) {
        const deviceId = requireDevice(req, tokens);
        const batchId = decodeURIComponent(photoMatch[1]);
        if (!BATCH_ID_PATTERN.test(batchId)) throw new ApiError(404, 'batch_not_found', 'photo batch was not found');
        const batch = await repository.getBatch(batchId);
        if (!batch || batch.deviceId !== deviceId) throw new ApiError(404, 'batch_not_found', 'photo batch was not found');
        if (['completed', 'partial_failed', 'failed'].includes(batch.status)) throw new ApiError(409, 'batch_closed', 'photo batch is already closed');

        const raw = await readBody(req, maxPhotoBytes + 64 * 1024);
        const { fields, photo } = parseMultipart(raw, req.headers['content-type']);
        const sequence = Number(fields.sequence);
        if (!Number.isInteger(sequence) || sequence < 1 || sequence > batch.requestedCount) {
          throw new ApiError(422, 'invalid_sequence', 'sequence is outside this batch');
        }
        if (photo.mimeType !== 'image/jpeg' || !/\.jpe?g$/i.test(photo.filename) || !isJpeg(photo.bytes)) {
          throw new ApiError(415, 'invalid_photo_type', 'only a valid JPEG file is accepted');
        }
        if (photo.bytes.length > maxPhotoBytes) throw new ApiError(413, 'photo_too_large', `photo exceeds ${maxPhotoBytes} bytes`);

        const saved = await repository.savePhoto({
          batch,
          sequence,
          capturedAt: parseDate(fields.capturedAt, 'capturedAt'),
          bytes: photo.bytes,
          sha256: createHash('sha256').update(photo.bytes).digest('hex'),
        });
        await repository.heartbeat(deviceId, { firmwareVersion: batch.firmwareVersion });
        return sendJson(res, 200, { photoId: saved.photoId, batchId, sequence, status: 'uploaded' });
      }

      const completeMatch = path.match(/^\/api\/device\/v1\/photo-batches\/([^/]+)\/complete$/);
      if (req.method === 'POST' && completeMatch) {
        const deviceId = requireDevice(req, tokens);
        const batchId = decodeURIComponent(completeMatch[1]);
        const batch = await repository.getBatch(batchId);
        if (!batch || batch.deviceId !== deviceId) throw new ApiError(404, 'batch_not_found', 'photo batch was not found');
        const body = await readJson(req);
        const attemptedCount = Number(body.attemptedCount);
        if (!Number.isInteger(attemptedCount) || attemptedCount < 0 || attemptedCount > 5) {
          throw new ApiError(422, 'invalid_attempted_count', 'attemptedCount must be an integer from 0 to 5');
        }
        const completed = await repository.completeBatch(batchId, attemptedCount);
        await repository.heartbeat(deviceId, { firmwareVersion: batch.firmwareVersion });
        return sendJson(res, 200, completed);
      }

      if (req.method === 'POST' && path === '/api/device/v1/heartbeat') {
        const deviceId = requireDevice(req, tokens);
        const body = await readJson(req);
        await repository.heartbeat(deviceId, body);
        return sendJson(res, 200, { ok: true, deviceId, serverTime: new Date().toISOString() });
      }

      if (req.method === 'GET' && path === '/api/device/v1/capture-command') {
        const deviceId = requireDevice(req, tokens);
        await repository.heartbeat(deviceId, {});
        await repository.syncAlarmCapture?.(deviceId);
        const command = await repository.nextCaptureCommand(deviceId);
        return sendJson(res, 200, { command: command || null, serverTime: new Date().toISOString() });
      }

      const commandAck = path.match(/^\/api\/device\/v1\/capture-command\/([^/]+)\/ack$/);
      if (req.method === 'POST' && commandAck) {
        const deviceId = requireDevice(req, tokens);
        const commandId = decodeURIComponent(commandAck[1]);
        if (!/^cc_[A-Za-z0-9_-]{8,64}$/.test(commandId)) throw new ApiError(404, 'command_not_found', 'capture command was not found');
        const acknowledged = await repository.ackCaptureCommand(deviceId, commandId);
        if (!acknowledged) throw new ApiError(404, 'command_not_found', 'capture command was not found');
        return sendJson(res, 200, { ok: true, commandId });
      }

      if (req.method === 'POST' && path === '/api/admin/capture-command') {
        const user = await requireAdmin(req, options);
        const body = await readJson(req);
        const deviceId = String(body.deviceId || '');
        const requestedCount = Number(body.requestedCount);
        if (!DEVICE_ID_PATTERN.test(deviceId) || !tokens.has(deviceId)) throw new ApiError(422, 'invalid_device', 'camera device is not configured');
        if (![1, 3, 5].includes(requestedCount)) throw new ApiError(422, 'invalid_requested_count', 'requestedCount must be 1, 3, or 5');
        const command = await repository.createCaptureCommand({
          commandId: `cc_${randomBytes(12).toString('hex')}`,
          deviceId,
          requestedCount,
          source: 'web',
          requestedBy: String(user.sub),
        });
        return sendJson(res, 202, command);
      }

      const adminCommandMatch = path.match(/^\/api\/admin\/capture-command\/(cc_[A-Za-z0-9_-]{8,64})$/);
      if (req.method === 'GET' && adminCommandMatch) {
        await requireAdmin(req, options);
        const command = await repository.getCaptureCommand(adminCommandMatch[1]);
        if (!command) throw new ApiError(404, 'command_not_found', 'capture command was not found');
        const status = command.status === 'pending' && new Date(command.expiresAt).getTime() <= Date.now()
          ? 'expired' : command.status;
        return sendJson(res, 200, {
          commandId: command.commandId, deviceId: command.deviceId,
          requestedCount: command.requestedCount, status, source: command.source,
          createdAt: command.createdAt, acceptedAt: command.acceptedAt || null,
          expiresAt: command.expiresAt,
        });
      }

      if (req.method === 'GET' && path === '/api/admin/photo-batches') {
        await requireAdmin(req, options);
        const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
        const pageSize = Math.min(50, Math.max(1, Number(url.searchParams.get('pageSize')) || 20));
        const result = await repository.listBatches({
          page,
          pageSize,
          deviceId: url.searchParams.get('deviceId') || '',
          status: url.searchParams.get('status') || '',
          startTime: url.searchParams.get('startTime') || '',
          endTime: url.searchParams.get('endTime') || '',
        });
        return sendJson(res, 200, result);
      }

      if (req.method === 'POST' && path === '/api/admin/photo-batches/delete') {
        await requireAdmin(req, options);
        const body = await readJson(req);
        const batchIds = body.batchIds;
        if (body.confirmation !== 'DELETE' || !Array.isArray(batchIds) || batchIds.length < 1 ||
            batchIds.length > 20 || new Set(batchIds).size !== batchIds.length ||
            !batchIds.every((id) => typeof id === 'string' && BATCH_ID_PATTERN.test(id))) {
          throw new ApiError(422, 'invalid_delete_request', 'select 1 to 20 distinct batches and confirm deletion');
        }
        const deletedBatchIds = [];
        const failures = [];
        let deletedPhotoCount = 0;
        for (const batchId of batchIds) {
          try {
            const deleted = await repository.deleteBatch(batchId);
            if (!deleted) failures.push({ batchId, error: 'batch_not_found' });
            else {
              deletedBatchIds.push(batchId);
              deletedPhotoCount += deleted.deletedPhotoCount;
            }
          } catch (error) {
            console.error(JSON.stringify({ event: 'photo-api.delete-batch-failed', batchId,
              message: error instanceof Error ? error.message : String(error) }));
            failures.push({ batchId, error: 'delete_failed' });
          }
        }
        return sendJson(res, failures.length ? 207 : 200, { deletedBatchIds, deletedPhotoCount, failures });
      }

      const deletePhotosMatch = path.match(/^\/api\/admin\/photo-batches\/([^/]+)\/photos\/delete$/);
      if (req.method === 'POST' && deletePhotosMatch) {
        await requireAdmin(req, options);
        const batchId = decodeURIComponent(deletePhotosMatch[1]);
        const body = await readJson(req);
        const photoIds = body.photoIds;
        if (!BATCH_ID_PATTERN.test(batchId) || body.confirmation !== 'DELETE' ||
            !Array.isArray(photoIds) || photoIds.length < 1 || photoIds.length > 5 ||
            new Set(photoIds).size !== photoIds.length ||
            !photoIds.every((id) => typeof id === 'string' && PHOTO_ID_PATTERN.test(id))) {
          throw new ApiError(422, 'invalid_delete_request', 'select 1 to 5 distinct photos and confirm deletion');
        }
        const deleted = await repository.deletePhotos(batchId, photoIds);
        if (!deleted) throw new ApiError(404, 'photo_not_found', 'selected photos were not found in this batch');
        return sendJson(res, 200, deleted);
      }

      const detailMatch = path.match(/^\/api\/admin\/photo-batches\/([^/]+)$/);
      if (req.method === 'GET' && detailMatch) {
        await requireAdmin(req, options);
        const detail = await repository.getBatchDetail(decodeURIComponent(detailMatch[1]));
        if (!detail) throw new ApiError(404, 'batch_not_found', 'photo batch was not found');
        return sendJson(res, 200, detail);
      }

      throw new ApiError(404, 'not_found', 'route was not found');
    } catch (error) {
      if (error instanceof MultipartError) return sendJson(res, 400, { ok: false, error: 'invalid_multipart', message: error.message });
      if (error instanceof ApiError) return sendJson(res, error.status, { ok: false, error: error.code, message: error.message });
      console.error(JSON.stringify({ event: 'photo-api.error', message: error instanceof Error ? error.message : String(error) }));
      return sendJson(res, 500, { ok: false, error: 'internal_error', message: 'photo service is temporarily unavailable' });
    }
  });
}
