#include <Arduino.h>

const int ledPin = 13;
const int pwmPin = 9; // Uno 的 PWM 腳位之一

const int sampleRate = 1000; // 每秒更新 1000 次（1ms）
const int waveFrequency = 50; // 正弦波頻率 50Hz
const int samplesPerCycle = sampleRate / waveFrequency; // 每個週期有 20 個樣本點

int sineTable[samplesPerCycle]; // 儲存預先計算的正弦波 PWM 值

// 加法函式
int myFunction(int x, int y) {
  return x + y;
}

void setup() {
  int result = myFunction(2, 3);
  pinMode(ledPin, OUTPUT);
  pinMode(pwmPin, OUTPUT);
  Serial.begin(9600);

  // 初始化正弦波表（範圍：0~255）
  for (int i = 0; i < samplesPerCycle; i++) {
    sineTable[i] = (int)(127.5 * sin(2 * PI * i / samplesPerCycle) + 127.5);
  }
}

void loop() {
  static unsigned long lastUpdateTime = 0;
  static int waveIndex = 0;

  unsigned long now = millis();

  // 每 1ms 更新 PWM 波形
  if (now - lastUpdateTime >= 1) {
    analogWrite(pwmPin, sineTable[waveIndex]);
    waveIndex = (waveIndex + 1) % samplesPerCycle;
    lastUpdateTime = now;
  }

  // 顯示訊息與 LED 閃爍（每 500ms）
  static unsigned long lastBlinkTime = 0;
  static bool ledState = false;
  if (now - lastBlinkTime >= 500) {
    ledState = !ledState;
    digitalWrite(ledPin, ledState ? HIGH : LOW);
    Serial.println("Hello, World!");
    lastBlinkTime = now;
  }
}
