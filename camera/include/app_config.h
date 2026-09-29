#pragma once

#include <Arduino.h>

// Copy secrets.example.h to secrets.h and fill it locally. secrets.h is ignored
// by Git. The firmware still builds without it and starts a setup/test AP.
#if __has_include("secrets.h")
#include "secrets.h"
#endif

#if __has_include("device_token.h")
#include "device_token.h"
#endif

#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif

#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif

#ifndef DEVICE_NAME
#define DEVICE_NAME "goouuu-cam-001"
#endif

#ifndef PHOTO_DEVICE_TOKEN
#define PHOTO_DEVICE_TOKEN ""
#endif

namespace AppConfig {
constexpr uint32_t kSerialBaud = 115200;
constexpr uint32_t kWifiConnectTimeoutMs = 20000;
constexpr uint32_t kWifiReconnectIntervalMs = 10000;
constexpr uint32_t kWifiFallbackAfterDisconnectMs = 20000;
constexpr uint32_t kCommandPollIntervalMs = 3000;
constexpr char kPhotoApiBase[] = "https://smart-manhole-demo-d4cxwdfdf3c12.service.tcloudbase.com/photo-api";

constexpr char kFallbackApSsid[] = "ESP32-S3-CAM-SETUP";
constexpr char kFallbackApPassword[] = "camera123";

constexpr uint8_t kCaptureCount = 3;       // Default BOOT capture count
constexpr uint32_t kCaptureIntervalMs = 500;
constexpr uint32_t kButtonDebounceMs = 60;
constexpr uint32_t kSensorLinkBaud = 115200;
// Coalesce tilt and cover-removal messages raised by the same physical event.
constexpr uint32_t kAlarmCaptureCoalesceMs = 15000;

constexpr framesize_t kFrameSizeWithPsram = FRAMESIZE_VGA;
constexpr framesize_t kFrameSizeWithoutPsram = FRAMESIZE_QVGA;
constexpr uint8_t kJpegQualityWithPsram = 12;
constexpr uint8_t kJpegQualityWithoutPsram = 15;
}  // namespace AppConfig

static_assert(AppConfig::kCaptureCount >= 3 && AppConfig::kCaptureCount <= 5,
              "Capture count must be between 3 and 5");
