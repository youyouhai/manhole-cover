#include <Arduino.h>

namespace WaterClearanceDemo {

// US-100 trigger/echo mode: remove the mode-selection jumper.
constexpr int TRIG_PIN = 16;
constexpr int ECHO_PIN = 17;

constexpr float MIN_MEASURABLE_CM = 2.0f;   // US-100 blind zone.
constexpr float MAX_DEMO_DISTANCE_CM = 80.0f;
constexpr uint32_t ECHO_TIMEOUT_US = 6000;
constexpr uint32_t REPORT_INTERVAL_MS = 1000;
constexpr uint8_t INVALID_ALARM_COUNT = 3;

uint32_t lastReportMs = 0;
uint8_t consecutiveInvalid = 0;

bool measureOnce(float &distanceCm) {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(3);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(12);
  digitalWrite(TRIG_PIN, LOW);

  const uint32_t durationUs = pulseIn(ECHO_PIN, HIGH, ECHO_TIMEOUT_US);
  if (durationUs == 0) return false;

  distanceCm = durationUs * 0.0343f * 0.5f;
  return isfinite(distanceCm) && distanceCm >= MIN_MEASURABLE_CM &&
         distanceCm <= MAX_DEMO_DISTANCE_CM;
}

void sortValues(float *values, uint8_t count) {
  for (uint8_t i = 1; i < count; ++i) {
    const float value = values[i];
    int8_t j = static_cast<int8_t>(i) - 1;
    while (j >= 0 && values[j] > value) {
      values[j + 1] = values[j];
      --j;
    }
    values[j + 1] = value;
  }
}

bool measureFiltered(float &distanceCm) {
  float samples[5];
  uint8_t count = 0;

  for (uint8_t attempt = 0; attempt < 9 && count < 5; ++attempt) {
    float sample = 0.0f;
    if (measureOnce(sample)) samples[count++] = sample;
    delay(55);  // Avoid interference between ultrasonic bursts.
  }

  if (count < 3) return false;
  sortValues(samples, count);
  distanceCm = samples[count / 2];
  return true;
}

const char *riskName(float clearanceCm) {
  if (clearanceCm > 20.0f) return "安全：水位较低";
  if (clearanceCm > 10.0f) return "关注：水位上升";
  if (clearanceCm > 5.0f) return "警告：水位较高";
  return "严重：仪器有被淹风险";
}

uint8_t riskLevel(float clearanceCm) {
  if (clearanceCm > 20.0f) return 0;
  if (clearanceCm > 10.0f) return 1;
  if (clearanceCm > 5.0f) return 2;
  return 3;
}

void printMeasurement() {
  float clearanceCm = 0.0f;
  if (!measureFiltered(clearanceCm)) {
    if (consecutiveInvalid < 255) ++consecutiveInvalid;
    if (consecutiveInvalid >= INVALID_ALARM_COUNT) {
      Serial.println("风险3 | 距水面未知 | 连续无回波：可能进入2cm盲区、探头被水淹或接线异常");
    } else {
      Serial.println("测距暂时无效，正在复测...");
    }
    return;
  }

  consecutiveInvalid = 0;
  Serial.printf("风险%u | 距水面 %.1fcm | %s\n", riskLevel(clearanceCm),
                clearanceCm, riskName(clearanceCm));
}

void begin() {
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  Serial.println("US-100 水面接近监测Demo | 桶深约30cm");
  Serial.println("数值表示探头到水面的距离：越小越危险，无需校准");
  Serial.println("接线：VCC->3V3, Trig/Tx->GPIO16, Echo/Rx->GPIO17, GND->GND");
  Serial.println("必须拔掉US-100模式跳帽，使用TRIG/ECHO模式；BOOT未被占用");
}

void update() {
  const uint32_t now = millis();
  if (static_cast<uint32_t>(now - lastReportMs) >= REPORT_INTERVAL_MS) {
    lastReportMs = now;
    printMeasurement();
  }
}

}  // namespace WaterClearanceDemo

void setup() {
  Serial.begin(115200);
  delay(700);
  WaterClearanceDemo::begin();
}

void loop() {
  WaterClearanceDemo::update();
  delay(2);
}
