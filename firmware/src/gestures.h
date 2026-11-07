#pragma once

#include <cstdint>

// GPIO0 and GPIO35 as levels. Pressed is true (the pin reads low).
// A short press of GPIO0 is the mode toggle. A press that is already down
// when the machine starts, or held past a tap, sends nothing.
// GPIO35 is ignored. It does not start a capture.

enum class Gesture : uint8_t { none, press };

struct GestureMachine {
  bool bootStable;
  bool bootRaw;
  uint32_t bootRawAt;
  uint32_t bootDownAt;
  bool bootIgnoreRelease;
};

void gestureBegin(GestureMachine& machine, bool bootDown, bool holdDown, uint32_t nowMs);
Gesture gesturePoll(GestureMachine& machine, bool bootDown, bool holdDown, uint32_t nowMs);

const char* gestureEvent(Gesture gesture);

// The one text frame a short press sends on the badge socket.
const char* pressMessage();
