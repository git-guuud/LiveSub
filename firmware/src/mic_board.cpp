#include "mic_board.h"

#include "pins.h"

#include <Arduino.h>
#include <ESP_I2S.h>

#include <cstring>

namespace {

constexpr size_t kStorageBytes = kWavHeaderBytes + kMaxSamples * sizeof(int16_t);

uint8_t storage[kStorageBytes];
Clip clip{reinterpret_cast<int16_t*>(storage + kWavHeaderBytes), kMaxSamples, 0};
I2SClass i2s;
MicShape shape{};
bool ready = false;
bool powered = false;

}  // namespace

void micBoardBegin() {
  static_assert(kPinMicPower == 27, "mic VDD gate is GPIO27");
  static_assert(kPinI2sBclk == 26 && kPinI2sLrclk == 25 && kPinI2sData == 33, "I2S header pins");
  pinMode(kPinMicPower, OUTPUT);
  digitalWrite(kPinMicPower, LOW);
  powered = false;

  i2s.setPins(kPinI2sBclk, kPinI2sLrclk, -1, kPinI2sData);
  i2s.setTimeout(10);
  ready = i2s.begin(I2S_MODE_STD, kSampleRate, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO,
                    I2S_STD_SLOT_LEFT);
  if (!ready) {
    Serial.println("I2S did not start.");
    return;
  }
  ready = i2s.configureRX(kSampleRate, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO,
                          I2S_RX_TRANSFORM_32_TO_16, I2S_STD_SLOT_LEFT);
  if (!ready) Serial.println("I2S capture did not start.");
}

void micBoardSetPower(bool on) {
  if (on == powered) return;
  digitalWrite(kPinMicPower, on ? HIGH : LOW);
  powered = on;
  if (!on) {
    shape = {};
    clipWipe(clip);
  }
}

Clip& micBoardClip() { return clip; }

uint8_t* micBoardWav() { return storage; }

void micBoardRead() {
  if (!ready || !powered || clip.count >= kChunkSamples) return;
  int16_t chunk[128];
  const size_t room = kChunkSamples - clip.count;
  const size_t ask = room < 128 ? room : 128;
  const size_t got = i2s.readBytes(reinterpret_cast<char*>(chunk), ask * sizeof(int16_t));
  const size_t samples = got / sizeof(int16_t);
  for (size_t i = 0; i < samples && clip.count < kChunkSamples; ++i) {
    clipPush(clip, shapeMicSample(shape, chunk[i]));
  }
}
