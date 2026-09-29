#pragma once

// Copy this file to include/secrets.h, then edit the values.
// Use a 2.4 GHz hotspot; ESP32-S3 cannot connect to a 5 GHz-only hotspot.
#define WIFI_SSID "your-2.4GHz-hotspot"
#define WIFI_PASSWORD "your-hotspot-password"
#define DEVICE_NAME "goouuu-cam-001"
// Copy the camera-only token from cloudbase/.photo-device-token.local.txt.
// Never paste the token into a public webpage or a tracked source file.
#define PHOTO_DEVICE_TOKEN "paste-your-camera-device-token-here"
