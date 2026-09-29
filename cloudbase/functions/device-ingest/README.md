# M100PG 设备接收函数

HTTP 云函数接收两类数据：

- ESP32-S3 通过 UART 交给 M100PG 转发的井盖传感器报文。
- M100PG 内置多星座 GNSS 主动上报的定位报文。

## 公网接口

```text
POST https://smart-manhole-demo-d4cxwdfdf3c12.service.tcloudbase.com/api/v1/device/telemetry
```

请求头：

```text
Content-Type: text/plain; charset=utf-8
X-Device-Token: 与 DEVICE_TOKEN_MH001 相同的设备令牌
```

若 DTU 固件不支持自定义 HTTP 请求头，可将同一个设备令牌放入 URL：

```text
/api/v1/device/telemetry?token=<DEVICE_TOKEN_MH001 的值>
```

请求头方式优先；URL 方式仅用于此类受限设备，令牌不得截图或公开。

正常响应示例：

```text
ACK,7
```

## 定位报文

推荐使用包含定位方式和上报周期的 9 字段格式：

```text
V1,G,<设备编号>,<GPS或LBS>,<周期秒>,E,<经度>,N,<纬度>
```

M100PG 基站定位每 20 秒上报时，“主动上报内容”必须填写：

```text
V1,G,MH001,LBS,20,E,${LBSLON},N,${LBSLAT}
```

GPS 定位每 20 秒上报时才使用 GPS 变量：

```text
V1,G,MH001,GPS,20,E,${GPSLON},N,${GPSLAT}
```

服务端仍兼容旧的 7 字段报文 `V1,G,MH001,E,<经度>,N,<纬度>`，但旧格式不包含定位方式和上报周期，网页无法据此自动识别这两个字段。

## CloudBase 环境变量

必须配置：

- `DEVICE_TOKEN_MH001`：MH001 的独立上传令牌。

启用数据库写入时还需配置：

- CloudBase 云函数内使用当前环境的内置身份访问数据库，无需配置 API Key。
- 仅在 CloudBase 之外本地运行时，才按需配置 `CLOUDBASE_ENV_ID` 和服务端凭据。

## 数据集合

- `sensors`：传感器历史，记录 `receivedAt` 和7天后的 `expiresAt`。
- `locations`：定位历史，记录 GPS/LBS 模式、上报周期、`receivedAt` 和7天后的 `expiresAt`。
- `device_status`：以设备 ID 为文档 ID，保存最新传感器状态。
- `device_locations`：以设备 ID 为文档 ID，保存最新定位和 GeoPoint。

## 本地测试

```powershell
$env:DEVICE_TOKEN_MH001='replace-with-a-long-random-token'
npm test
npm start
```

测试请求：

```powershell
$headers=@{'X-Device-Token'='replace-with-a-long-random-token'}
$body='V1,S,MH001,7,60000,2,TILT_WARNING,21.35,1,18.60,1,1.24,BOTH_PRESENT,1,1,1,1,0'
Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:9000/api/v1/device/telemetry' -Headers $headers -ContentType 'text/plain' -Body $body
```

## M100PG HTTP 配置

- 网络通信协议：HTTP
- 绑定通讯串口：UART
- 请求方法：POST
- 服务器地址：`smart-manhole-demo-d4cxwdfdf3c12.service.tcloudbase.com`
- 服务器端口：`443`
- 请求 URL：支持自定义头部时使用 `/api/v1/device/telemetry`；不支持时使用
  `/api/v1/device/telemetry?token=<DEVICE_TOKEN_MH001 的值>`
- 自定义头部：固件支持时添加 `X-Device-Token`，否则无需添加
- SSL：加密
- UART：115200、8 数据位、无校验、1 停止位
- 打包超时时间：80 ms
- 心跳包：关闭（避免把 `00` 当成无效传感器报文发送到接口）

## ESP32-S3 与 M100PG 接线

使用M100PG测试底板时，模块由测试底板的DC 5～12V接口单独供电，ESP32-S3继续通过自身USB供电；两块板只共地，不要用ESP32的3.3V脚给M100PG供电。

| ESP32-S3 | M100PG测试底板 | 作用 |
|---|---|---|
| GPIO11（TX） | M_RXD/RXD | ESP32传感器报文发给M100PG |
| GPIO12（RX） | M_TXD/TXD | M100PG响应回传给ESP32 |
| GND | GND | 共地 |

正式连接ESP32前应拔掉测试底板的 `M_TXD`、`M_RXD` USB-TTL跳帽，避免板载USB-TTL与ESP32同时驱动模块串口。4G天线、GPS天线和SIM卡保持正确连接。

ESP32每20秒发送一次 `V1,S,...` 传感器快照；倾角、霍尔、水位有效性或报警状态发生变化时，会在最短1秒间隔后立即补发。M100PG透明转发到同一个HTTP接口，服务端按 `V1,S` 和 `V1,G` 自动区分传感器与定位数据。

如果当前 DTU 固件不能添加自定义请求头，需要改用 URL 中的设备签名或请求体签名，不能直接取消设备认证。
