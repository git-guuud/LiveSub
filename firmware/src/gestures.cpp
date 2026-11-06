#include "gestures.h"

namespace {

constexpr uint32_t kDebounceMs = 25;
constexpr uint32_t kTapMaxMs = 500;

void track(bool down, bool& raw, uint32_t& rawAt, uint32_t nowMs) {
  if (down == raw) return;
  raw = down;
  rawAt = nowMs;
}

bool settled(bool& stable, bool raw, uint32_t rawAt, uint32_t nowMs) {
  if (raw == stable) return false;
  if (nowMs - rawAt < kDebounceMs) return false;
  stable = raw;
  return true;
}

}  // namespace

void gestureBegin(GestureMachine& machine, bool bootDown, bool holdDown, uint32_t nowMs) {
  (void)holdDown;
  machine.bootStable = bootDown;
  machine.bootRaw = bootDown;
  machine.bootRawAt = nowMs;
  machine.bootDownAt = nowMs;
  machine.bootIgnoreRelease = bootDown;
}

const char* gestureEvent(Gesture gesture) {
  if (gesture == Gesture::press) return "press";
  return nullptr;
}

const char* pressMessage() { return "{\"type\":\"press\"}"; }

Gesture gesturePoll(GestureMachine& machine, bool bootDown, bool holdDown, uint32_t nowMs) {
  (void)holdDown;

  track(bootDown, machine.bootRaw, machine.bootRawAt, nowMs);
  if (!settled(machine.bootStable, machine.bootRaw, machine.bootRawAt, nowMs)) return Gesture::none;

  if (machine.bootStable) {
    machine.bootDownAt = nowMs;
    return Gesture::none;
  }
  if (machine.bootIgnoreRelease) {
    machine.bootIgnoreRelease = false;
    return Gesture::none;
  }
  if (nowMs - machine.bootDownAt > kTapMaxMs) return Gesture::none;
  return Gesture::press;
}
