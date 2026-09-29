# CloudBase 初始化清单

首次部署前在环境 `smart-manhole-demo-d4cxwdfdf3c12` 中确认：

1. 建立集合 `photo_batches`、`photos`、`camera_devices`。
2. 建立 README 中列出的查询索引；`photos(batchId, sequence)` 设为唯一索引。
3. 三个集合禁止匿名写入，管理页面只通过登录鉴权后的照片 API 查询。
4. 云存储目录 `photo-collection/` 保持私有，不配置永久公网读权限。
5. 在 `photo-api` 函数中配置 `.env.example` 所列变量和真实设备令牌。
6. HTTP 访问服务将 `/photo-api/*`（或环境提供的函数默认路径）转发到 `photo-api`，并保留原始子路径。

数据无需预先插入；设备首次创建批次时会自动写入相机设备、批次和照片元数据。
