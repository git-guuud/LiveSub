#include "screen_state.h"

#include <ArduinoJson.h>

#include <cstring>

namespace {

void copyField(char* dest, size_t cap, const char* src) {
  size_t i = 0;
  if (src != nullptr) {
    for (; src[i] != '\0' && i + 1 < cap; ++i) dest[i] = src[i];
  }
  dest[i] = '\0';
}

bool knownFace(const char* face) {
  return std::strcmp(face, "companion") == 0 || std::strcmp(face, "live") == 0 ||
         std::strcmp(face, "not_linked") == 0 || std::strcmp(face, "locked") == 0;
}

bool cutsMic(const char* face) {
  return std::strcmp(face, "locked") == 0 || std::strcmp(face, "not_linked") == 0;
}

}  // namespace

void blankScreen(ScreenState& state) {
  copyField(state.face, sizeof state.face, "not_linked");
  state.mic_power = false;
}

void lockScreen(ScreenState& state) {
  copyField(state.face, sizeof state.face, "locked");
  state.mic_power = false;
}

bool applyScreenJson(ScreenState& state, const char* json, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, json, length) != DeserializationError::Ok) return false;

  const char* type = doc["type"];
  const char* face = doc["face"];
  if (type == nullptr || std::strcmp(type, "screen") != 0) return false;
  if (face == nullptr || !knownFace(face)) return false;
  if (!doc["mic_power"].is<bool>()) return false;

  copyField(state.face, sizeof state.face, face);
  state.mic_power = cutsMic(face) ? false : doc["mic_power"].as<bool>();
  return true;
}

const char* faceLabel(const ScreenState& state) {
  if (std::strcmp(state.face, "companion") == 0) return "Companion";
  if (std::strcmp(state.face, "live") == 0) return "Live";
  if (std::strcmp(state.face, "locked") == 0) return kLockText;
  return "Not linked";
}

bool faceUsesRedBorder(const ScreenState& state) {
  return std::strcmp(state.face, "locked") == 0;
}

bool micRailOn(const ScreenState& state, bool linkUp) {
  if (!linkUp || !state.mic_power) return false;
  return !cutsMic(state.face);
}
