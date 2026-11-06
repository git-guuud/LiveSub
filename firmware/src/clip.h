#pragma once

#include <cstddef>
#include <cstdint>

// One short PCM clip. 16 kHz, 16-bit, mono. Two seconds is the cap:
// the T-Display has no PSRAM, and the relay accepts one chunk under 256 KB.
// Mean absolute level at or above kSpeechMeanAbs is speech. Silence is not a clip.

static constexpr int kSampleRate = 16000;
static constexpr size_t kMaxSamples = static_cast<size_t>(kSampleRate) * 2;
static constexpr int32_t kSpeechMeanAbs = 400;
static constexpr size_t kWavHeaderBytes = 44;

// One chunk is the whole two-second buffer. 16 kHz 16-bit mono is about 64 KB.
// The relay accepts one chunk under 256 KB.
static constexpr size_t kRelayChunkBytes = 256 * 1024;
static constexpr size_t kChunkSamples = kMaxSamples;

static_assert(kChunkSamples <= kMaxSamples, "one chunk fits in the buffer");
static_assert(kWavHeaderBytes + kChunkSamples * sizeof(int16_t) <= kRelayChunkBytes, "one chunk fits the relay");

struct Clip {
  int16_t* samples;
  size_t capacity;
  size_t count;
};

bool clipPush(Clip& clip, int16_t sample);
int32_t clipMeanAbs(const Clip& clip);
bool clipHasSpeech(const Clip& clip);
void clipWipe(Clip& clip);

// The room's quiet level. The first window only measures it.
// A later window is speech when it is at least three times that level.
struct NoiseFloor {
  int32_t level;
  bool set;
};

bool clipAboveFloor(NoiseFloor& floor, int32_t meanAbs);

// The INMP441's loudest 16 bits clip when a voice is close to the mic.
// Drop 12 dB, then take out the slow drift from a loose ground.
struct MicShape {
  int32_t prevIn;
  int32_t prevOut;
};

int16_t shapeMicSample(MicShape& shape, int16_t sample);

// Writes a PCM WAV header in front of samples that already sit at dest + 44.
// Returns the total byte count, or 0 when the clip is empty or not speech.
size_t writeWavHeader(uint8_t* dest, const Clip& clip);
size_t clipWriteWav(uint8_t* dest, const Clip& clip);

// A window that is still filling returns 0 and leaves the samples.
// A full window of silence returns 0. A full window of speech returns the WAV size.
size_t clipEmit(uint8_t* dest, const Clip& clip);
