#pragma once

#include <cstddef>

// One relay `screen` frame. The glass stores the face and the mic rail only.
// A transcript, a translation, and a reminder are not on this frame.

static constexpr char kLockText[] = "MIC LOCKED: ENCLAVE OFFLINE";

struct ScreenState {
  char face[16];
  bool mic_power;
};

// Not linked, mic off. A dropped relay socket uses this. It is not the enclave lock.
void blankScreen(ScreenState& state);

// Enclave lock. Mic off. The red border is faceUsesRedBorder.
void lockScreen(ScreenState& state);

// Returns false for reject frames, malformed JSON, or an unknown face.
// A false return leaves `state` as it was.
bool applyScreenJson(ScreenState& state, const char* json, size_t length);

const char* faceLabel(const ScreenState& state);
bool faceUsesRedBorder(const ScreenState& state);

// The rail follows the frame. Not linked and the enclave lock keep it off.
// A closed phone is not either of those faces, so it does not cut the rail.
bool micRailOn(const ScreenState& state, bool linkUp);
