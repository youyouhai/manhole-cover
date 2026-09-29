#include <Arduino.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_camera.h>
#include <esp_heap_caps.h>
#include <atomic>

#include "app_config.h"
#include "board_config.h"

namespace {

extern const uint8_t photo_ca_start[] asm("_binary_data_cert_x509_crt_bundle_bin_start");

constexpr size_t kMaxPhotos = 5;

struct StoredPhoto {
  uint8_t* data = nullptr;
  size_t length = 0;
  uint32_t capturedAtMs = 0;
};

struct CaptureBatch {
  std::atomic<bool> active{false};
  uint8_t targetCount = 0;
  uint8_t capturedCount = 0;
  uint32_t id = 0;
  uint32_t nextCaptureAtMs = 0;
};

WebServer server(80);
StoredPhoto photos[kMaxPhotos];
CaptureBatch batch;

struct QueuedCaptureCommand {
  char commandId[64];
  uint8_t count;
  bool accepted;
};

QueueHandle_t captureCommandQueue = nullptr;
QueueHandle_t commandAckQueue = nullptr;
portMUX_TYPE cloudStatusMux = portMUX_INITIALIZER_UNLOCKED;
char cloudStatusText[160] = "waiting";
bool cloudWorkerReady = false;

bool cameraReady = false;
bool fallbackApActive = false;
uint32_t lastWifiAttemptMs = 0;
uint32_t lastWifiStatusPrintMs = 0;
uint32_t wifiDisconnectedAtMs = 0;
uint32_t lastUploadAttemptMs = 0;
bool ntpConfigured = false;
uint32_t batchSequence = 0;
uint32_t lastCommandPollMs = 0;
std::atomic<bool> cloudUploadPending{false};
String lastCommandId;
bool startCaptureBatch(uint8_t count);

HardwareSerial sensorLinkSerial(1);
String sensorLinkBuffer;
bool alarmCapturePending = false;
bool alarmCaptureEverStarted = false;
uint32_t lastAlarmCaptureMs = 0;
String pendingAlarmReason;
String lastAlarmReason = "none";

void markAlarmCaptureStarted(const String& reason) {
  alarmCaptureEverStarted = true;
  lastAlarmCaptureMs = millis();
  lastAlarmReason = reason;
  Serial.printf("[sensor-link] alarm %s: 5-photo batch started\n",
                reason.c_str());
}

void scheduleAlarmCapture(const String& reason) {
  const uint32_t now = millis();
  if ((alarmCaptureEverStarted &&
       static_cast<uint32_t>(now - lastAlarmCaptureMs) <
           AppConfig::kAlarmCaptureCoalesceMs) ||
      alarmCapturePending) {
    Serial.printf("[sensor-link] alarm %s coalesced with current event\n",
                  reason.c_str());
    return;
  }

  if (startCaptureBatch(5)) {
    markAlarmCaptureStarted(reason);
    return;
  }

  alarmCapturePending = true;
  pendingAlarmReason = reason;
  Serial.printf("[sensor-link] alarm %s queued until camera is idle\n",
                reason.c_str());
}

void processSensorLink() {
  while (sensorLinkSerial.available() > 0) {
    const char ch = static_cast<char>(sensorLinkSerial.read());
    if (ch == '\r') continue;
    if (ch != '\n') {
      if (sensorLinkBuffer.length() < 80) sensorLinkBuffer += ch;
      continue;
    }

    sensorLinkBuffer.trim();
    if (sensorLinkBuffer.startsWith("CAPTURE,5,")) {
      const String reason = sensorLinkBuffer.substring(10);
      if (reason == "TILT" || reason == "COVER_REMOVED") {
        scheduleAlarmCapture(reason);
      } else {
        Serial.printf("[sensor-link] ignored unknown reason: %s\n",
                      reason.c_str());
      }
    } else if (sensorLinkBuffer.length() > 0) {
      Serial.printf("[sensor-link] ignored malformed command: %s\n",
                    sensorLinkBuffer.c_str());
    }
    sensorLinkBuffer = "";
  }

  if (alarmCapturePending && cameraReady && !batch.active &&
      !cloudUploadPending) {
    const String reason = pendingAlarmReason;
    if (startCaptureBatch(5)) {
      alarmCapturePending = false;
      pendingAlarmReason = "";
      markAlarmCaptureStarted(reason);
    }
  }
}

void setCloudStatus(const String& status) {
  portENTER_CRITICAL(&cloudStatusMux);
  status.toCharArray(cloudStatusText, sizeof(cloudStatusText));
  portEXIT_CRITICAL(&cloudStatusMux);
}

String getCloudStatus() {
  char copy[sizeof(cloudStatusText)];
  portENTER_CRITICAL(&cloudStatusMux);
  memcpy(copy, cloudStatusText, sizeof(copy));
  portEXIT_CRITICAL(&cloudStatusMux);
  copy[sizeof(copy) - 1] = '\0';
  return String(copy);
}

String jsonString(const String& json, const char* key) {
  const String needle = String('"') + key + "\":\"";
  const int begin = json.indexOf(needle);
  if (begin < 0) return "";
  const int start = begin + needle.length();
  const int end = json.indexOf('"', start);
  return end > start ? json.substring(start, end) : "";
}

int jsonInteger(const String& json, const char* key) {
  const String needle = String('"') + key + "\":";
  const int begin = json.indexOf(needle);
  return begin < 0 ? 0 : json.substring(begin + needle.length()).toInt();
}

bool cloudConfigured() {
  return strlen(PHOTO_DEVICE_TOKEN) >= 24 && WiFi.status() == WL_CONNECTED && time(nullptr) > 1700000000;
}

bool cloudRequest(const String& path, const String& method, const uint8_t* body,
                  size_t bodyLength, const String& contentType, int& code, String& response) {
  WiFiClientSecure client;
  client.setCACertBundle(photo_ca_start);
  client.setTimeout(15000);
  HTTPClient http;
  if (!http.begin(client, String(AppConfig::kPhotoApiBase) + path)) return false;
  http.setTimeout(15000);
  http.addHeader("Authorization", String("Bearer ") + PHOTO_DEVICE_TOKEN);
  http.addHeader("X-Device-Id", DEVICE_NAME);
  if (contentType.length()) http.addHeader("Content-Type", contentType);
  if (method == "GET") code = http.GET();
  else code = http.POST(const_cast<uint8_t*>(body), bodyLength);
  response = code > 0 ? http.getString() : http.errorToString(code);
  http.end();
  return code >= 200 && code < 300;
}

bool uploadOnePhoto(const String& batchId, size_t slot) {
  const String boundary = "camera-photo-boundary";
  const String prefix = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"sequence\"\r\n\r\n" + String(slot + 1) +
    "\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"capture.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n";
  const String suffix = "\r\n--" + boundary + "--\r\n";
  const size_t length = prefix.length() + photos[slot].length + suffix.length();
  if (photos[slot].length > 1024 * 1024) return false;
  uint8_t* payload = static_cast<uint8_t*>(heap_caps_malloc(length, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!payload) return false;
  memcpy(payload, prefix.c_str(), prefix.length());
  memcpy(payload + prefix.length(), photos[slot].data, photos[slot].length);
  memcpy(payload + prefix.length() + photos[slot].length, suffix.c_str(), suffix.length());
  int code = 0;
  String response;
  const bool ok = cloudRequest("/api/device/v1/photo-batches/" + batchId + "/photos", "POST",
    payload, length, "multipart/form-data; boundary=" + boundary, code, response);
  heap_caps_free(payload);
  Serial.printf("[cloud] photo %u HTTP %d: %s\n", static_cast<unsigned>(slot + 1), code, response.c_str());
  return ok;
}

void uploadCurrentBatch() {
  if (!cloudConfigured()) {
    setCloudStatus("waiting for hotspot, clock and device token");
    return;
  }
  lastUploadAttemptMs = millis();
  const String createBody = "{\"requestedCount\":" + String(batch.targetCount) + ",\"firmwareVersion\":\"cam-0.2.0\"}";
  int code = 0;
  String response;
  if (!cloudRequest("/api/device/v1/photo-batches", "POST",
      reinterpret_cast<const uint8_t*>(createBody.c_str()), createBody.length(), "application/json", code, response)) {
    setCloudStatus("create batch HTTP " + String(code));
    Serial.printf("[cloud] create failed HTTP %d: %s\n", code, response.c_str());
    return;
  }
  const String batchId = jsonString(response, "batchId");
  if (!batchId.startsWith("pb_")) { setCloudStatus("invalid batch response"); return; }
  setCloudStatus("uploading 0/" + String(batch.targetCount));
  unsigned successful = 0;
  for (size_t slot = 0; slot < batch.capturedCount; ++slot) {
    for (uint8_t attempt = 0; attempt < 3; ++attempt) {
      if (uploadOnePhoto(batchId, slot)) { ++successful; break; }
      delay(700 * (attempt + 1));
    }
    setCloudStatus("uploading " + String(successful) + "/" + String(batch.targetCount));
  }
  const String completeBody = "{\"attemptedCount\":" + String(batch.targetCount) + "}";
  cloudRequest("/api/device/v1/photo-batches/" + batchId + "/complete", "POST",
    reinterpret_cast<const uint8_t*>(completeBody.c_str()), completeBody.length(), "application/json", code, response);
  const String finalStatus = "batch " + batchId + ": " + String(successful) + "/" + String(batch.targetCount) + " uploaded";
  setCloudStatus(finalStatus);
  cloudUploadPending = false;
  Serial.printf("[cloud] %s, completion HTTP %d\n", finalStatus.c_str(), code);
}

void pollCaptureCommand() {
  if (!captureCommandQueue || !cloudConfigured() || batch.active || cloudUploadPending ||
      uxQueueMessagesWaiting(captureCommandQueue) != 0 ||
      millis() - lastCommandPollMs < AppConfig::kCommandPollIntervalMs) return;
  lastCommandPollMs = millis();
  int code = 0;
  String response;
  if (!cloudRequest("/api/device/v1/capture-command", "GET", nullptr, 0, "", code, response)) {
    setCloudStatus("command poll HTTP " + String(code));
    return;
  }
  const String commandId = jsonString(response, "commandId");
  const int count = jsonInteger(response, "requestedCount");
  if (!commandId.startsWith("cc_") || (count != 1 && count != 3 && count != 5)) return;
  if (commandId == lastCommandId) return;
  QueuedCaptureCommand command{};
  commandId.toCharArray(command.commandId, sizeof(command.commandId));
  command.count = static_cast<uint8_t>(count);
  if (xQueueSend(captureCommandQueue, &command, 0) == pdTRUE) {
    lastCommandId = commandId;
  }
}

void processQueuedCaptureCommand() {
  if (!captureCommandQueue || !commandAckQueue) return;
  QueuedCaptureCommand command{};
  if (xQueueReceive(captureCommandQueue, &command, 0) != pdTRUE) return;
  command.accepted = startCaptureBatch(command.count);
  xQueueSend(commandAckQueue, &command, 0);
}

void cloudWorker(void*) {
  for (;;) {
    QueuedCaptureCommand command{};
    if (xQueueReceive(commandAckQueue, &command, 0) == pdTRUE) {
      if (command.accepted) {
        int code = 0;
        String ack;
        const bool ok = cloudRequest(String("/api/device/v1/capture-command/") + command.commandId + "/ack",
                                     "POST", nullptr, 0, "application/json", code, ack);
        Serial.printf("[cloud] command %s accepted, ACK HTTP %d\n", command.commandId, code);
        if (!ok) setCloudStatus("command ACK HTTP " + String(code));
      } else {
        lastCommandId = "";
      }
    }

    if (cloudUploadPending && !batch.active &&
        (lastUploadAttemptMs == 0 || millis() - lastUploadAttemptMs >= 10000)) {
      lastUploadAttemptMs = millis();
      uploadCurrentBatch();
    } else {
      pollCaptureCommand();
    }
    vTaskDelay(pdMS_TO_TICKS(30));
  }
}

bool rawButtonState = HIGH;
bool stableButtonState = HIGH;
uint32_t lastButtonChangeMs = 0;

void clearStoredPhotos() {
  for (auto& photo : photos) {
    if (photo.data != nullptr) {
      heap_caps_free(photo.data);
      photo.data = nullptr;
    }
    photo.length = 0;
    photo.capturedAtMs = 0;
  }
}

bool initializeCamera() {
  camera_config_t config{};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = CAM_PIN_D0;
  config.pin_d1 = CAM_PIN_D1;
  config.pin_d2 = CAM_PIN_D2;
  config.pin_d3 = CAM_PIN_D3;
  config.pin_d4 = CAM_PIN_D4;
  config.pin_d5 = CAM_PIN_D5;
  config.pin_d6 = CAM_PIN_D6;
  config.pin_d7 = CAM_PIN_D7;
  config.pin_xclk = CAM_PIN_XCLK;
  config.pin_pclk = CAM_PIN_PCLK;
  config.pin_vsync = CAM_PIN_VSYNC;
  config.pin_href = CAM_PIN_HREF;
  config.pin_sccb_sda = CAM_PIN_SIOD;
  config.pin_sccb_scl = CAM_PIN_SIOC;
  config.pin_pwdn = CAM_PIN_PWDN;
  config.pin_reset = CAM_PIN_RESET;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size = AppConfig::kFrameSizeWithPsram;
    config.jpeg_quality = AppConfig::kJpegQualityWithPsram;
    config.fb_count = 2;
    config.grab_mode = CAMERA_GRAB_LATEST;
    config.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    config.frame_size = AppConfig::kFrameSizeWithoutPsram;
    config.jpeg_quality = AppConfig::kJpegQualityWithoutPsram;
    config.fb_count = 1;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
    config.fb_location = CAMERA_FB_IN_DRAM;
  }

  const esp_err_t error = esp_camera_init(&config);
  if (error != ESP_OK) {
    Serial.printf("[camera] initialization failed: 0x%04x\n", error);
    return false;
  }

  sensor_t* sensor = esp_camera_sensor_get();
  if (sensor != nullptr) {
    // Keep orientation neutral by default. Adjust these two values if the
    // installed camera is physically inverted.
    sensor->set_vflip(sensor, 0);
    sensor->set_hmirror(sensor, 0);
  }

  Serial.printf("[camera] ready, PSRAM: %s, free PSRAM: %u bytes\n",
                psramFound() ? "yes" : "no",
                static_cast<unsigned>(ESP.getFreePsram()));
  return true;
}

String deviceAddress() {
  if (fallbackApActive) {
    return WiFi.softAPIP().toString();
  }
  return WiFi.localIP().toString();
}

void startFallbackAccessPoint() {
  if (fallbackApActive) return;
  WiFi.mode(WIFI_AP_STA);
  fallbackApActive = WiFi.softAP(AppConfig::kFallbackApSsid,
                                 AppConfig::kFallbackApPassword);
  if (fallbackApActive) {
    Serial.printf("[wifi] setup AP: %s\n", AppConfig::kFallbackApSsid);
    Serial.printf("[wifi] open http://%s/\n", WiFi.softAPIP().toString().c_str());
  } else {
    Serial.println("[wifi] failed to start setup AP");
  }
}

void connectWifi() {
  if (strlen(WIFI_SSID) == 0) {
    Serial.println("[wifi] no hotspot configured; starting setup AP");
    startFallbackAccessPoint();
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(DEVICE_NAME);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  const uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED &&
         millis() - startedAt < AppConfig::kWifiConnectTimeoutMs) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    fallbackApActive = false;
    wifiDisconnectedAtMs = 0;
    configTime(0, 0, "ntp.aliyun.com", "pool.ntp.org");
    ntpConfigured = true;
    Serial.printf("[wifi] connected, RSSI: %d dBm\n", WiFi.RSSI());
    Serial.printf("[wifi] open http://%s/\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("[wifi] hotspot connection timed out");
    wifiDisconnectedAtMs = millis();
    startFallbackAccessPoint();
  }
}

bool storeOnePhoto(size_t slot) {
  if (!cameraReady || slot >= kMaxPhotos) {
    return false;
  }

  camera_fb_t* frame = nullptr;
  for (uint8_t attempt = 0; attempt < 3 && frame == nullptr; ++attempt) {
    frame = esp_camera_fb_get();
    if (frame == nullptr) delay(80);
  }
  if (frame == nullptr) {
    Serial.println("[camera] frame capture failed");
    return false;
  }

  uint8_t* copy = static_cast<uint8_t*>(
      heap_caps_malloc(frame->len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (copy == nullptr) {
    copy = static_cast<uint8_t*>(heap_caps_malloc(frame->len, MALLOC_CAP_8BIT));
  }

  if (copy == nullptr) {
    Serial.printf("[camera] cannot allocate %u bytes for photo\n",
                  static_cast<unsigned>(frame->len));
    esp_camera_fb_return(frame);
    return false;
  }

  memcpy(copy, frame->buf, frame->len);
  const size_t frameLength = frame->len;
  esp_camera_fb_return(frame);

  if (photos[slot].data != nullptr) {
    heap_caps_free(photos[slot].data);
  }
  photos[slot].data = copy;
  photos[slot].length = frameLength;
  photos[slot].capturedAtMs = millis();

  Serial.printf("[camera] stored photo %u, %u bytes\n",
                static_cast<unsigned>(slot + 1),
                static_cast<unsigned>(frameLength));
  return true;
}

bool startCaptureBatch(uint8_t count) {
  if (!cameraReady || batch.active || cloudUploadPending || (count != 1 && count != 3 && count != 5)) {
    return false;
  }

  clearStoredPhotos();
  batch.active = true;
  batch.targetCount = count;
  batch.capturedCount = 0;
  batch.id = ++batchSequence;
  batch.nextCaptureAtMs = millis();
  Serial.printf("[batch] #%u started, target: %u photos\n",
                static_cast<unsigned>(batch.id), count);
  return true;
}

void processCaptureBatch() {
  if (!batch.active || static_cast<int32_t>(millis() - batch.nextCaptureAtMs) < 0) {
    return;
  }

  const size_t slot = batch.capturedCount;
  if (storeOnePhoto(slot)) {
    ++batch.capturedCount;
  } else {
    Serial.printf("[batch] #%u stopped after capture failure\n",
                  static_cast<unsigned>(batch.id));
    batch.active = false;
    cloudUploadPending = batch.capturedCount > 0;
    setCloudStatus("camera capture failed after " + String(batch.capturedCount) +
                   "/" + String(batch.targetCount) + " photos");
    return;
  }

  if (batch.capturedCount >= batch.targetCount) {
    batch.active = false;
    cloudUploadPending = true;
    Serial.printf("[batch] #%u complete: %u/%u photos\n",
                  static_cast<unsigned>(batch.id), batch.capturedCount,
                  batch.targetCount);
    return;
  }

  batch.nextCaptureAtMs = millis() + AppConfig::kCaptureIntervalMs;
}

void processCaptureButton() {
  const bool reading = digitalRead(CAPTURE_BUTTON_PIN);
  const uint32_t now = millis();

  if (reading != rawButtonState) {
    rawButtonState = reading;
    lastButtonChangeMs = now;
  }

  if (now - lastButtonChangeMs < AppConfig::kButtonDebounceMs ||
      reading == stableButtonState) {
    return;
  }

  stableButtonState = reading;
  if (stableButtonState == LOW) {
    if (!startCaptureBatch(AppConfig::kCaptureCount)) {
      Serial.println("[button] capture ignored: camera unavailable or batch busy");
    }
  }
}

void processWifiReconnect() {
  if (WiFi.status() == WL_CONNECTED) {
    if (wifiDisconnectedAtMs != 0) {
      Serial.printf("[wifi] hotspot restored: http://%s/\n", WiFi.localIP().toString().c_str());
    }
    wifiDisconnectedAtMs = 0;
    if (!ntpConfigured) {
      configTime(0, 0, "ntp.aliyun.com", "pool.ntp.org");
      ntpConfigured = true;
    }
    return;
  }
  ntpConfigured = false;
  if (strlen(WIFI_SSID) == 0) return;

  const uint32_t now = millis();
  if (wifiDisconnectedAtMs == 0) wifiDisconnectedAtMs = now;
  if (!fallbackApActive && now - wifiDisconnectedAtMs >= AppConfig::kWifiFallbackAfterDisconnectMs) {
    startFallbackAccessPoint();
  }
  if (now - lastWifiAttemptMs >= AppConfig::kWifiReconnectIntervalMs) {
    lastWifiAttemptMs = now;
    Serial.println("[wifi] retrying hotspot connection");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

void printWifiStatusPeriodically() {
  const uint32_t now = millis();
  if (now - lastWifiStatusPrintMs < 15000) return;
  lastWifiStatusPrintMs = now;
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] hotspot connected; open http://%s/; RSSI=%d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else if (fallbackApActive) {
    Serial.printf("[wifi] phone hotspot offline; setup AP http://%s/\n",
                  WiFi.softAPIP().toString().c_str());
  } else {
    Serial.println("[wifi] connecting to phone hotspot");
  }
}

String statusJson() {
  String json;
  json.reserve(320);
  json += F("{\"device\":\"");
  json += DEVICE_NAME;
  json += F("\",\"cameraReady\":");
  json += cameraReady ? F("true") : F("false");
  json += F(",\"networkMode\":\"");
  json += WiFi.status() == WL_CONNECTED ? F("phone-hotspot") : (fallbackApActive ? F("setup-ap") : F("connecting"));
  json += F("\",\"ip\":\"");
  json += deviceAddress();
  json += F("\",\"hotspotConnected\":");
  json += WiFi.status() == WL_CONNECTED ? F("true") : F("false");
  json += F(",\"hotspotIp\":\"");
  json += WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("");
  json += F("\",\"setupApIp\":\"");
  json += fallbackApActive ? WiFi.softAPIP().toString() : String("");
  json += F("\",\"batchId\":");
  json += batch.id;
  json += F(",\"batchActive\":");
  json += batch.active ? F("true") : F("false");
  json += F(",\"capturedCount\":");
  json += batch.capturedCount;
  json += F(",\"targetCount\":");
  json += batch.targetCount;
  json += F(",\"cloudConfigured\":");
  json += cloudConfigured() ? F("true") : F("false");
  json += F(",\"uploadPending\":");
  json += cloudUploadPending ? F("true") : F("false");
  json += F(",\"cloudStatus\":\"");
  json += getCloudStatus();
  json += '"';
  json += F(",\"sensorLinkReady\":true");
  json += F(",\"alarmCapturePending\":");
  json += alarmCapturePending ? F("true") : F("false");
  json += F(",\"lastAlarmReason\":\"");
  json += lastAlarmReason;
  json += '"';
  json += F(",\"freeHeap\":");
  json += ESP.getFreeHeap();
  json += F(",\"freePsram\":");
  json += ESP.getFreePsram();
  json += '}';
  return json;
}

void handleRoot() {
  static const char page[] PROGMEM = R"HTML(
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESP32-S3-CAM</title><style>
body{font-family:system-ui,sans-serif;max-width:960px;margin:32px auto;padding:0 16px;background:#f4f7fb;color:#172033}
.card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 5px 24px #17324d18;margin-bottom:18px}
button,a.btn{display:inline-block;border:0;border-radius:9px;padding:10px 16px;background:#1677ff;color:#fff;text-decoration:none;cursor:pointer;margin:4px}
#photos{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}img{width:100%;border-radius:10px;background:#e8edf3}.muted{color:#65758b}code{word-break:break-all}
</style></head><body><h1>ESP32-S3-CAM 照片测试</h1>
<div class="card"><p id="status">正在读取状态…</p>
<button onclick="captureBatch(1)">拍一张并上传</button><button onclick="captureBatch(3)">连拍 3 张</button><button onclick="captureBatch(5)">连拍 5 张</button><a class="btn" href="/capture" target="_blank">仅本地预览一张</a>
<p class="muted">也可以按开发板 BOOT 键采集。不要在复位或上电时按住 BOOT。</p></div>
<div class="card"><h2>最近一批</h2><div id="photos"></div></div>
<script>
let lastBatch=-1,lastRenderedCount=-1;
async function refresh(){try{const s=await fetch('/status').then(r=>r.json());
document.getElementById('status').textContent=`设备 ${s.device}｜手机热点 ${s.hotspotConnected?'已连接（'+s.hotspotIp+'）':'未连接'}${s.setupApIp?'｜备用 AP http://'+s.setupApIp+'/':''}｜相机 ${s.cameraReady?'正常':'异常'}｜批次 ${s.batchId}：${s.capturedCount}/${s.targetCount}${s.batchActive?'（采集中）':s.uploadPending?'（拍照完成，上传中）':''}｜云端 ${s.cloudConfigured?'已就绪':'等待联网/校时'}：${s.cloudStatus}`;
if(s.batchId!==lastBatch||s.capturedCount!==lastRenderedCount){lastBatch=s.batchId;lastRenderedCount=s.capturedCount;const p=document.getElementById('photos');p.innerHTML='';for(let i=0;i<s.capturedCount;i++){const img=document.createElement('img');img.src=`/photo?slot=${i}&v=${s.batchId}`;img.alt=`照片 ${i+1}`;p.appendChild(img);}}}catch(e){document.getElementById('status').textContent='状态读取失败：'+e;}}
async function captureBatch(count){const r=await fetch('/batch?count='+count,{method:'POST'});if(!r.ok)alert('相机忙或不可用');refresh();}
refresh();setInterval(refresh,1000);
</script></body></html>)HTML";
  server.send_P(200, "text/html; charset=utf-8", page);
}

void handleCapture() {
  if (!cameraReady) {
    server.send(503, "application/json", "{\"error\":\"camera_not_ready\"}");
    return;
  }

  camera_fb_t* frame = esp_camera_fb_get();
  if (frame == nullptr) {
    server.send(500, "application/json", "{\"error\":\"capture_failed\"}");
    return;
  }

  server.setContentLength(frame->len);
  server.send(200, "image/jpeg", "");
  WiFiClient client = server.client();
  client.write(frame->buf, frame->len);
  esp_camera_fb_return(frame);
}

void handleStoredPhoto() {
  if (!server.hasArg("slot")) {
    server.send(400, "application/json", "{\"error\":\"missing_slot\"}");
    return;
  }

  const int slot = server.arg("slot").toInt();
  if (slot < 0 || slot >= static_cast<int>(kMaxPhotos) ||
      photos[slot].data == nullptr) {
    server.send(404, "application/json", "{\"error\":\"photo_not_found\"}");
    return;
  }

  server.setContentLength(photos[slot].length);
  server.send(200, "image/jpeg", "");
  WiFiClient client = server.client();
  client.write(photos[slot].data, photos[slot].length);
}

void handleStartBatch() {
  const int count = server.hasArg("count") ? server.arg("count").toInt() : AppConfig::kCaptureCount;
  if (startCaptureBatch(static_cast<uint8_t>(count))) {
    server.send(202, "application/json", statusJson());
  } else {
    server.send(409, "application/json",
                "{\"error\":\"camera_unavailable_or_batch_busy\"}");
  }
}

void startWebServer() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/capture", HTTP_GET, handleCapture);
  server.on("/photo", HTTP_GET, handleStoredPhoto);
  server.on("/batch", HTTP_POST, handleStartBatch);
  server.on("/status", HTTP_GET,
            []() { server.send(200, "application/json", statusJson()); });
  server.on("/health", HTTP_GET,
            []() { server.send(cameraReady ? 200 : 503, "text/plain", cameraReady ? "ok" : "camera error"); });
  server.onNotFound([]() {
    server.send(404, "application/json", "{\"error\":\"not_found\"}");
  });
  server.begin();
  Serial.println("[http] server started on port 80");
}

}  // namespace

void setup() {
  Serial.begin(AppConfig::kSerialBaud);
  delay(1000);
  Serial.println();
  Serial.println("GOOUUU ESP32-S3-CAM photo collector");

  pinMode(CAPTURE_BUTTON_PIN, INPUT_PULLUP);
  rawButtonState = digitalRead(CAPTURE_BUTTON_PIN);
  stableButtonState = rawButtonState;
  sensorLinkBuffer.reserve(80);
  sensorLinkSerial.begin(AppConfig::kSensorLinkBaud, SERIAL_8N1,
                         SENSOR_LINK_RX_PIN, -1);
  Serial.printf("[sensor-link] ready: sensor GPIO13 TX -> camera GPIO%d RX, %lu 8N1\n",
                SENSOR_LINK_RX_PIN,
                static_cast<unsigned long>(AppConfig::kSensorLinkBaud));

  cameraReady = initializeCamera();
  connectWifi();
  startWebServer();
  captureCommandQueue = xQueueCreate(1, sizeof(QueuedCaptureCommand));
  commandAckQueue = xQueueCreate(1, sizeof(QueuedCaptureCommand));
  if (captureCommandQueue && commandAckQueue) {
    cloudWorkerReady = xTaskCreatePinnedToCore(cloudWorker, "camera-cloud", 16384,
                                                nullptr, 1, nullptr, 0) == pdPASS;
  }
  Serial.printf("[cloud] background worker: %s\n", cloudWorkerReady ? "ready" : "unavailable");
}

void loop() {
  server.handleClient();
  processSensorLink();
  processCaptureButton();
  processQueuedCaptureCommand();
  processCaptureBatch();
  if (!cloudWorkerReady) {
    if (cloudUploadPending && !batch.active &&
        (lastUploadAttemptMs == 0 || millis() - lastUploadAttemptMs >= 10000)) {
      lastUploadAttemptMs = millis();
      uploadCurrentBatch();
    }
    pollCaptureCommand();
  }
  processWifiReconnect();
  printWifiStatusPeriodically();
  delay(2);
}
