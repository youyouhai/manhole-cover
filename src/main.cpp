#include <Arduino.h>
#include <Preferences.h>
#include <Wire.h>
#include <stddef.h>

namespace TiltSwitch {

// ESP32-S3-N16R8 + MPU6050 wiring.
constexpr uint8_t DEFAULT_MPU_ADDR = 0x68;
constexpr int SDA_PIN = 8;
constexpr int SCL_PIN = 9;
constexpr int RED_LED_PIN = 2;
constexpr int BUZZER_PIN = 4;
constexpr bool BUZZER_ACTIVE_HIGH = true;
constexpr int ZERO_BUTTON_PIN = 0;  // On-board BOOT button, active low.
constexpr int ULTRASONIC_TRIG_PIN = 16;
constexpr int ULTRASONIC_ECHO_PIN = 17;
constexpr int WATER_LED_PIN = 5;
constexpr int PASSIVE_BUZZER_PIN = 6;
constexpr int HALL_LEFT_PIN = 7;
constexpr int HALL_RIGHT_PIN = 10;
constexpr int CAT1_TX_PIN = 18;
constexpr int CAT1_RX_PIN = 21;
// One-way alarm link to the independent ESP32-S3-CAM board.
// Wiring: this board GPIO13 (TX) -> camera GPIO14 (RX), plus common GND.
constexpr int CAMERA_LINK_TX_PIN = 13;
constexpr uint32_t CAMERA_LINK_BAUD_RATE = 115200;
constexpr uint8_t PASSIVE_BUZZER_LEDC_CHANNEL = 7;

// M100PG DTU uplink. USB CDC remains on Serial for local diagnostics.
constexpr uint32_t CAT1_BAUD_RATE = 115200;
constexpr uint32_t TELEMETRY_INTERVAL_MS = 20UL * 1000UL;
constexpr uint32_t TELEMETRY_EVENT_MIN_INTERVAL_MS = 1000;
constexpr char DEVICE_ID[] = "MH001";

constexpr uint32_t SAMPLE_INTERVAL_MS = 10;  // 100 Hz
constexpr uint32_t STATUS_INTERVAL_MS = 2000;
constexpr uint32_t ZERO_BUTTON_HOLD_MS = 2000;
constexpr uint32_t ZERO_SETTLE_MS = 2000;
constexpr uint32_t RED_LED_TRIGGER_MS = 10000;
constexpr uint32_t NORMAL_RECOVERY_CLEAR_MS = 20000;
constexpr uint32_t OUTPUT_SELF_TEST_MS = 180;
constexpr uint32_t SENSOR_FAULT_MS = 1000;
constexpr uint32_t SENSOR_RETRY_MS = 2000;
constexpr uint32_t REPEAT_WINDOW_MS = 10UL * 60UL * 1000UL;
constexpr uint32_t ULTRASONIC_SAMPLE_INTERVAL_MS = 200;
// A 4.5 m round trip is about 26.3 ms; allow the full US-100 range.
constexpr uint32_t ULTRASONIC_ECHO_TIMEOUT_US = 30000;
constexpr float ULTRASONIC_MIN_CM = 2.0f;
constexpr float ULTRASONIC_MAX_CM = 450.0f;
constexpr uint8_t ULTRASONIC_FAULT_COUNT = 75;
constexpr uint32_t WATER_RISE_RATE_INTERVAL_MS = 10000;
constexpr float WATER_RISE_RATE_DEADBAND_CM = 0.3f;
constexpr uint32_t WATER_LED_BLINK_HALF_PERIOD_MS = 500;
constexpr uint16_t WATER_LOW_TONE_HZ = 700;
constexpr uint16_t WATER_MEDIUM_TONE_HZ = 1500;
constexpr uint16_t WATER_HIGH_TONE_HZ = 2400;
constexpr uint32_t HALL_INPUT_DEBOUNCE_MS = 100;
constexpr uint32_t HALL_STATE_CONFIRM_MS = 800;
constexpr uint32_t HALL_BOTH_MISSING_TRIGGER_MS = 10000;
constexpr uint16_t HALL_ALARM_TONE_HZ = 700;

// Initial engineering thresholds. Field data must be used to tune them.
constexpr float SLIGHT_ENTER_DEG = 10.0f;
constexpr float SLIGHT_EXIT_DEG = 8.0f;
constexpr float WARNING_ENTER_DEG = 20.0f;
constexpr float WARNING_EXIT_DEG = 18.0f;
constexpr float TILTED_ENTER_DEG = 30.0f;
constexpr float TILTED_EXIT_DEG = 27.0f;
constexpr float FLIPPED_ENTER_DEG = 45.0f;
constexpr float FLIPPED_EXIT_DEG = 42.0f;
constexpr float INVERTED_ENTER_DEG = 90.0f;
constexpr float INVERTED_EXIT_DEG = 85.0f;
constexpr uint32_t TILT_LED_BLINK_HALF_PERIOD_MS = 500;

constexpr float ACCEL_CORRECTION_MIN_G = 0.82f;
constexpr float ACCEL_CORRECTION_MAX_G = 1.18f;
constexpr float FUSION_TIME_CONSTANT_S = 0.45f;

constexpr uint32_t CALIBRATION_SAMPLES = 250;
constexpr uint32_t CALIBRATION_MIN_GOOD = 220;
constexpr uint32_t CALIBRATION_MAGIC = 0x54494C54;  // "TILT"
constexpr uint16_t CALIBRATION_VERSION = 2;

enum class State : uint8_t {
  NORMAL,
  SLIGHT_TILT,
  TILT_WARNING,
  TILTED,
  FLIPPED,
  INVERTED,
  CALIBRATION_REQUIRED,
  SENSOR_FAULT
};

enum class WaterOutputBand : uint8_t {
  OFF,
  LOW_TONE,
  MEDIUM_TONE_BLINK,
  HIGH_TONE_SOLID
};

enum class HallState : uint8_t {
  BOTH_PRESENT,
  LEFT_MISSING,
  RIGHT_MISSING,
  BOTH_MISSING
};

struct Vec3 {
  float x;
  float y;
  float z;
};

struct ImuSample {
  Vec3 accelG;
  Vec3 gyroRadS;
  float temperatureC;
};

struct CalibrationData {
  uint32_t magic;
  uint16_t version;
  uint16_t reserved;
  Vec3 referenceGravity;
  Vec3 gyroBias;
  uint32_t checksum;
};

Vec3 referenceGravity{0.0f, 0.0f, 1.0f};
Vec3 gravityEstimate{0.0f, 0.0f, 1.0f};
Vec3 gyroBias{0.0f, 0.0f, 0.0f};

State stableState = State::CALIBRATION_REQUIRED;
State candidateState = State::CALIBRATION_REQUIRED;
uint32_t candidateSinceMs = 0;
uint32_t stateSinceMs = 0;
uint32_t lastSampleMs = 0;
uint32_t lastGoodReadMs = 0;
uint32_t lastRetryMs = 0;
uint32_t lastStatusMs = 0;
uint32_t lastFusionUs = 0;
uint32_t eventId = 0;

bool calibrated = false;
bool sensorOnline = false;
bool fusionInitialized = false;
uint8_t mpuAddress = DEFAULT_MPU_ADDR;

float tiltDegrees = 0.0f;
float rollDeltaDegrees = 0.0f;
float pitchDeltaDegrees = 0.0f;
float tiltRateDegS = 0.0f;
float accelNormG = 1.0f;
float gyroNormDegS = 0.0f;
float temperatureC = 0.0f;
float maxTiltInState = 0.0f;
float peakAccelSinceStatus = 1.0f;
float normalNoiseEwma = 0.0f;
uint32_t totalReadFailures = 0;
uint32_t rejectedAccelCorrections = 0;

uint32_t slightEventTimes[8]{};
uint8_t slightEventWriteIndex = 0;

String commandBuffer;
uint32_t zeroButtonPressedAtMs = 0;
bool zeroButtonArmed = false;
bool redLedOn = false;
bool buzzerOutputOn = false;
bool maintenanceInProgress = false;
uint8_t latchedRiskLevel = 0;
uint8_t lastBuzzerRiskLevel = 0;
bool dangerTimerActive = false;
uint32_t dangerSinceMs = 0;
bool normalRecoveryTimerActive = false;
uint32_t normalRecoverySinceMs = 0;
uint32_t buzzerPatternStartedMs = 0;

float waterClearanceCm = NAN;
float waterSamples[5]{};
uint8_t waterSampleCount = 0;
uint8_t waterInvalidCount = 0;
uint32_t lastUltrasonicSampleMs = 0;
bool waterMeasurementValid = false;
bool waterRiseRateBaselineValid = false;
bool waterRiseRateValid = false;
float waterRiseRateBaselineCm = 0.0f;
float waterRiseRateCmPerMin = 0.0f;
float waterRiseRateLastDeltaCm = 0.0f;
uint32_t waterRiseRateBaselineMs = 0;
WaterOutputBand waterOutputBand = WaterOutputBand::OFF;
bool waterLedOutputOn = false;
uint16_t passiveBuzzerFrequencyHz = 0;
bool waterOutputSelfTestActive = false;
uint32_t waterOutputSelfTestStartedMs = 0;
volatile uint32_t ultrasonicEchoRiseUs = 0;
volatile uint32_t ultrasonicEchoPulseUs = 0;
volatile bool ultrasonicEchoReady = false;
uint32_t ultrasonicTriggerUs = 0;
bool ultrasonicAwaitingEcho = false;

bool hallLeftRawPresent = false;
bool hallRightRawPresent = false;
bool hallLeftPresent = false;
bool hallRightPresent = false;
uint32_t hallLeftRawChangedMs = 0;
uint32_t hallRightRawChangedMs = 0;
HallState hallStableState = HallState::BOTH_MISSING;
HallState hallCandidateState = HallState::BOTH_MISSING;
uint32_t hallCandidateSinceMs = 0;
bool hallBothMissingTimerActive = false;
uint32_t hallBothMissingSinceMs = 0;
bool hallBothMissingAlarmActive = false;

HardwareSerial cat1Serial(1);
HardwareSerial cameraLinkSerial(2);
uint32_t telemetrySequence = 0;
uint32_t lastTelemetryMs = 0;
bool telemetryDirty = true;

bool saveAlarmLatch(bool latched);
void writeBuzzer(bool on);

void requestAlarmPhotos(const char *reason) {
  cameraLinkSerial.printf("CAPTURE,5,%s\n", reason);
  Serial.printf(">>> CAMERA_LINK requested 5 photos: %s\n", reason);
}

Vec3 add(const Vec3 &a, const Vec3 &b) {
  return {a.x + b.x, a.y + b.y, a.z + b.z};
}

Vec3 subtract(const Vec3 &a, const Vec3 &b) {
  return {a.x - b.x, a.y - b.y, a.z - b.z};
}

Vec3 scale(const Vec3 &v, float factor) {
  return {v.x * factor, v.y * factor, v.z * factor};
}

float dot(const Vec3 &a, const Vec3 &b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

Vec3 cross(const Vec3 &a, const Vec3 &b) {
  return {
      a.y * b.z - a.z * b.y,
      a.z * b.x - a.x * b.z,
      a.x * b.y - a.y * b.x,
  };
}

float magnitude(const Vec3 &v) {
  return sqrtf(dot(v, v));
}

Vec3 normalized(const Vec3 &v) {
  const float length = magnitude(v);
  if (!isfinite(length) || length < 0.001f) return {0.0f, 0.0f, 0.0f};
  return scale(v, 1.0f / length);
}

float clampFloat(float value, float low, float high) {
  return value < low ? low : (value > high ? high : value);
}

float wrap180(float angle) {
  while (angle > 180.0f) angle -= 360.0f;
  while (angle < -180.0f) angle += 360.0f;
  return angle;
}

const char *stateName(State state) {
  switch (state) {
    case State::NORMAL: return "NORMAL";
    case State::SLIGHT_TILT: return "SLIGHT_TILT";
    case State::TILT_WARNING: return "TILT_WARNING";
    case State::TILTED: return "TILTED";
    case State::FLIPPED: return "FLIPPED";
    case State::INVERTED: return "INVERTED";
    case State::CALIBRATION_REQUIRED: return "CALIBRATION_REQUIRED";
    default: return "SENSOR_FAULT";
  }
}

const char *stateNameZh(State state) {
  switch (state) {
    case State::NORMAL: return "轻微倾斜";
    case State::SLIGHT_TILT: return "明显倾斜";
    case State::TILT_WARNING: return "中度倾斜";
    case State::TILTED: return "重度倾斜";
    case State::FLIPPED: return "严重倾斜";
    case State::INVERTED: return "井盖翻面";
    case State::CALIBRATION_REQUIRED: return "需要校准";
    default: return "传感器故障";
  }
}

uint8_t baseRiskLevel(State state) {
  switch (state) {
    case State::NORMAL: return 0;
    case State::SLIGHT_TILT: return 1;
    case State::TILT_WARNING: return 2;
    case State::CALIBRATION_REQUIRED: return 2;
    case State::TILTED: return 3;
    case State::SENSOR_FAULT: return 3;
    case State::FLIPPED: return 4;
    case State::INVERTED: return 5;
  }
  return 0;
}

uint8_t severity(State state) {
  return baseRiskLevel(state);
}

bool isTiltDangerState(State state) {
  switch (state) {
    case State::SLIGHT_TILT:
    case State::TILT_WARNING:
    case State::TILTED:
    case State::FLIPPED:
    case State::INVERTED:
      return true;
    default:
      return false;
  }
}

uint8_t recentSlightEventCount(uint32_t now) {
  uint8_t count = 0;
  for (uint32_t timestamp : slightEventTimes) {
    if (timestamp != 0 && static_cast<uint32_t>(now - timestamp) <= REPEAT_WINDOW_MS) {
      ++count;
    }
  }
  return count;
}

void sortWaterSamples() {
  for (uint8_t i = 1; i < waterSampleCount; ++i) {
    const float value = waterSamples[i];
    int8_t j = static_cast<int8_t>(i) - 1;
    while (j >= 0 && waterSamples[j] > value) {
      waterSamples[j + 1] = waterSamples[j];
      --j;
    }
    waterSamples[j + 1] = value;
  }
}

WaterOutputBand classifyWaterOutputBand(float distanceCm) {
  if (distanceCm < 10.0f) return WaterOutputBand::HIGH_TONE_SOLID;
  if (distanceCm < 20.0f) return WaterOutputBand::MEDIUM_TONE_BLINK;
  if (distanceCm <= 30.0f) return WaterOutputBand::LOW_TONE;
  return WaterOutputBand::OFF;
}

const char *waterOutputBandName() {
  switch (waterOutputBand) {
    case WaterOutputBand::LOW_TONE: return "低音、灯灭";
    case WaterOutputBand::MEDIUM_TONE_BLINK: return "中音、灯闪烁";
    case WaterOutputBand::HIGH_TONE_SOLID: return "高音、灯常亮";
    default: return "关闭";
  }
}

void writeWaterLed(bool on) {
  if (waterLedOutputOn == on) return;
  waterLedOutputOn = on;
  digitalWrite(WATER_LED_PIN, on ? HIGH : LOW);
}

void updateWaterSignalOutputs() {
  uint16_t desiredFrequencyHz = 0;
  bool desiredLedOn = false;
  switch (waterOutputBand) {
    case WaterOutputBand::HIGH_TONE_SOLID:
      desiredFrequencyHz = WATER_HIGH_TONE_HZ;
      desiredLedOn = true;
      break;
    case WaterOutputBand::MEDIUM_TONE_BLINK:
      desiredFrequencyHz = WATER_MEDIUM_TONE_HZ;
      desiredLedOn =
          ((millis() / WATER_LED_BLINK_HALF_PERIOD_MS) % 2U) == 0U;
      break;
    case WaterOutputBand::LOW_TONE:
      desiredFrequencyHz = WATER_LOW_TONE_HZ;
      break;
    case WaterOutputBand::OFF:
      break;
  }

  if (waterOutputSelfTestActive) {
    const uint32_t elapsed = millis() - waterOutputSelfTestStartedMs;
    if (elapsed < 1000) {
      desiredFrequencyHz = WATER_LOW_TONE_HZ;
      desiredLedOn = false;
    } else if (elapsed < 2000) {
      desiredFrequencyHz = WATER_MEDIUM_TONE_HZ;
      desiredLedOn = ((elapsed / 250U) % 2U) == 0U;
    } else if (elapsed < 3000) {
      desiredFrequencyHz = WATER_HIGH_TONE_HZ;
      desiredLedOn = true;
    } else {
      waterOutputSelfTestActive = false;
      Serial.println("水位声光自检完成");
    }
  }

  // The passive buzzer is shared with the water alarm. A confirmed two-sided
  // cover removal has priority and forces the low-frequency Hall warning tone.
  if (hallBothMissingAlarmActive) {
    desiredFrequencyHz = HALL_ALARM_TONE_HZ;
  }

  writeWaterLed(desiredLedOn);
  if (desiredFrequencyHz != passiveBuzzerFrequencyHz) {
    passiveBuzzerFrequencyHz = desiredFrequencyHz;
    ledcWriteTone(PASSIVE_BUZZER_LEDC_CHANNEL, desiredFrequencyHz);
  }
}

void startWaterOutputSelfTest() {
  waterOutputSelfTestStartedMs = millis();
  waterOutputSelfTestActive = true;
  Serial.println("水位声光自检：低音1秒 -> 中音和闪灯1秒 -> 高音和常亮1秒");
}

void IRAM_ATTR ultrasonicEchoInterrupt() {
  const uint32_t nowUs = micros();
  if (digitalRead(ULTRASONIC_ECHO_PIN) == HIGH) {
    ultrasonicEchoRiseUs = nowUs;
  } else if (ultrasonicEchoRiseUs != 0) {
    ultrasonicEchoPulseUs = nowUs - ultrasonicEchoRiseUs;
    ultrasonicEchoReady = true;
  }
}

void recordInvalidUltrasonicSample() {
  const bool wasValid = waterMeasurementValid;
  if (waterInvalidCount < 255) ++waterInvalidCount;
  if (waterInvalidCount >= ULTRASONIC_FAULT_COUNT) {
    waterMeasurementValid = false;
    waterRiseRateBaselineValid = false;
    waterRiseRateValid = false;
    waterOutputBand = WaterOutputBand::OFF;
    if (wasValid) telemetryDirty = true;
  }
}

HallState classifyHallState(bool leftPresent, bool rightPresent) {
  if (leftPresent && rightPresent) return HallState::BOTH_PRESENT;
  if (!leftPresent && rightPresent) return HallState::LEFT_MISSING;
  if (leftPresent && !rightPresent) return HallState::RIGHT_MISSING;
  return HallState::BOTH_MISSING;
}

const char *hallStateName(HallState state) {
  switch (state) {
    case HallState::BOTH_PRESENT: return "BOTH_PRESENT";
    case HallState::LEFT_MISSING: return "LEFT_MISSING";
    case HallState::RIGHT_MISSING: return "RIGHT_MISSING";
    default: return "BOTH_MISSING";
  }
}

const char *hallStateNameZh(HallState state) {
  switch (state) {
    case HallState::BOTH_PRESENT: return "两侧在位";
    case HallState::LEFT_MISSING: return "左侧离位";
    case HallState::RIGHT_MISSING: return "右侧离位";
    default: return "两侧离位";
  }
}

void printHallStatus() {
  Serial.printf("霍尔：%s | 左侧=%s | 右侧=%s\n",
                hallStateNameZh(hallStableState),
                hallLeftPresent ? "有磁铁" : "无磁铁",
                hallRightPresent ? "有磁铁" : "无磁铁");
}

void updateHallInputs() {
  const uint32_t now = millis();
  // The 3144E/LM393 module DO output is active low when a magnet is detected.
  const bool leftNowPresent = digitalRead(HALL_LEFT_PIN) == LOW;
  const bool rightNowPresent = digitalRead(HALL_RIGHT_PIN) == LOW;

  if (leftNowPresent != hallLeftRawPresent) {
    hallLeftRawPresent = leftNowPresent;
    hallLeftRawChangedMs = now;
  } else if (hallLeftPresent != hallLeftRawPresent &&
             static_cast<uint32_t>(now - hallLeftRawChangedMs) >=
                 HALL_INPUT_DEBOUNCE_MS) {
    hallLeftPresent = hallLeftRawPresent;
  }

  if (rightNowPresent != hallRightRawPresent) {
    hallRightRawPresent = rightNowPresent;
    hallRightRawChangedMs = now;
  } else if (hallRightPresent != hallRightRawPresent &&
             static_cast<uint32_t>(now - hallRightRawChangedMs) >=
                 HALL_INPUT_DEBOUNCE_MS) {
    hallRightPresent = hallRightRawPresent;
  }

  const HallState observed =
      classifyHallState(hallLeftPresent, hallRightPresent);
  if (observed != hallCandidateState) {
    hallCandidateState = observed;
    hallCandidateSinceMs = now;
    return;
  }
  if (observed == hallStableState ||
      static_cast<uint32_t>(now - hallCandidateSinceMs) <
          HALL_STATE_CONFIRM_MS) {
    return;
  }

  const HallState previous = hallStableState;
  hallStableState = observed;
  telemetryDirty = true;
  Serial.printf(">>> 霍尔状态变化：%s -> %s\n",
                hallStateNameZh(previous), hallStateNameZh(hallStableState));
  printHallStatus();
}

void updateHallAlarmController() {
  const uint32_t now = millis();
  const bool bothMissing = hallStableState == HallState::BOTH_MISSING;

  if (!bothMissing) {
    hallBothMissingTimerActive = false;
    if (hallBothMissingAlarmActive) {
      hallBothMissingAlarmActive = false;
      telemetryDirty = true;
      Serial.println(">>> 霍尔联动解除：至少一侧重新检测到磁体");
    }
    return;
  }

  if (hallBothMissingAlarmActive) return;
  if (!hallBothMissingTimerActive) {
    hallBothMissingTimerActive = true;
    hallBothMissingSinceMs = now;
    Serial.println(">>> 双侧霍尔均离位，开始10秒确认计时");
    return;
  }

  if (static_cast<uint32_t>(now - hallBothMissingSinceMs) >=
      HALL_BOTH_MISSING_TRIGGER_MS) {
    hallBothMissingTimerActive = false;
    hallBothMissingAlarmActive = true;
    telemetryDirty = true;
    requestAlarmPhotos("COVER_REMOVED");
    Serial.println(">>> 霍尔联动报警：双侧离位已持续10秒，倾斜灯常亮、无源蜂鸣器低音鸣叫");
  }
}

void updateWaterRiseRate(float currentDistanceCm) {
  const uint32_t now = millis();
  if (!waterRiseRateBaselineValid) {
    waterRiseRateBaselineValid = true;
    waterRiseRateValid = false;
    waterRiseRateBaselineCm = currentDistanceCm;
    waterRiseRateBaselineMs = now;
    return;
  }

  const uint32_t elapsedMs = now - waterRiseRateBaselineMs;
  if (elapsedMs < WATER_RISE_RATE_INTERVAL_MS) return;

  float distanceDeltaCm = waterRiseRateBaselineCm - currentDistanceCm;
  if (fabsf(distanceDeltaCm) < WATER_RISE_RATE_DEADBAND_CM) {
    distanceDeltaCm = 0.0f;
  }
  waterRiseRateLastDeltaCm = distanceDeltaCm;
  waterRiseRateCmPerMin =
      distanceDeltaCm * 60000.0f / static_cast<float>(elapsedMs);
  waterRiseRateValid = true;

  const char *direction = distanceDeltaCm > 0.0f
                              ? "上升"
                              : (distanceDeltaCm < 0.0f ? "下降" : "稳定");
  Serial.printf(">>> 水位速度：%s %.2f cm/min（%.1fs内距离变化 %.2fcm）\n",
                direction, fabsf(waterRiseRateCmPerMin),
                elapsedMs / 1000.0f, distanceDeltaCm);

  waterRiseRateBaselineCm = currentDistanceCm;
  waterRiseRateBaselineMs = now;
}

void recordValidUltrasonicSample(uint32_t durationUs) {
  const float distanceCm = durationUs * 0.0343f * 0.5f;
  if (!isfinite(distanceCm) || distanceCm < ULTRASONIC_MIN_CM ||
      distanceCm > ULTRASONIC_MAX_CM) {
    recordInvalidUltrasonicSample();
    return;
  }

  waterInvalidCount = 0;
  waterSamples[waterSampleCount++] = distanceCm;
  if (waterSampleCount < 5) return;

  const bool wasValid = waterMeasurementValid;
  const WaterOutputBand previousBand = waterOutputBand;
  sortWaterSamples();
  waterClearanceCm = waterSamples[waterSampleCount / 2];
  waterSampleCount = 0;
  waterMeasurementValid = true;
  updateWaterRiseRate(waterClearanceCm);
  waterOutputBand = classifyWaterOutputBand(waterClearanceCm);
  if (!wasValid || waterOutputBand != previousBand) telemetryDirty = true;
}

void startUltrasonicMeasurement() {
  noInterrupts();
  ultrasonicEchoRiseUs = 0;
  ultrasonicEchoPulseUs = 0;
  ultrasonicEchoReady = false;
  interrupts();

  ultrasonicAwaitingEcho = true;
  digitalWrite(ULTRASONIC_TRIG_PIN, LOW);
  delayMicroseconds(3);
  digitalWrite(ULTRASONIC_TRIG_PIN, HIGH);
  delayMicroseconds(12);
  digitalWrite(ULTRASONIC_TRIG_PIN, LOW);
  ultrasonicTriggerUs = micros();
}

void updateUltrasonicController() {
  if (ultrasonicAwaitingEcho) {
    bool ready = false;
    uint32_t pulseUs = 0;
    noInterrupts();
    ready = ultrasonicEchoReady;
    if (ready) {
      pulseUs = ultrasonicEchoPulseUs;
      ultrasonicEchoReady = false;
    }
    interrupts();

    if (ready) {
      ultrasonicAwaitingEcho = false;
      recordValidUltrasonicSample(pulseUs);
    } else if (static_cast<uint32_t>(micros() - ultrasonicTriggerUs) >=
               ULTRASONIC_ECHO_TIMEOUT_US) {
      ultrasonicAwaitingEcho = false;
      recordInvalidUltrasonicSample();
    }
    return;
  }

  const uint32_t now = millis();
  if (static_cast<uint32_t>(now - lastUltrasonicSampleMs) >=
      ULTRASONIC_SAMPLE_INTERVAL_MS) {
    lastUltrasonicSampleMs = now;
    startUltrasonicMeasurement();
  }
}

uint8_t effectiveRiskLevel(State state, uint32_t now) {
  (void)now;
  return baseRiskLevel(state);
}

void setRedLed(bool on, const char *reason) {
  if (redLedOn == on) return;
  redLedOn = on;
  telemetryDirty = true;
  if (!on) {
    latchedRiskLevel = 0;
    normalRecoveryTimerActive = false;
  }
  digitalWrite(RED_LED_PIN, on ? HIGH : LOW);
  buzzerPatternStartedMs = millis();
  lastBuzzerRiskLevel = 0;
  if (!on) writeBuzzer(false);
  if (!saveAlarmLatch(on)) {
    Serial.println("WARNING 无法保存红灯锁定状态");
  }
  Serial.printf(">>> 红灯%s：%s\n", on ? "点亮" : "熄灭", reason);
}

void updateRedLedController() {
  const uint32_t now = millis();
  const uint8_t risk = effectiveRiskLevel(stableState, now);
  const bool dangerous =
      stableState != State::CALIBRATION_REQUIRED && risk >= 1;

  if (!redLedOn) {
    normalRecoveryTimerActive = false;
    if (!dangerous) {
      dangerTimerActive = false;
      return;
    }

    // A tilt state is committed only after the same danger band has remained
    // continuous for RED_LED_TRIGGER_MS. Latch the alarm immediately here so
    // the state confirmation and alarm delay do not add up to 20 seconds.
    if (isTiltDangerState(stableState)) {
      dangerTimerActive = false;
      latchedRiskLevel = risk;
      setRedLed(true, "tilt danger band confirmed continuously for 10 seconds");
      requestAlarmPhotos("TILT");
      return;
    }

    // Preserve the existing delayed alarm behavior for non-tilt faults.
    if (!dangerTimerActive) {
      dangerTimerActive = true;
      dangerSinceMs = now;
    }
    if (static_cast<uint32_t>(now - dangerSinceMs) >= RED_LED_TRIGGER_MS) {
      dangerTimerActive = false;
      latchedRiskLevel = risk;
      setRedLed(true, "倾斜状态已连续保持10秒");
    }
    return;
  }

  dangerTimerActive = false;

  // Keep BOOT/ACK maintenance reset available, but also allow the original
  // trusted zero reference to clear a tilt alarm after 20 s of stable recovery.
  const bool safelyRecovered = sensorOnline && calibrated &&
                               stableState == State::NORMAL &&
                               !maintenanceInProgress;
  if (safelyRecovered) {
    if (!normalRecoveryTimerActive) {
      normalRecoveryTimerActive = true;
      normalRecoverySinceMs = now;
      Serial.println(">>> 倾斜已回到正常区间，开始20秒安全恢复计时");
    } else if (static_cast<uint32_t>(now - normalRecoverySinceMs) >=
               NORMAL_RECOVERY_CLEAR_MS) {
      setRedLed(false, "已在正常倾角区间连续保持20秒，自动恢复安全状态");
      Serial.println(">>> 倾斜报警已自动解除；BOOT复位功能仍可正常使用");
      return;
    }
  } else if (normalRecoveryTimerActive) {
    normalRecoveryTimerActive = false;
    Serial.println(">>> 倾斜离开正常区间，20秒安全恢复计时取消");
  }

  if (risk > latchedRiskLevel) {
    latchedRiskLevel = risk;
    saveAlarmLatch(true);
    Serial.printf(">>> 锁定告警升级为%u级，蜂鸣节奏已升级\n", latchedRiskLevel);
  }
}

void writeBuzzer(bool on) {
  if (buzzerOutputOn == on) return;
  buzzerOutputOn = on;
  const bool pinHigh = BUZZER_ACTIVE_HIGH ? on : !on;
  digitalWrite(BUZZER_PIN, pinHigh ? HIGH : LOW);
}

uint8_t activeBuzzerRiskLevel() {
  if (!redLedOn) return 0;
  const uint8_t currentRisk = effectiveRiskLevel(stableState, millis());
  // Once alarmed, never become silent automatically. Recovered/low-risk
  // states fall back to the level-1 slow pattern until staff maintenance reset.
  return currentRisk >= 1 ? currentRisk : 1;
}

void updateTiltLedOutput() {
  if (hallBothMissingAlarmActive) {
    digitalWrite(RED_LED_PIN, HIGH);
    return;
  }
  if (!redLedOn) {
    digitalWrite(RED_LED_PIN, LOW);
    return;
  }
  const uint8_t outputRisk = activeBuzzerRiskLevel();
  const bool shouldLight =
      outputRisk >= 2 ||
      ((millis() / TILT_LED_BLINK_HALF_PERIOD_MS) % 2U) == 0U;
  digitalWrite(RED_LED_PIN, shouldLight ? HIGH : LOW);
}

const char *buzzerModeName() {
  const uint8_t buzzerRisk = activeBuzzerRiskLevel();
  if (buzzerRisk == 0) return "停止";
  if (buzzerRisk <= 2) return "长间隔鸣声";
  return "持续鸣叫";
}

void updateBuzzerController() {
  if (maintenanceInProgress) {
    writeBuzzer(false);
    return;
  }
  const uint8_t buzzerRisk = activeBuzzerRiskLevel();
  if (buzzerRisk == 0) {
    writeBuzzer(false);
    return;
  }

  if (buzzerRisk != lastBuzzerRiskLevel) {
    lastBuzzerRiskLevel = buzzerRisk;
    buzzerPatternStartedMs = millis();
    Serial.printf(">>> 蜂鸣模式切换：%u级 %s\n", buzzerRisk, buzzerModeName());
  }

  const uint32_t elapsed = millis() - buzzerPatternStartedMs;
  const uint32_t phase = elapsed % 3000UL;
  // Levels 1-2: one 300 ms beep every 3 seconds. Levels 3-5: continuous.
  const bool shouldSound = buzzerRisk <= 2 ? phase < 300 : true;
  writeBuzzer(shouldSound);
}

void runOutputSelfTest() {
  if (redLedOn) {
    Serial.println("声光自检跳过：存在锁定告警");
    return;
  }
  Serial.println("声光自检：红灯和蜂鸣器短暂启动");
  digitalWrite(RED_LED_PIN, HIGH);
  writeBuzzer(true);
  delay(OUTPUT_SELF_TEST_MS);
  writeBuzzer(false);
  digitalWrite(RED_LED_PIN, LOW);
  Serial.println("声光自检完成");
}

bool writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(mpuAddress);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readRegisters(uint8_t startReg, uint8_t *buffer, size_t length) {
  Wire.beginTransmission(mpuAddress);
  Wire.write(startReg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(mpuAddress, length, true) != length) return false;
  for (size_t i = 0; i < length; ++i) buffer[i] = Wire.read();
  return true;
}

bool readWhoAmI(uint8_t &identity) {
  return readRegisters(0x75, &identity, 1);
}

bool addressResponds(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

uint8_t scanI2cBus(bool printResults) {
  uint8_t found = 0;
  if (printResults) Serial.print("I2C_SCAN");
  for (uint8_t address = 1; address < 127; ++address) {
    if (addressResponds(address)) {
      ++found;
      if (printResults) Serial.printf(" 0x%02X", address);
    }
  }
  if (printResults) {
    if (found == 0) Serial.print(" none");
    Serial.println();
  }
  return found;
}

bool selectMpuAddress() {
  if (addressResponds(0x68)) {
    mpuAddress = 0x68;
    return true;
  }
  if (addressResponds(0x69)) {
    mpuAddress = 0x69;
    return true;
  }
  return false;
}

int16_t readInt16(const uint8_t *bytes) {
  return static_cast<int16_t>((static_cast<uint16_t>(bytes[0]) << 8) | bytes[1]);
}

bool readImu(ImuSample &sample) {
  uint8_t data[14];
  if (!readRegisters(0x3B, data, sizeof(data))) return false;

  constexpr float ACCEL_SCALE = 1.0f / 16384.0f;  // +/-2 g
  constexpr float GYRO_SCALE = DEG_TO_RAD / 65.5f; // +/-500 deg/s
  sample.accelG = {
      readInt16(&data[0]) * ACCEL_SCALE,
      readInt16(&data[2]) * ACCEL_SCALE,
      readInt16(&data[4]) * ACCEL_SCALE,
  };
  sample.temperatureC = readInt16(&data[6]) / 340.0f + 36.53f;
  sample.gyroRadS = {
      readInt16(&data[8]) * GYRO_SCALE,
      readInt16(&data[10]) * GYRO_SCALE,
      readInt16(&data[12]) * GYRO_SCALE,
  };
  return true;
}

bool configureSensor() {
  if (!selectMpuAddress()) {
    scanI2cBus(true);
    return false;
  }
  uint8_t identity = 0;
  if (!readWhoAmI(identity)) {
    Serial.printf("MPU_PROBE address=0x%02X who_am_i=READ_FAILED\n", mpuAddress);
    return false;
  }
  Serial.printf("MPU_PROBE address=0x%02X who_am_i=0x%02X\n",
                mpuAddress, identity);
  // MPU6050 normally returns 0x68/0x69. Several register-compatible
  // InvenSense modules use 0x70-0x73 and can run this tilt-only firmware.
  const bool compatibleIdentity = identity == 0x68 || identity == 0x69 ||
                                  (identity >= 0x70 && identity <= 0x73);
  if (!compatibleIdentity) {
    Serial.println("MPU_PROBE unsupported_identity");
    return false;
  }

  // Reset, select PLL clock, sample at 100 Hz, use ~44 Hz digital low-pass.
  if (!writeRegister(0x6B, 0x80)) return false;
  delay(100);
  return writeRegister(0x6B, 0x01) &&
         writeRegister(0x19, 0x09) &&
         writeRegister(0x1A, 0x03) &&
         writeRegister(0x1B, 0x08) &&  // gyro +/-500 deg/s
         writeRegister(0x1C, 0x00) &&  // accel +/-2 g
         writeRegister(0x1D, 0x03);
}

uint32_t calibrationChecksum(const CalibrationData &data) {
  const uint8_t *bytes = reinterpret_cast<const uint8_t *>(&data);
  uint32_t hash = 2166136261UL;
  for (size_t i = 0; i < offsetof(CalibrationData, checksum); ++i) {
    hash ^= bytes[i];
    hash *= 16777619UL;
  }
  return hash;
}

bool calibrationValuesValid(const CalibrationData &data) {
  const float refLength = magnitude(data.referenceGravity);
  return data.magic == CALIBRATION_MAGIC &&
         data.version == CALIBRATION_VERSION &&
         data.checksum == calibrationChecksum(data) &&
         isfinite(refLength) && refLength > 0.95f && refLength < 1.05f &&
         isfinite(data.gyroBias.x) && isfinite(data.gyroBias.y) &&
         isfinite(data.gyroBias.z) && magnitude(data.gyroBias) < 0.3f;
}

bool loadCalibration() {
  Preferences preferences;
  if (!preferences.begin("tilt-switch", true)) return false;
  CalibrationData data{};
  const size_t storedLength = preferences.getBytesLength("cal-v2");
  const size_t readLength = storedLength == sizeof(data)
                                ? preferences.getBytes("cal-v2", &data, sizeof(data))
                                : 0;
  preferences.end();
  if (readLength != sizeof(data) || !calibrationValuesValid(data)) return false;

  referenceGravity = data.referenceGravity;
  gyroBias = data.gyroBias;
  calibrated = true;
  Serial.printf("CALIBRATION_LOADED ref=[%.4f,%.4f,%.4f]\n",
                referenceGravity.x, referenceGravity.y, referenceGravity.z);
  return true;
}

bool saveCalibration() {
  CalibrationData data{};
  data.magic = CALIBRATION_MAGIC;
  data.version = CALIBRATION_VERSION;
  data.referenceGravity = referenceGravity;
  data.gyroBias = gyroBias;
  data.checksum = calibrationChecksum(data);

  Preferences preferences;
  if (!preferences.begin("tilt-switch", false)) return false;
  const size_t written = preferences.putBytes("cal-v2", &data, sizeof(data));
  preferences.end();
  return written == sizeof(data);
}

bool loadAlarmLatch() {
  Preferences preferences;
  if (!preferences.begin("tilt-switch", true)) return false;
  const bool latched = preferences.getBool("alarm", false);
  latchedRiskLevel = latched ? preferences.getUChar("alarm-risk", 1) : 0;
  if (latched && latchedRiskLevel < 1) latchedRiskLevel = 1;
  preferences.end();
  return latched;
}

bool saveAlarmLatch(bool latched) {
  Preferences preferences;
  if (!preferences.begin("tilt-switch", false)) return false;
  const size_t alarmWritten = preferences.putBool("alarm", latched);
  const size_t riskWritten = preferences.putUChar(
      "alarm-risk", latched ? (latchedRiskLevel < 1 ? 1 : latchedRiskLevel) : 0);
  preferences.end();
  return alarmWritten == sizeof(bool) && riskWritten == sizeof(uint8_t);
}

bool performCalibration(bool replaceReference) {
  Serial.println("CALIBRATING keep the cover CLOSED and COMPLETELY STILL for 3 seconds");
  Vec3 accelSum{};
  Vec3 gyroSum{};
  float accelSquareSum = 0.0f;
  float gyroSquareSum = 0.0f;
  uint32_t goodSamples = 0;

  for (uint32_t i = 0; i < CALIBRATION_SAMPLES; ++i) {
    ImuSample sample;
    if (readImu(sample)) {
      const float g = magnitude(sample.accelG);
      if (g > 0.80f && g < 1.20f) {
        accelSum = add(accelSum, sample.accelG);
        gyroSum = add(gyroSum, sample.gyroRadS);
        accelSquareSum += dot(sample.accelG, sample.accelG);
        gyroSquareSum += dot(sample.gyroRadS, sample.gyroRadS);
        ++goodSamples;
      }
    }
    delay(SAMPLE_INTERVAL_MS);
  }

  if (goodSamples < CALIBRATION_MIN_GOOD) {
    Serial.printf("CALIBRATION_FAILED insufficient_samples=%lu\n",
                  static_cast<unsigned long>(goodSamples));
    return false;
  }

  const Vec3 accelMean = scale(accelSum, 1.0f / goodSamples);
  const Vec3 gyroMean = scale(gyroSum, 1.0f / goodSamples);
  const float accelVariance = fmaxf(0.0f, accelSquareSum / goodSamples - dot(accelMean, accelMean));
  const float gyroVariance = fmaxf(0.0f, gyroSquareSum / goodSamples - dot(gyroMean, gyroMean));
  const float accelStd = sqrtf(accelVariance);
  const float gyroStdDeg = sqrtf(gyroVariance) * RAD_TO_DEG;

  const float meanAccelG = magnitude(accelMean);
  const float meanGyroDeg = magnitude(gyroMean) * RAD_TO_DEG;
  Serial.printf("校准采样：加速度=%.3fg 噪声=%.3fg 陀螺仪噪声=%.2f°/s\n",
                meanAccelG, accelStd, gyroStdDeg);

  // Reject only clear movement. Lower noise levels are reported as a warning
  // but accepted, because clone MPU6050 boards and jumper wires vary widely.
  if (meanAccelG < 0.75f || meanAccelG > 1.25f ||
      accelStd > 0.12f || gyroStdDeg > 10.0f || meanGyroDeg > 20.0f) {
    Serial.printf("CALIBRATION_FAILED movement_too_large accel_std=%.3fg "
                  "gyro_std=%.2fdps gyro_mean=%.2fdps\n",
                  accelStd, gyroStdDeg, meanGyroDeg);
    return false;
  }

  if (accelStd > 0.04f || gyroStdDeg > 3.0f) {
    Serial.println("校准提示：检测到轻微振动，已通过平均滤波完成校准");
  }

  gyroBias = gyroMean;
  gravityEstimate = normalized(accelMean);
  fusionInitialized = true;
  lastFusionUs = micros();
  if (replaceReference) referenceGravity = gravityEstimate;
  calibrated = true;

  Serial.printf("CALIBRATED ref=[%.4f,%.4f,%.4f] gyro_bias_dps=[%.3f,%.3f,%.3f]\n",
                referenceGravity.x, referenceGravity.y, referenceGravity.z,
                gyroBias.x * RAD_TO_DEG, gyroBias.y * RAD_TO_DEG,
                gyroBias.z * RAD_TO_DEG);
  return true;
}

float angleFromReference(const Vec3 &gravity) {
  return acosf(clampFloat(dot(normalized(gravity), referenceGravity), -1.0f, 1.0f)) * RAD_TO_DEG;
}

float rollFromGravity(const Vec3 &gravity) {
  return atan2f(gravity.y, gravity.z) * RAD_TO_DEG;
}

float pitchFromGravity(const Vec3 &gravity) {
  return atan2f(-gravity.x,
                sqrtf(gravity.y * gravity.y + gravity.z * gravity.z)) * RAD_TO_DEG;
}

void updatePose(const ImuSample &sample) {
  const uint32_t nowUs = micros();
  float dt = static_cast<uint32_t>(nowUs - lastFusionUs) * 1.0e-6f;
  lastFusionUs = nowUs;
  dt = clampFloat(dt, 0.002f, 0.05f);

  accelNormG = magnitude(sample.accelG);
  peakAccelSinceStatus = fmaxf(peakAccelSinceStatus, accelNormG);
  temperatureC = sample.temperatureC;
  const Vec3 correctedGyro = subtract(sample.gyroRadS, gyroBias);
  gyroNormDegS = magnitude(correctedGyro) * RAD_TO_DEG;

  if (!fusionInitialized) {
    if (accelNormG > 0.2f) {
      gravityEstimate = normalized(sample.accelG);
      fusionInitialized = true;
    }
    return;
  }

  // Gravity is a world-fixed vector expressed in the rotating sensor frame.
  gravityEstimate = normalized(add(gravityEstimate,
                                   scale(cross(gravityEstimate, correctedGyro), dt)));

  if (accelNormG >= ACCEL_CORRECTION_MIN_G &&
      accelNormG <= ACCEL_CORRECTION_MAX_G) {
    const Vec3 measuredGravity = normalized(sample.accelG);
    const float blend = 1.0f - expf(-dt / FUSION_TIME_CONSTANT_S);
    gravityEstimate = normalized(add(scale(gravityEstimate, 1.0f - blend),
                                     scale(measuredGravity, blend)));
  } else {
    ++rejectedAccelCorrections;
  }

  const float previousTilt = tiltDegrees;
  tiltDegrees = angleFromReference(gravityEstimate);
  const float rawRate = (tiltDegrees - previousTilt) / dt;
  tiltRateDegS += 0.15f * (rawRate - tiltRateDegS);
  rollDeltaDegrees = wrap180(rollFromGravity(gravityEstimate) -
                             rollFromGravity(referenceGravity));
  pitchDeltaDegrees = wrap180(pitchFromGravity(gravityEstimate) -
                              pitchFromGravity(referenceGravity));
  maxTiltInState = fmaxf(maxTiltInState, tiltDegrees);

  if (stableState == State::NORMAL && tiltDegrees < SLIGHT_EXIT_DEG) {
    normalNoiseEwma += 0.01f * (tiltDegrees - normalNoiseEwma);
  }
}

State classifyWithHysteresis(float angle, State current) {
  if (current == State::INVERTED && angle >= INVERTED_EXIT_DEG) return current;
  if (angle >= INVERTED_ENTER_DEG) return State::INVERTED;

  if (current == State::FLIPPED && angle >= FLIPPED_EXIT_DEG &&
      angle < INVERTED_ENTER_DEG) return current;
  if (angle >= FLIPPED_ENTER_DEG) return State::FLIPPED;

  if (current == State::TILTED && angle >= TILTED_EXIT_DEG &&
      angle < FLIPPED_ENTER_DEG) return current;
  if (angle >= TILTED_ENTER_DEG) return State::TILTED;

  if (current == State::TILT_WARNING && angle >= WARNING_EXIT_DEG &&
      angle < TILTED_ENTER_DEG) return current;
  if (angle >= WARNING_ENTER_DEG) return State::TILT_WARNING;

  if (current == State::SLIGHT_TILT && angle >= SLIGHT_EXIT_DEG &&
      angle < WARNING_ENTER_DEG) return current;
  if (angle >= SLIGHT_ENTER_DEG) return State::SLIGHT_TILT;
  return State::NORMAL;
}

uint32_t confirmationTimeMs(State target, State current) {
  // Every reported tilt danger level must remain in that exact hysteresis
  // band continuously for 10 seconds. A return to normal or a change to a
  // different danger band resets candidateSinceMs in acceptCandidate().
  if (isTiltDangerState(target)) return RED_LED_TRIGGER_MS;
  if (current == State::SENSOR_FAULT || current == State::CALIBRATION_REQUIRED) return 1000;
  if (severity(target) > severity(current)) {
    switch (target) {
      case State::SLIGHT_TILT: return 1200;
      case State::TILT_WARNING: return 1500;
      case State::TILTED: return 600;
      case State::FLIPPED:
      case State::INVERTED: return 250;
      default: return 500;
    }
  }
  return target == State::NORMAL ? 2000 : 1000;
}

void publishStateChange(State from, State to, uint32_t previousDurationMs,
                        float previousMaxTilt, const char *reason) {
  ++eventId;
  const uint32_t now = millis();
  const uint8_t risk = effectiveRiskLevel(to, now);
  Serial.printf(">>> 状态变化：%s -> %s | 角度 %.1f° | 风险 %u级 | 上一状态持续 %.1fs\n",
                stateNameZh(from), stateNameZh(to), tiltDegrees, risk,
                previousDurationMs / 1000.0f);
}

void commitState(State nextState, const char *reason) {
  if (nextState == stableState) return;
  const uint32_t now = millis();
  const State previousState = stableState;
  const uint32_t previousDuration = now - stateSinceMs;
  const float previousMax = maxTiltInState;

  stableState = nextState;
  telemetryDirty = true;
  stateSinceMs = now;
  maxTiltInState = tiltDegrees;
  candidateState = nextState;
  candidateSinceMs = now;

  if (nextState == State::SLIGHT_TILT && previousState == State::NORMAL) {
    slightEventTimes[slightEventWriteIndex] = now;
    slightEventWriteIndex = (slightEventWriteIndex + 1) %
                            (sizeof(slightEventTimes) / sizeof(slightEventTimes[0]));
  }

  publishStateChange(previousState, nextState, previousDuration, previousMax, reason);
}

void acceptCandidate(State observed) {
  const uint32_t now = millis();
  if (observed == stableState) {
    candidateState = stableState;
    candidateSinceMs = now;
    return;
  }
  if (observed != candidateState) {
    candidateState = observed;
    candidateSinceMs = now;
    return;
  }
  if (static_cast<uint32_t>(now - candidateSinceMs) >=
      confirmationTimeMs(candidateState, stableState)) {
    commitState(candidateState,
                severity(candidateState) > severity(stableState)
                    ? "threshold_sustained"
                    : "recovery_sustained");
  }
}

void printStatus() {
  const uint32_t now = millis();
  Serial.printf(
      "STATUS uptime_ms=%lu online=%u calibrated=%u state=%s risk=%u "
      "angle_deg=%.2f roll_deg=%.2f pitch_deg=%.2f rate_dps=%.2f "
      "accel_g=%.3f peak_g=%.3f gyro_dps=%.2f temp_c=%.1f "
      "state_duration_ms=%lu repeat10m=%u normal_noise_deg=%.2f "
      "read_failures=%lu accel_rejects=%lu\n",
      static_cast<unsigned long>(now), sensorOnline, calibrated,
      stateName(stableState), effectiveRiskLevel(stableState, now), tiltDegrees,
      rollDeltaDegrees, pitchDeltaDegrees, tiltRateDegS, accelNormG,
      peakAccelSinceStatus, gyroNormDegS, temperatureC,
      static_cast<unsigned long>(now - stateSinceMs),
      recentSlightEventCount(now), normalNoiseEwma,
      static_cast<unsigned long>(totalReadFailures),
      static_cast<unsigned long>(rejectedAccelCorrections));
  Serial.printf("HALL state=%s left_present=%u right_present=%u\n",
                hallStateName(hallStableState), hallLeftPresent,
                hallRightPresent);
  Serial.printf("HALL_ALARM active=%u confirming=%u\n",
                hallBothMissingAlarmActive, hallBothMissingTimerActive);
  peakAccelSinceStatus = accelNormG;
}

void printBriefStatus() {
  const uint32_t now = millis();
  Serial.printf("倾角 %.1f° | 状态：%s | 倾角风险：%u级 | ",
                tiltDegrees, stateNameZh(stableState),
                effectiveRiskLevel(stableState, now));
  if (waterMeasurementValid) {
    Serial.printf("距水面 %.1fcm | ", waterClearanceCm);
    if (!waterRiseRateValid) {
      Serial.print("水位速度：计算中 | ");
    } else if (waterRiseRateCmPerMin > 0.001f) {
      Serial.printf("水位速度：上升 %.2fcm/min | ", waterRiseRateCmPerMin);
    } else if (waterRiseRateCmPerMin < -0.001f) {
      Serial.printf("水位速度：下降 %.2fcm/min | ",
                    fabsf(waterRiseRateCmPerMin));
    } else {
      Serial.print("水位速度：稳定 | ");
    }
    Serial.printf("水位声光：%s | 霍尔：%s | 倾角红灯：",
                  waterOutputBandName(), hallStateNameZh(hallStableState));
  } else if (waterInvalidCount >= ULTRASONIC_FAULT_COUNT) {
    Serial.printf("距水面未知（水位声光关闭） | 霍尔：%s | 倾角红灯：",
                  hallStateNameZh(hallStableState));
  } else {
    Serial.printf("水位初始化 | 霍尔：%s | 倾角红灯：",
                  hallStateNameZh(hallStableState));
  }
  if (redLedOn) {
    Serial.printf(activeBuzzerRiskLevel() == 1
                      ? "闪烁（锁定%u级）"
                      : "亮（锁定%u级）",
                   latchedRiskLevel);
  } else if (dangerTimerActive) {
    const uint32_t elapsed = now - dangerSinceMs;
    const uint32_t remaining = elapsed >= RED_LED_TRIGGER_MS
                                   ? 0
                                   : (RED_LED_TRIGGER_MS - elapsed + 999) / 1000;
    Serial.printf("待确认（还需%lus）", static_cast<unsigned long>(remaining));
  } else {
    Serial.print("灭");
  }
  if (normalRecoveryTimerActive) {
    const uint32_t elapsed = now - normalRecoverySinceMs;
    const uint32_t remaining = elapsed >= NORMAL_RECOVERY_CLEAR_MS
                                   ? 0
                                   : (NORMAL_RECOVERY_CLEAR_MS - elapsed + 999) / 1000;
    Serial.printf(" | 倾斜恢复：确认中（还需%lus）",
                  static_cast<unsigned long>(remaining));
  }
  if (hallBothMissingAlarmActive) {
    Serial.printf(" | 霍尔联动：报警（灯常亮、无源蜂鸣器%uHz）",
                  HALL_ALARM_TONE_HZ);
  } else if (hallBothMissingTimerActive) {
    const uint32_t elapsed = now - hallBothMissingSinceMs;
    const uint32_t remaining = elapsed >= HALL_BOTH_MISSING_TRIGGER_MS
                                   ? 0
                                   : (HALL_BOTH_MISSING_TRIGGER_MS - elapsed + 999) / 1000;
    Serial.printf(" | 霍尔联动：确认中（还需%lus）",
                  static_cast<unsigned long>(remaining));
  } else {
    Serial.print(" | 霍尔联动：正常");
  }
  Serial.printf(" | 倾斜有源蜂鸣器：%s\n", buzzerModeName());
  peakAccelSinceStatus = accelNormG;
}

void sendTelemetrySnapshot() {
  const uint32_t now = millis();
  const float clearance = waterMeasurementValid ? waterClearanceCm : -1.0f;
  const float riseRate = waterRiseRateValid ? waterRiseRateCmPerMin : 0.0f;
  char payload[240];
  const int length = snprintf(
      payload, sizeof(payload),
      "V1,S,%s,%lu,%lu,%u,%s,%.2f,%u,%.2f,%u,%.2f,%s,%u,%u,%u,%u,%u\r\n",
      DEVICE_ID, static_cast<unsigned long>(++telemetrySequence),
      static_cast<unsigned long>(now), effectiveRiskLevel(stableState, now),
      stateName(stableState), tiltDegrees, waterMeasurementValid, clearance,
      waterRiseRateValid, riseRate, hallStateName(hallStableState),
      hallLeftPresent, hallRightPresent, sensorOnline, calibrated, redLedOn);

  if (length <= 0 || static_cast<size_t>(length) >= sizeof(payload)) {
    Serial.println("UPLINK_ERROR telemetry payload overflow");
    return;
  }

  cat1Serial.write(reinterpret_cast<const uint8_t *>(payload), length);
  Serial.printf("UPLINK %s", payload);
  lastTelemetryMs = now;
  telemetryDirty = false;
}

void updateCat1Uplink() {
  const uint32_t now = millis();
  const bool periodicDue =
      static_cast<uint32_t>(now - lastTelemetryMs) >= TELEMETRY_INTERVAL_MS;
  const bool eventDue = telemetryDirty &&
      static_cast<uint32_t>(now - lastTelemetryMs) >=
          TELEMETRY_EVENT_MIN_INTERVAL_MS;
  if (periodicDue || eventDue) sendTelemetrySnapshot();

  if (cat1Serial.available() > 0) {
    Serial.print("M100PG_RX ");
    while (cat1Serial.available() > 0) {
      Serial.write(cat1Serial.read());
    }
    Serial.println();
  }
}

void printHelp() {
  Serial.println("命令：ACK=维修复位  CAL=普通重设0°  TEST=倾角声光自检  WTEST=水位声光自检  HALL=霍尔状态  STATUS=详细状态");
  Serial.println("重设0°：将模块放到正常位置并保持静止，输入 CAL 后按回车");
  Serial.println("长按BOOT：有告警时执行维修复位并建立新0°；无告警时普通重设0°");
}

bool recalibrateZero(const char *reason) {
  if (redLedOn) {
    Serial.println("普通校准被拒绝：存在锁定告警，请使用BOOT或ACK执行维修复位");
    return false;
  }
  if (!sensorOnline) {
    Serial.println("校准失败：MPU6050未连接");
    return false;
  }
  if (!performCalibration(true)) {
    Serial.println("校准失败：检测到移动，请保持静止后重试");
    return false;
  }
  if (!saveCalibration()) {
    Serial.println("校准失败：无法保存零位");
    return false;
  }
  tiltDegrees = 0.0f;
  rollDeltaDegrees = 0.0f;
  pitchDeltaDegrees = 0.0f;
  commitState(State::NORMAL, reason);
  Serial.println("零位校准成功：当前位置已保存为 0°");
  return true;
}

bool completeMaintenanceReset() {
  if (!redLedOn) {
    Serial.println("无需维修复位：当前没有锁定告警");
    return false;
  }
  if (!sensorOnline) {
    Serial.println("维修复位失败：MPU6050未连接，红灯继续锁定");
    return false;
  }
  maintenanceInProgress = true;
  writeBuzzer(false);
  Serial.println("进入维修复位：红灯保持亮，蜂鸣器临时静音，避免振动干扰校准");
  Serial.println("请勿触碰模块，2秒后把当前位置设为新的0°...");
  delay(ZERO_SETTLE_MS);
  if (!performCalibration(true)) {
    maintenanceInProgress = false;
    Serial.println("维修复位失败：校准期间检测到明显移动，红灯继续锁定");
    return false;
  }
  if (!saveCalibration()) {
    maintenanceInProgress = false;
    Serial.println("维修复位失败：新零位无法保存，红灯继续锁定");
    return false;
  }
  tiltDegrees = 0.0f;
  rollDeltaDegrees = 0.0f;
  pitchDeltaDegrees = 0.0f;
  commitState(State::NORMAL, "staff_maintenance_reset");
  setRedLed(false, "工作人员已归位并把当前位置确认为新的0°");
  maintenanceInProgress = false;
  Serial.println("维修复位成功：新0°已保存，锁定告警已解除");
  return true;
}

void handleCommand(String command) {
  command.trim();
  command.toUpperCase();
  if (command == "STATUS") {
    printStatus();
  } else if (command == "TEST") {
    runOutputSelfTest();
  } else if (command == "WTEST") {
    startWaterOutputSelfTest();
  } else if (command == "HALL") {
    printHallStatus();
  } else if (command == "SCAN") {
    scanI2cBus(true);
  } else if (command == "HELP") {
    printHelp();
  } else if (command == "CAL") {
    recalibrateZero("serial_calibration");
  } else if (command == "ACK") {
    completeMaintenanceReset();
  } else if (command == "CLEAR_CAL") {
    Preferences preferences;
    if (preferences.begin("tilt-switch", false)) {
      // Never erase the independently stored safety-alarm latch here.
      preferences.remove("cal-v2");
      preferences.end();
    }
    calibrated = false;
    commitState(State::CALIBRATION_REQUIRED, "calibration_cleared");
    Serial.println("CALIBRATION_CLEARED send CAL while cover is closed and still");
  } else if (command.length() > 0) {
    Serial.println("UNKNOWN_COMMAND send HELP");
  }
}

void pollSerialCommands() {
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n' || c == '\r') {
      if (commandBuffer.length() > 0) {
        handleCommand(commandBuffer);
        commandBuffer = "";
      }
    } else if (commandBuffer.length() < 40 && isPrintable(c)) {
      commandBuffer += c;
    }
  }
}

void pollZeroButton() {
  const uint32_t now = millis();
  const bool pressed = digitalRead(ZERO_BUTTON_PIN) == LOW;

  if (pressed) {
    if (zeroButtonPressedAtMs == 0) zeroButtonPressedAtMs = now;
    if (!zeroButtonArmed &&
        static_cast<uint32_t>(now - zeroButtonPressedAtMs) >= ZERO_BUTTON_HOLD_MS) {
      zeroButtonArmed = true;
      Serial.println(redLedOn
                         ? "BOOT长按已确认：松开后执行维修复位并重设0°"
                         : "BOOT长按已确认：松开后将自动重设0°");
    }
    return;
  }

  if (zeroButtonArmed) {
    zeroButtonArmed = false;
    zeroButtonPressedAtMs = 0;
    if (redLedOn) {
      completeMaintenanceReset();
    } else {
      Serial.println("请勿触碰模块，2秒后开始零位校准...");
      delay(ZERO_SETTLE_MS);
      recalibrateZero("boot_button_calibration");
    }
  } else {
    zeroButtonPressedAtMs = 0;
  }
}

bool initializeSensor() {
  if (!configureSensor()) return false;
  ImuSample sample;
  if (!readImu(sample)) return false;
  sensorOnline = true;
  lastGoodReadMs = millis();
  gravityEstimate = normalized(sample.accelG);
  fusionInitialized = magnitude(gravityEstimate) > 0.9f;
  lastFusionUs = micros();
  return true;
}

void begin() {
  cat1Serial.begin(CAT1_BAUD_RATE, SERIAL_8N1, CAT1_RX_PIN, CAT1_TX_PIN);
  cameraLinkSerial.begin(CAMERA_LINK_BAUD_RATE, SERIAL_8N1, -1,
                         CAMERA_LINK_TX_PIN);
  pinMode(RED_LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(ZERO_BUTTON_PIN, INPUT_PULLUP);
  pinMode(ULTRASONIC_TRIG_PIN, OUTPUT);
  pinMode(ULTRASONIC_ECHO_PIN, INPUT);
  pinMode(WATER_LED_PIN, OUTPUT);
  pinMode(HALL_LEFT_PIN, INPUT_PULLUP);
  pinMode(HALL_RIGHT_PIN, INPUT_PULLUP);
  digitalWrite(ULTRASONIC_TRIG_PIN, LOW);
  digitalWrite(WATER_LED_PIN, LOW);
  ledcSetup(PASSIVE_BUZZER_LEDC_CHANNEL, WATER_LOW_TONE_HZ, 10);
  ledcAttachPin(PASSIVE_BUZZER_PIN, PASSIVE_BUZZER_LEDC_CHANNEL);
  ledcWriteTone(PASSIVE_BUZZER_LEDC_CHANNEL, 0);
  attachInterrupt(digitalPinToInterrupt(ULTRASONIC_ECHO_PIN),
                  ultrasonicEchoInterrupt, CHANGE);
  digitalWrite(BUZZER_PIN, BUZZER_ACTIVE_HIGH ? LOW : HIGH);
  redLedOn = loadAlarmLatch();
  digitalWrite(RED_LED_PIN, redLedOn ? HIGH : LOW);
  if (redLedOn) {
    Serial.println(">>> 已恢复断电前的锁定告警：等待工作人员归位并重设0°");
  }
  commandBuffer.reserve(48);
  stateSinceMs = millis();
  candidateSinceMs = stateSinceMs;
  hallLeftRawPresent = digitalRead(HALL_LEFT_PIN) == LOW;
  hallRightRawPresent = digitalRead(HALL_RIGHT_PIN) == LOW;
  hallLeftPresent = hallLeftRawPresent;
  hallRightPresent = hallRightRawPresent;
  hallStableState = classifyHallState(hallLeftPresent, hallRightPresent);
  hallCandidateState = hallStableState;
  hallCandidateSinceMs = stateSinceMs;

  const bool hadStoredCalibration = loadCalibration();
  Wire.begin(SDA_PIN, SCL_PIN);
  // 100 kHz is deliberately conservative for jumper wires and clone boards.
  Wire.setClock(100000);
  delay(50);

  if (!initializeSensor()) {
    Serial.println("SENSOR_FAULT MPU6050 not found at 0x68/0x69; retrying every 2s");
    commitState(State::SENSOR_FAULT, "startup_i2c_failure");
    return;
  }

  // Always estimate fresh gyro bias. Only replace the installation reference
  // when no valid reference exists yet.
  if (performCalibration(!hadStoredCalibration)) {
    if (!hadStoredCalibration) {
      if (saveCalibration()) Serial.println("CALIBRATION_SAVED");
    }
    commitState(State::NORMAL,
                hadStoredCalibration ? "startup_ready_saved_reference"
                                     : "startup_initial_calibration");
  } else if (hadStoredCalibration) {
    calibrated = true;
    Serial.println("WARNING startup was moving; using stored gyro bias and reference");
    commitState(State::NORMAL, "startup_using_saved_calibration");
  } else {
    calibrated = false;
    commitState(State::CALIBRATION_REQUIRED, "startup_calibration_failed");
  }

  Serial.println("系统就绪");
  Serial.println("US-100已启用：Trig/Tx->GPIO16，Echo/Rx->GPIO17；监测探头到水面的距离");
  Serial.println("独立水位声光已启用：第二灯->GPIO5，无源蜂鸣器信号->GPIO6");
  Serial.println("双侧霍尔已启用：左侧DO->GPIO7，右侧DO->GPIO10；双侧离位10秒后GPIO2灯常亮、GPIO6无源蜂鸣器700Hz鸣叫");
  Serial.println("M100PG上传串口已启用：ESP32 TX->GPIO18，RX->GPIO21，115200 8N1");
  Serial.println("CAMERA_LINK enabled: GPIO13 TX -> camera GPIO14 RX, 115200 8N1");
  printHallStatus();
  Serial.println("长按BOOT：红灯锁定时维修复位并重设0°；无告警时普通校准");
  Serial.println("倾斜自动恢复：回到正常区间连续20秒后自动解除倾斜报警；期间再次倾斜会重新计时");
  runOutputSelfTest();
}

void update() {
  pollSerialCommands();
  pollZeroButton();
  updateHallInputs();
  updateHallAlarmController();
  updateUltrasonicController();
  updateWaterSignalOutputs();
  const uint32_t now = millis();

  if (!sensorOnline) {
    if (static_cast<uint32_t>(now - lastRetryMs) >= SENSOR_RETRY_MS) {
      lastRetryMs = now;
      if (initializeSensor()) {
        Serial.println("SENSOR_RECOVERED");
        if (!calibrated) {
          if (performCalibration(true) && saveCalibration()) {
            Serial.println("CALIBRATION_SAVED");
          } else {
            commitState(State::CALIBRATION_REQUIRED,
                        "sensor_recovered_calibration_required");
          }
        }
      }
    }
  } else if (static_cast<uint32_t>(now - lastSampleMs) >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    ImuSample sample;
    if (!readImu(sample)) {
      ++totalReadFailures;
      if (static_cast<uint32_t>(now - lastGoodReadMs) >= SENSOR_FAULT_MS) {
        sensorOnline = false;
        commitState(State::SENSOR_FAULT, "i2c_timeout");
      }
    } else {
      lastGoodReadMs = now;
      updatePose(sample);
      if (calibrated) {
        acceptCandidate(classifyWithHysteresis(tiltDegrees, stableState));
      }
    }
  }

  updateRedLedController();
  updateTiltLedOutput();
  updateBuzzerController();
  updateCat1Uplink();

  if (static_cast<uint32_t>(now - lastStatusMs) >= STATUS_INTERVAL_MS) {
    lastStatusMs = now;
    printBriefStatus();
  }
}

}  // namespace TiltSwitch

void setup() {
  Serial.begin(115200);
  delay(700);
  Serial.printf("BOARD ESP32-S3 flash=%uMB psram=%uMB firmware=tilt-v2\n",
                ESP.getFlashChipSize() / (1024U * 1024U),
                ESP.getPsramSize() / (1024U * 1024U));
  TiltSwitch::begin();
}

void loop() {
  TiltSwitch::update();
  delay(1);
}
