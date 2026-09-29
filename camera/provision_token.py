"""Copy the camera-only API token into an ignored local firmware header.

No token bytes are printed. This keeps the device credential out of the
tracked example configuration and the browser bundle.
"""

from pathlib import Path


root = Path(__file__).resolve().parent
source = root.parent / "project" / "cloudbase" / ".photo-device-token.local.txt"
target = root / "include" / "device_token.h"
token = source.read_text(encoding="utf-8-sig").strip()
if len(token) < 24 or any(character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for character in token):
    raise SystemExit("Local camera token is missing or has an unexpected format")
target.write_text(f'#pragma once\n#define PHOTO_DEVICE_TOKEN "{token}"\n', encoding="utf-8")
print("Camera device credential provisioned in ignored include/device_token.h")
