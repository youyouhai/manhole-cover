# ESP32-S3-CAM 照片接口交接（2026-09-16）

现有智能井盖网站已新增登录后的照片采集页面；原有 MH001 上报接口未修改。照片服务为独立的 `photo-api` HTTP 云函数。

- 公网网站：`https://smart-manhole-demo-d4cxwdfdf3c12-1474163882.tcloudbaseapp.com/`
- API 基础地址：`https://smart-manhole-demo-d4cxwdfdf3c12.service.tcloudbase.com/photo-api`
- 设备编号：`goouuu-cam-001`
- 设备鉴权：每次请求同时带 `Authorization: Bearer <设备令牌>` 和 `X-Device-Id: goouuu-cam-001`。测试令牌保存在项目根目录 `cloudbase/.photo-device-token.local.txt`，不提交 Git，也不放网页前端。
- 单张图片上限：1,048,576 字节（1 MiB）；只接受 `.jpg` / `.jpeg`、`image/jpeg` 且文件头尾符合 JPEG 特征。
- 一次批次：3～5 张。序号从 1 开始；相同批次和序号的重试幂等。
- HTTPS：必须使用上面的 HTTPS 域名，不使用 IP 作 TLS 主机名。ESP32 应启用 TLS 1.2 或更新版本、服务器证书校验、正确时间和可信根证书/证书包。不要关闭证书校验，也不要把云端 API 密钥烧进设备。

## 1. 创建批次

`POST {API基础地址}/api/device/v1/photo-batches`

```http
Authorization: Bearer <设备令牌>
X-Device-Id: goouuu-cam-001
Content-Type: application/json

{"requestedCount":3,"capturedAt":"2026-09-16T14:58:20+08:00","firmwareVersion":"camera/0.1.0"}
```

成功返回 `201`：

```json
{"batchId":"pb_20260916_93562115d33e243a","status":"created","maxPhotoBytes":1048576}
```

## 2. 上传单张照片

`POST {API基础地址}/api/device/v1/photo-batches/{batchId}/photos`

请求为 `multipart/form-data`，字段 `sequence`（1、2、3）、`capturedAt`（ISO 8601）、`photo`（JPEG 文件）。保留同样两个鉴权请求头；`Content-Type` 中的 boundary 由 HTTP 库自动生成。

成功返回 `200`，实测第 1 张：

```json
{"photoId":"ph_759f42d48933d5d221843c34","batchId":"pb_20260916_93562115d33e243a","sequence":1,"status":"uploaded"}
```

## 3. 完成批次

`POST {API基础地址}/api/device/v1/photo-batches/{batchId}/complete`

```http
Authorization: Bearer <设备令牌>
X-Device-Id: goouuu-cam-001
Content-Type: application/json

{"attemptedCount":3}
```

实测返回 `200`：

```json
{"batchId":"pb_20260916_93562115d33e243a","requestedCount":3,"successCount":3,"failedCount":0,"status":"completed","completedAt":"2026-09-16T14:58:32.013Z"}
```

设备上传完每张图后再调用完成接口。网站登录用户通过独立管理接口读取批次及 15 分钟有效的临时预览 URL；未登录请求实测返回 `401`。照片存储在 CloudBase 私有存储中。

本机 DNS 偶发解析失败；这属于开发机网络问题。联调脚本 `scripts/test-device-upload.mjs` 可设置 `PHOTO_API_IP` 作本地测试覆盖，ESP32 固件仍应使用正常域名解析和证书校验。
