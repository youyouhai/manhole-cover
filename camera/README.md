# GOOUUU ESP32-S3-CAM 照片采集固件

适用硬件：照片所示 GOOUUU ESP32-S3-CAM V1.5、ESP32-S3-WROOM-1 N16R8、OV2640。

当前里程碑已实现：

- OV2640 JPEG 拍照。
- 有配置时优先连接手机或电脑的 2.4 GHz 热点；断线后持续重连，20 秒后同时开启备用 AP。
- 未配置或连接失败时启动测试 AP。
- 浏览器立即拍摄一张照片。
- BOOT 键或网页按钮触发一批 3 张照片。
- 最近一批照片保存在 PSRAM，并在浏览器中展示。
- 非阻塞批次状态机、按键消抖、Wi-Fi 自动重连和 JSON 状态接口。

现已接入 CloudBase 私有照片 API：BOOT 或本地网页 1/3/5 张连拍后自动创建批次、上传 JPEG、完成批次；公网网页可下发拍照指令，相机每 3 秒轮询领取。热点暂时断开时会保留当前拍摄批次，连上后重试创建批次。HTTPS 使用内嵌的受信任根证书集合，不关闭证书校验。

首次烧录新版前，在当前 `camera` 目录运行 `python provision_token.py`：脚本从相邻 `project/cloudbase/.photo-device-token.local.txt` 复制设备专用令牌至被 Git 忽略的 `include/device_token.h`，不会在终端打印令牌。若目录不相邻，请手工在 `include/secrets.h` 设置 `PHOTO_DEVICE_TOKEN`。不要把令牌写进网页。运行 `pio run` 后核对串口端口确属相机，再执行 `pio run -t upload --upload-port COMx`。仅能识别端口号而不能辨认设备时不要盲刷，避免覆盖倾斜传感器固件。

照片 API 地址在 `include/app_config.h` 的 `kPhotoApiBase`。本地 `/status` 的 `hotspotConnected`、`hotspotIp`、`setupApIp`、`cloudConfigured` 和 `cloudStatus` 可用来排查热点联网、NTP 时间、设备令牌、HTTPS 或上传失败；串口也会打印各张照片的 HTTP 状态码。`/capture` 只返回本地单张预览，不上传云端；云端上传请使用 `/batch?count=1|3|5` 或网页按钮。热点断开 20 秒会出现备用 AP `ESP32-S3-CAM-SETUP`，连接后可访问 `http://192.168.4.1/`，但备用 AP 本身不提供云端网络，须让相机重新连到有互联网的热点才可从公网网页控制。

## 1. 开发环境

推荐使用 VS Code + PlatformIO。项目以 Arduino-ESP32 框架构建，不依赖第三方库。

当前执行环境未安装 PlatformIO，因此首次构建会先下载 ESP32 平台和 Arduino 框架。

## 2. 配置手机或电脑热点

复制配置模板：

```powershell
Copy-Item include/secrets.example.h include/secrets.h
```

编辑 `include/secrets.h`：

```cpp
#define WIFI_SSID "你的2.4GHz热点名称"
#define WIFI_PASSWORD "你的热点密码"
#define DEVICE_NAME "goouuu-cam-001"
```

`include/secrets.h` 已被 `.gitignore` 忽略。不要把真实热点密码提交到仓库。

Windows 热点必须打开互联网共享，并优先选择 2.4 GHz 频段。

## 3. 无热点的首次相机测试

不创建 `secrets.h` 也能启动。设备会建立：

- Wi-Fi：`ESP32-S3-CAM-SETUP`
- 密码：`camera123`
- 页面：`http://192.168.4.1/`

手机或电脑连接该 Wi-Fi 后打开页面即可测试。

## 4. 构建、烧录和串口监视

```powershell
pio run
pio run -t upload
pio device monitor
```

建议先把 USB 线插在板载 `OTG` 接口。如果系统没有出现串口，可尝试：

1. 按住 BOOT。
2. 短按 RST。
3. 松开 BOOT。
4. 重新执行上传。

照片中的上方接口标为 `TTL`，下方接口标为 `OTG`。使用 TTL 接口烧录时可能需要额外 USB 转串口电路；优先尝试 OTG。

## 5. 使用方式

启动后在 115200 波特率串口中查找；新版固件每 15 秒也会重复打印当前热点 IP，因此无需抢开机瞬间的日志：

```text
[wifi] open http://x.x.x.x/
```

浏览器访问该地址：

- “立即拍一张”：直接返回最新 JPEG。
- “采集一批照片”：采集默认 3 张。
- 板载 BOOT 键：按一下采集默认 3 张。

不要在上电或按 RST 时按住 BOOT，否则芯片会进入下载模式。

## 6. 本地接口

| 方法 | 地址 | 作用 |
|---|---|---|
| GET | `/` | 测试页面和最近照片 |
| GET | `/capture` | 实时拍一张 JPEG |
| POST | `/batch` | 启动一次批量采集 |
| GET | `/photo?slot=0` | 获取批次中的指定照片 |
| GET | `/status` | 相机、网络和批次 JSON 状态 |
| GET | `/health` | 健康检查 |

## 7. 可调整参数

在 `include/app_config.h` 中调整：

- `kCaptureCount`：3～5。
- `kCaptureIntervalMs`：连拍间隔。
- `kFrameSizeWithPsram`：默认 VGA 640×480。
- `kJpegQualityWithPsram`：数值越小质量越高、文件越大。

若画面倒置，可在 `src/main.cpp` 中把 `set_vflip` 或 `set_hmirror` 改为 `1`。

## 8. 硬件引脚

| OV2640 信号 | GPIO |
|---|---:|
| SIOD/SDA | 4 |
| SIOC/SCL | 5 |
| VSYNC | 6 |
| HREF | 7 |
| XCLK | 15 |
| PCLK | 13 |
| D0～D7 | 11, 9, 8, 10, 12, 18, 17, 16 |
| BOOT/采集键 | 0 |

该映射与 Espressif Arduino CameraWebServer 示例中的 ESP32-S3-EYE/Freenove 配置一致，也与 GOOUUU 板的公开引脚资料吻合。

## 9. 下一里程碑

实机确认相机可以稳定拍照后再实施：

1. 网站设备 API 和设备凭证配置。
2. 创建云端批次。
3. 按顺序上传 3～5 张 JPEG。
4. 每张最多重试 3 次并保持 `batchId + sequence` 幂等。
5. 上报批次完成状态。
