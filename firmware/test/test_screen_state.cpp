#include "screen_state.h"

#include <unity.h>

#include <cstring>

void setUp() {}
void tearDown() {}

void test_companion_live_not_linked_and_the_red_lock() {
  ScreenState state;
  blankScreen(state);

  const char* companion = "{\"type\":\"screen\",\"face\":\"companion\",\"mic_power\":true}";
  TEST_ASSERT_TRUE(applyScreenJson(state, companion, std::strlen(companion)));
  TEST_ASSERT_EQUAL_STRING("companion", state.face);
  TEST_ASSERT_EQUAL_STRING("Companion", faceLabel(state));
  TEST_ASSERT_FALSE(faceUsesRedBorder(state));
  TEST_ASSERT_TRUE(state.mic_power);
  TEST_ASSERT_TRUE(micRailOn(state, true));

  const char* live =
      "{\"type\":\"screen\",\"face\":\"live\",\"mic_power\":true,\"line1\":\"I'll meet Kenji on Thursday.\"}";
  TEST_ASSERT_TRUE(applyScreenJson(state, live, std::strlen(live)));
  TEST_ASSERT_EQUAL_STRING("live", state.face);
  TEST_ASSERT_EQUAL_STRING("Live", faceLabel(state));
  TEST_ASSERT_FALSE(faceUsesRedBorder(state));
  TEST_ASSERT_TRUE(state.mic_power);
  TEST_ASSERT_TRUE(micRailOn(state, true));

  const char* unlinked = "{\"type\":\"screen\",\"face\":\"not_linked\",\"mic_power\":true}";
  TEST_ASSERT_TRUE(applyScreenJson(state, unlinked, std::strlen(unlinked)));
  TEST_ASSERT_EQUAL_STRING("not_linked", state.face);
  TEST_ASSERT_EQUAL_STRING("Not linked", faceLabel(state));
  TEST_ASSERT_FALSE(faceUsesRedBorder(state));
  TEST_ASSERT_FALSE(state.mic_power);
  TEST_ASSERT_FALSE(micRailOn(state, true));

  const char* locked =
      "{\"type\":\"screen\",\"face\":\"locked\",\"mic_power\":true,"
      "\"line1\":\"cached subtitle\",\"line2\":\"Meet Kenji Thursday\"}";
  TEST_ASSERT_TRUE(applyScreenJson(state, locked, std::strlen(locked)));
  TEST_ASSERT_EQUAL_STRING("locked", state.face);
  TEST_ASSERT_EQUAL_STRING(kLockText, faceLabel(state));
  TEST_ASSERT_TRUE(faceUsesRedBorder(state));
  TEST_ASSERT_FALSE(state.mic_power);
  TEST_ASSERT_FALSE(micRailOn(state, true));
}

void test_a_closed_phone_is_not_the_lock() {
  ScreenState state;
  blankScreen(state);
  const char* companion = "{\"type\":\"screen\",\"face\":\"companion\",\"mic_power\":true}";
  TEST_ASSERT_TRUE(applyScreenJson(state, companion, std::strlen(companion)));
  TEST_ASSERT_EQUAL_STRING("Companion", faceLabel(state));
  TEST_ASSERT_TRUE(micRailOn(state, true));
  TEST_ASSERT_FALSE(micRailOn(state, false));
  TEST_ASSERT_FALSE(faceUsesRedBorder(state));
}

void test_unlink_clears_live_and_the_lock_is_separate() {
  ScreenState state;
  const char* live = "{\"type\":\"screen\",\"face\":\"live\",\"mic_power\":true}";
  TEST_ASSERT_TRUE(applyScreenJson(state, live, std::strlen(live)));

  blankScreen(state);
  TEST_ASSERT_EQUAL_STRING("not_linked", state.face);
  TEST_ASSERT_EQUAL_STRING("Not linked", faceLabel(state));
  TEST_ASSERT_FALSE(state.mic_power);
  TEST_ASSERT_FALSE(faceUsesRedBorder(state));

  lockScreen(state);
  TEST_ASSERT_EQUAL_STRING("locked", state.face);
  TEST_ASSERT_EQUAL_STRING(kLockText, faceLabel(state));
  TEST_ASSERT_FALSE(state.mic_power);
  TEST_ASSERT_TRUE(faceUsesRedBorder(state));
}

void test_reject_and_the_old_subtitle_frame_leave_the_glass() {
  ScreenState state;
  const char* live = "{\"type\":\"screen\",\"face\":\"live\",\"mic_power\":true}";
  TEST_ASSERT_TRUE(applyScreenJson(state, live, std::strlen(live)));

  const char* reject = "{\"type\":\"reject\",\"reason\":\"phone_closed\"}";
  TEST_ASSERT_FALSE(applyScreenJson(state, reject, std::strlen(reject)));
  TEST_ASSERT_EQUAL_STRING("live", state.face);
  TEST_ASSERT_TRUE(state.mic_power);

  const char* old =
      "{\"type\":\"screen\",\"direction\":\"wearer\",\"phase\":\"lines\","
      "\"line1\":\"Hello\",\"line2\":\"Cue\",\"pinned\":false,\"mic_power\":true}";
  TEST_ASSERT_FALSE(applyScreenJson(state, old, std::strlen(old)));
  TEST_ASSERT_EQUAL_STRING("live", state.face);
  TEST_ASSERT_EQUAL_STRING("Live", faceLabel(state));

  const char* flip = "{\"type\":\"flip\"}";
  TEST_ASSERT_FALSE(applyScreenJson(state, flip, std::strlen(flip)));
  TEST_ASSERT_EQUAL_STRING("live", state.face);
}

void test_bad_face_does_not_replace_the_glass() {
  ScreenState state;
  blankScreen(state);
  const char* good = "{\"type\":\"screen\",\"face\":\"companion\",\"mic_power\":false}";
  TEST_ASSERT_TRUE(applyScreenJson(state, good, std::strlen(good)));
  TEST_ASSERT_FALSE(state.mic_power);
  TEST_ASSERT_FALSE(micRailOn(state, true));

  const char* bad = "{\"type\":\"screen\",\"face\":\"listening\",\"mic_power\":true}";
  TEST_ASSERT_FALSE(applyScreenJson(state, bad, std::strlen(bad)));
  TEST_ASSERT_EQUAL_STRING("companion", state.face);
  TEST_ASSERT_FALSE(state.mic_power);

  const char* broken = "{\"type\":\"screen\",\"face\":\"live\"}";
  TEST_ASSERT_FALSE(applyScreenJson(state, broken, std::strlen(broken)));
  TEST_ASSERT_EQUAL_STRING("companion", state.face);
}

void run_gesture_tests();

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_companion_live_not_linked_and_the_red_lock);
  RUN_TEST(test_a_closed_phone_is_not_the_lock);
  RUN_TEST(test_unlink_clears_live_and_the_lock_is_separate);
  RUN_TEST(test_reject_and_the_old_subtitle_frame_leave_the_glass);
  RUN_TEST(test_bad_face_does_not_replace_the_glass);
  run_gesture_tests();
  return UNITY_END();
}
