#include "clip.h"
#include "gestures.h"
#include "pins.h"

#include <unity.h>

#include <cstring>
#include <vector>

namespace {

GestureMachine machine;

void downAt(uint32_t t) { gesturePoll(machine, true, false, t); }

void upAt(uint32_t t) { gesturePoll(machine, false, false, t); }

}  // namespace

void test_short_press_sends_the_mode_toggle() {
  gestureBegin(machine, false, false, 0);
  downAt(0);
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, true, false, 25)));
  upAt(80);
  const Gesture press = gesturePoll(machine, false, false, 105);
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::press), static_cast<int>(press));
  TEST_ASSERT_EQUAL_STRING("press", gestureEvent(press));
  TEST_ASSERT_EQUAL_STRING("{\"type\":\"press\"}", pressMessage());
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, false, false, 106)));
}

void test_a_second_short_press_is_another_toggle() {
  gestureBegin(machine, false, false, 0);
  downAt(0);
  gesturePoll(machine, true, false, 25);
  upAt(80);
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::press), static_cast<int>(gesturePoll(machine, false, false, 105)));

  downAt(200);
  gesturePoll(machine, true, false, 225);
  upAt(260);
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::press), static_cast<int>(gesturePoll(machine, false, false, 285)));
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, false, false, 800)));
}

void test_a_hold_past_a_tap_sends_nothing() {
  gestureBegin(machine, false, false, 0);
  downAt(0);
  gesturePoll(machine, true, false, 25);
  upAt(800);
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, false, false, 825)));
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, false, false, 1300)));
}

void test_a_press_held_at_boot_sends_nothing() {
  gestureBegin(machine, true, true, 0);
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, true, true, 2000)));
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, false, false, 2000)));
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, false, false, 2025)));
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, false, false, 2500)));

  downAt(3000);
  gesturePoll(machine, true, false, 3025);
  upAt(3100);
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::press), static_cast<int>(gesturePoll(machine, false, false, 3125)));
}

void test_gpio35_does_not_start_a_capture() {
  gestureBegin(machine, false, false, 0);
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, false, true, 0)));
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, false, true, 25)));
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, false, true, 2000)));
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, false, false, 2100)));
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, false, false, 2125)));
  TEST_ASSERT_NULL(gestureEvent(Gesture::none));

  downAt(3000);
  gesturePoll(machine, true, true, 3025);
  upAt(3100);
  const Gesture press = gesturePoll(machine, false, true, 3125);
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::press), static_cast<int>(press));
  TEST_ASSERT_EQUAL_STRING("press", gestureEvent(press));
}

void test_bounce_shorter_than_debounce_is_ignored() {
  gestureBegin(machine, false, false, 0);
  gesturePoll(machine, true, false, 0);
  gesturePoll(machine, false, false, 10);
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, true, false, 20)));
  TEST_ASSERT_EQUAL(static_cast<int>(Gesture::none), static_cast<int>(gesturePoll(machine, true, false, 50)));
}

void test_silence_is_not_a_clip() {
  int16_t samples[8];
  Clip clip{samples, 8, 0};
  for (int i = 0; i < 8; ++i) clipPush(clip, 0);
  TEST_ASSERT_FALSE(clipHasSpeech(clip));

  clipWipe(clip);
  TEST_ASSERT_EQUAL(0, clip.count);
  for (int i = 0; i < 8; ++i) TEST_ASSERT_EQUAL(0, samples[i]);

  int16_t limited[4];
  Clip full{limited, 4, 0};
  for (int i = 0; i < 4; ++i) TEST_ASSERT_TRUE(clipPush(full, 1));
  TEST_ASSERT_FALSE(clipPush(full, 1));

  for (int i = 0; i < 8; ++i) samples[i] = 2000;
  clip.count = 8;
  TEST_ASSERT_TRUE(clipHasSpeech(clip));

  uint8_t wav[44 + 16];
  std::memcpy(wav + 44, samples, sizeof samples);
  Clip voiced{reinterpret_cast<int16_t*>(wav + 44), 8, 8};
  TEST_ASSERT_EQUAL(44 + 16, writeWavHeader(wav, voiced));
  TEST_ASSERT_EQUAL_MEMORY("RIFF", wav, 4);
  TEST_ASSERT_EQUAL_MEMORY("WAVE", wav + 8, 4);
  TEST_ASSERT_EQUAL(1, wav[20]);
  TEST_ASSERT_EQUAL(1, wav[22]);
  TEST_ASSERT_EQUAL(0x80, wav[24]);
  TEST_ASSERT_EQUAL(0x3e, wav[25]);
  TEST_ASSERT_EQUAL(16, wav[34]);

  clipWipe(voiced);
  TEST_ASSERT_EQUAL(0, voiced.count);
  TEST_ASSERT_EQUAL(0, writeWavHeader(wav, voiced));
}

void test_a_short_window_of_silence_is_not_uploaded() {
  TEST_ASSERT_TRUE(kChunkSamples <= kMaxSamples);
  TEST_ASSERT_TRUE(kWavHeaderBytes + kChunkSamples * sizeof(int16_t) <= kRelayChunkBytes);

  std::vector<int16_t> samples(kChunkSamples, 0);
  Clip quiet{samples.data(), kMaxSamples, kChunkSamples - 1};
  uint8_t wav[kWavHeaderBytes];
  TEST_ASSERT_EQUAL(0, clipEmit(wav, quiet));

  quiet.count = kChunkSamples;
  TEST_ASSERT_EQUAL(0, clipEmit(wav, quiet));
  TEST_ASSERT_EQUAL(kChunkSamples, quiet.count);

  for (size_t i = 0; i < kChunkSamples; ++i) samples[i] = 2000;
  const size_t bytes = clipEmit(wav, quiet);
  TEST_ASSERT_EQUAL(kWavHeaderBytes + kChunkSamples * sizeof(int16_t), bytes);
  TEST_ASSERT_TRUE(bytes <= kRelayChunkBytes);
}

void test_a_close_voice_is_turned_down() {
  MicShape shape{};
  TEST_ASSERT_EQUAL(8191, shapeMicSample(shape, 32767));
  int16_t settled = 0;
  for (int i = 0; i < 4000; ++i) settled = shapeMicSample(shape, 32767);
  TEST_ASSERT_TRUE(settled > -200 && settled < 200);
  MicShape tone{};
  const int16_t up = shapeMicSample(tone, 8000);
  const int16_t down = shapeMicSample(tone, -8000);
  TEST_ASSERT_TRUE(up > 1000);
  TEST_ASSERT_TRUE(down < -1000);
}

void test_a_steady_room_is_not_uploaded() {
  NoiseFloor floor{};
  TEST_ASSERT_FALSE(clipAboveFloor(floor, 2500));
  TEST_ASSERT_EQUAL(2500, floor.level);
  TEST_ASSERT_FALSE(clipAboveFloor(floor, 2500));
  TEST_ASSERT_FALSE(clipAboveFloor(floor, 3300));
  TEST_ASSERT_TRUE(clipAboveFloor(floor, 12000));
  TEST_ASSERT_FALSE(clipAboveFloor(floor, 2000));
  TEST_ASSERT_EQUAL(2000, floor.level);
}

void test_the_gpio_map_stays() {
  TEST_ASSERT_EQUAL(0, kPinBoot);
  TEST_ASSERT_EQUAL(35, kPinHold);
  TEST_ASSERT_EQUAL(27, kPinMicPower);
  TEST_ASSERT_EQUAL(26, kPinI2sBclk);
  TEST_ASSERT_EQUAL(25, kPinI2sLrclk);
  TEST_ASSERT_EQUAL(33, kPinI2sData);
  TEST_ASSERT_EQUAL(4, kPinBacklight);
  TEST_ASSERT_EQUAL(18, kPinSclk);
  TEST_ASSERT_EQUAL(19, kPinMosi);
  TEST_ASSERT_EQUAL(5, kPinCs);
  TEST_ASSERT_EQUAL(16, kPinDc);
  TEST_ASSERT_EQUAL(23, kPinRst);
}

void run_gesture_tests() {
  RUN_TEST(test_short_press_sends_the_mode_toggle);
  RUN_TEST(test_a_second_short_press_is_another_toggle);
  RUN_TEST(test_a_hold_past_a_tap_sends_nothing);
  RUN_TEST(test_a_press_held_at_boot_sends_nothing);
  RUN_TEST(test_gpio35_does_not_start_a_capture);
  RUN_TEST(test_bounce_shorter_than_debounce_is_ignored);
  RUN_TEST(test_silence_is_not_a_clip);
  RUN_TEST(test_a_short_window_of_silence_is_not_uploaded);
  RUN_TEST(test_a_close_voice_is_turned_down);
  RUN_TEST(test_a_steady_room_is_not_uploaded);
  RUN_TEST(test_the_gpio_map_stays);
}
