# ESP32-S3-CAM 照片采集 API

本函数与原有 `device-ingest`、`web-api` 完全分离，仅负责 `goouuu-cam-001` 的照片批次、JPEG 云存储及登录用户查询。

## 环境变量

| 名称 | 默认值 | 说明 |
|---|---:|---|
| `CLOUDBASE_ENV_ID` | 当前环境 | CloudBase 环境 ID |
| `CLOUDBASE_APIKEY` | 无 | Web 云函数访问数据库和云存储所需的服务端 API Key |
| `PHOTO_DEVICE_TOKENS_JSON` | 无 | 设备编号到独立令牌的 JSON 映射 |
| `PHOTO_STORAGE_PREFIX` | `photo-collection` | 私有云存储对象前缀 |
| `PHOTO_MAX_BYTES` | `1048576` | 单张 JPEG 最大字节数 |
| `PHOTO_URL_TTL_SECONDS` | `900` | 登录用户预览链接有效期 |

设备鉴权采用开发阶段 Bearer 令牌：

```http
Authorization: Bearer <设备独立令牌>
X-Device-Id: goouuu-cam-001
```

令牌只配置在 CloudBase 函数环境和相机本地忽略的固件头文件中，不进入网站前端、日志或 Git。正式量产可在不改变业务接口的情况下升级为 HMAC-SHA256 时间戳签名。

## 设备接口

### 创建批次

`POST /api/device/v1/photo-batches`

```json
{"requestedCount":3,"capturedAt":"2026-09-15T10:30:00+08:00","firmwareVersion":"0.1.0"}
```

### 上传单张

`POST /api/device/v1/photo-batches/{batchId}/photos`

`multipart/form-data` 字段：`sequence`、`capturedAt`、`photo`。仅接受扩展名 `.jpg/.jpeg`、MIME `image/jpeg` 且 JPEG 文件头尾正确的文件；默认上限 1 MiB。

### 完成批次

`POST /api/device/v1/photo-batches/{batchId}/complete`

```json
{"attemptedCount":3}
```

### 心跳

`POST /api/device/v1/heartbeat`

```json
{"firmwareVersion":"0.1.0","rssi":-55,"localIp":"192.168.137.20"}
```

### 相机领取远程指令

- `GET /api/device/v1/capture-command`：相机每 3 秒通过设备 Bearer 令牌轮询，响应 `{"command":null}` 或 `{"command":{"commandId":"cc_...","requestedCount":1|3|5,...}}`。
- `POST /api/device/v1/capture-command/{commandId}/ack`：开始拍照后确认领取。指令有效期 2 分钟。
- 设备按指令拍照后仍使用上述批次、JPEG 上传、完成三个接口。BOOT 键默认拍 3 张。

## 管理端接口

- `GET /api/admin/photo-batches?page=1&pageSize=20&deviceId=&status=&startTime=&endTime=`
- `GET /api/admin/photo-batches/{batchId}`
- `POST /api/admin/capture-command`，请求 `{"deviceId":"goouuu-cam-001","requestedCount":1|3|5}`，返回 HTTP 202 和指令编号。
- `POST /api/admin/photo-batches/delete`，请求 `{"batchIds":["pb_..."],"confirmation":"DELETE"}`；最多 20 个已完成批次，逐个删除其中 JPEG、照片记录和批次记录。返回已删批次、已删照片数及失败项。
- `POST /api/admin/photo-batches/{batchId}/photos/delete`，请求 `{"photoIds":["ph_..."],"confirmation":"DELETE"}`；最多 5 张，删除对应 JPEG 和照片记录，并重算批次成功/失败数量。

管理端必须携带网站登录后由 `cloudbaseAuth.getAccessToken()` 获取的用户 Access Token。服务端通过 CloudBase `/auth/v1/token/introspect` 验证，不接受设备令牌。详情接口只返回有效期 15 分钟的云存储临时预览 URL。
删除为不可恢复操作：仅允许登录用户提交确认字段；网页另有人工确认弹窗，只全选当前页/当前批次，上传中的批次不可删除。本地相机只保留最近一批最多 5 张，网页删除处理的是 CloudBase 云端数据。

## 数据库与存储

- `photo_batches`：批次元数据，文档 ID 等于 `batchId`。
- `photos`：照片元数据，文档 ID 由 `batchId + sequence` 确定，保证重试幂等。
- `camera_devices`：相机最近在线时间和固件信息。
- `camera_commands`：短期拍照指令；`camera_alarm_state`：MH001 已确认倾斜报警的边沿状态。首次请求会由云函数尝试创建集合，需给予该函数创建集合权限。
- 云存储路径：`photo-collection/{deviceId}/{yyyy}/{MM}/{dd}/{batchId}/{sequence}.jpg`。

建议在 CloudBase 控制台建立索引：

1. `photo_batches`: `createdAt` 降序。
2. `photo_batches`: `deviceId` 升序 + `createdAt` 降序。
3. `photo_batches`: `status` 升序 + `createdAt` 降序。
4. `photos`: `batchId` 升序 + `sequence` 升序（唯一）。
5. `camera_commands`: `deviceId` 升序 + `status` 升序 + `createdAt` 升序。

自动联动读取 `device_status/MH001`：仅在倾斜状态为 `SLIGHT_TILT`、`TILT_WARNING`、`TILTED`、`FLIPPED` 或 `INVERTED`、`risk > 0`、`alarmLatched === true`，且传感上报在最近 2 分钟内时，按从安全到报警的边沿下发一次 3 张连拍。水位异常、校准失败与传感器故障不会误触发相机。传感器固件本身的连续 10 秒确认逻辑不在本函数内修改。

集合应禁止匿名客户端写入；写入只由本云函数的服务端身份完成。云存储保持私有。

## 本地闭环测试

根目录 `scripts/test-device-upload.mjs` 可上传三张内置测试 JPEG，也可通过 `PHOTO_FILES` 指定三个以英文分号分隔的本地 JPEG 路径。令牌仅从环境变量读取。

## 部署与回滚

部署前运行 `npm test`。函数发布失败时保留原 `device-ingest` 与 `web-api`，删除/回滚 `photo-api` 不会影响 MH001。网站静态页面可回滚到 CloudBase 托管自动生成的上一个备份目录。
