#include "clip.h"

#include <cstring>

namespace {

void put16(uint8_t* dest, uint16_t value) {
  dest[0] = static_cast<uint8_t>(value & 0xff);
  dest[1] = static_cast<uint8_t>((value >> 8) & 0xff);
}

void put32(uint8_t* dest, uint32_t value) {
  dest[0] = static_cast<uint8_t>(value & 0xff);
  dest[1] = static_cast<uint8_t>((value >> 8) & 0xff);
  dest[2] = static_cast<uint8_t>((value >> 16) & 0xff);
  dest[3] = static_cast<uint8_t>((value >> 24) & 0xff);
}

}  // namespace

bool clipPush(Clip& clip, int16_t sample) {
  if (clip.count >= clip.capacity) return false;
  clip.samples[clip.count++] = sample;
  return true;
}

int32_t clipMeanAbs(const Clip& clip) {
  if (clip.count == 0) return 0;
  int64_t sum = 0;
  for (size_t i = 0; i < clip.count; ++i) {
    const int16_t sample = clip.samples[i];
    sum += sample < 0 ? -static_cast<int32_t>(sample) : sample;
  }
  return static_cast<int32_t>(sum / static_cast<int64_t>(clip.count));
}

bool clipHasSpeech(const Clip& clip) {
  return clip.count > 0 && clipMeanAbs(clip) >= kSpeechMeanAbs;
}

int16_t shapeMicSample(MicShape& shape, int16_t sample) {
  const int32_t x = sample >> 2;
  int32_t y = x - shape.prevIn + (shape.prevOut * 63) / 64;
  shape.prevIn = x;
  shape.prevOut = y;
  if (y > 32767) y = 32767;
  if (y < -32768) y = -32768;
  return static_cast<int16_t>(y);
}

bool clipAboveFloor(NoiseFloor& floor, int32_t meanAbs) {
  if (!floor.set) {
    floor.level = meanAbs;
    floor.set = true;
    return false;
  }
  if (meanAbs <= floor.level) {
    floor.level = meanAbs;
    return false;
  }
  if (meanAbs < floor.level * 3) {
    floor.level = (floor.level * 3 + meanAbs) / 4;
    return false;
  }
  return true;
}

void clipWipe(Clip& clip) {
  if (clip.samples != nullptr && clip.count > 0) {
    std::memset(clip.samples, 0, clip.count * sizeof(int16_t));
  }
  clip.count = 0;
}

size_t clipWriteWav(uint8_t* dest, const Clip& clip) {
  if (dest == nullptr || clip.count == 0) return 0;
  const uint32_t dataBytes = static_cast<uint32_t>(clip.count * sizeof(int16_t));
  std::memcpy(dest, "RIFF", 4);
  put32(dest + 4, 36 + dataBytes);
  std::memcpy(dest + 8, "WAVE", 4);
  std::memcpy(dest + 12, "fmt ", 4);
  put32(dest + 16, 16);
  put16(dest + 20, 1);
  put16(dest + 22, 1);
  put32(dest + 24, static_cast<uint32_t>(kSampleRate));
  put32(dest + 28, static_cast<uint32_t>(kSampleRate) * 2);
  put16(dest + 32, 2);
  put16(dest + 34, 16);
  std::memcpy(dest + 36, "data", 4);
  put32(dest + 40, dataBytes);
  return kWavHeaderBytes + dataBytes;
}

size_t writeWavHeader(uint8_t* dest, const Clip& clip) {
  if (!clipHasSpeech(clip)) return 0;
  return clipWriteWav(dest, clip);
}

size_t clipEmit(uint8_t* dest, const Clip& clip) {
  if (clip.count < kChunkSamples) return 0;
  return writeWavHeader(dest, clip);
}
