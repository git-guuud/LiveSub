#include "buttons.h"
#include "gestures.h"
#include "glass.h"
#include "mic_board.h"
#include "screen_state.h"

#include <WebSocketsClient.h>
#include <WiFi.h>

#include <cstring>

#if __has_include("secrets.h")
#include "secrets.h"
#else
#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#define RELAY_HOST "127.0.0.1"
#define RELAY_PORT 8787
#endif

namespace {

WebSocketsClient webSocket;
ScreenState shown;
GestureMachine gestures;
bool wifiStarted = false;
bool socketStarted = false;
bool dirty = false;
int lastWifi = -1;
NoiseFloor noise{};

void paintUnlinked() {
  blankScreen(shown);
  glassPaint(shown);
}

void onEvent(WStype_t type, uint8_t* payload, size_t length) {
  if (type == WStype_DISCONNECTED) {
    blankScreen(shown);
    dirty = true;
    Serial.println("Relay socket closed. Not linked.");
    return;
  }
  if (type != WStype_TEXT) return;
  if (!applyScreenJson(shown, reinterpret_cast<const char*>(payload), length)) return;
  dirty = true;
  Serial.print("Screen ");
  Serial.println(shown.face);
}

void startSocket() {
  webSocket.begin(RELAY_HOST, RELAY_PORT, "/ws");
  webSocket.onEvent(onEvent);
  webSocket.setReconnectInterval(2000);
  socketStarted = true;
  Serial.print("Relay ws://");
  Serial.print(RELAY_HOST);
  Serial.print(":");
  Serial.println(RELAY_PORT);
}

bool linkUp() {
  return wifiStarted && WiFi.status() == WL_CONNECTED && socketStarted && webSocket.isConnected();
}

}  // namespace

void setup() {
  Serial.begin(115200);
  glassBegin();
  buttonsBegin();
  micBoardBegin();
  gestureBegin(gestures, bootDown(), holdDown(), millis());
  paintUnlinked();

  if (WIFI_SSID[0] == '\0') {
    Serial.println("Wi-Fi is unset. Copy include/secrets.example.h to include/secrets.h");
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiStarted = true;
  Serial.print("Wi-Fi ");
  Serial.println(WIFI_SSID);
}

void loop() {
  if (wifiStarted) {
    const int status = WiFi.status();
    if (status != lastWifi) {
      lastWifi = status;
      Serial.print("Wi-Fi status ");
      Serial.println(status);
      if (status == WL_CONNECTED) {
        Serial.print("Wi-Fi IP ");
        Serial.println(WiFi.localIP());
      }
    }
    if (status == WL_CONNECTED) {
      if (!socketStarted) startSocket();
      webSocket.loop();
    } else if (socketStarted || std::strcmp(shown.face, "not_linked") != 0) {
      if (socketStarted) webSocket.disconnect();
      socketStarted = false;
      paintUnlinked();
      Serial.println("Wi-Fi down. Not linked.");
    }
  }

  const bool linked = linkUp();
  const Gesture gesture = gesturePoll(gestures, bootDown(), holdDown(), millis());
  if (linked && gesture == Gesture::press) webSocket.sendTXT(pressMessage());

  const bool micOn = micRailOn(shown, linked);
  micBoardSetPower(micOn);
  if (micOn) {
    micBoardRead();
    Clip& clip = micBoardClip();
    if (clip.count >= kChunkSamples) {
      uint8_t* wav = micBoardWav();
      const size_t bytes = clipEmit(wav, clip);
      const int32_t level = clipMeanAbs(clip);
      const bool speech = bytes > 0 && clipAboveFloor(noise, level);
      Serial.print("Level ");
      Serial.print(level);
      Serial.print(" floor ");
      Serial.println(noise.level);
      if (speech && linked && webSocket.sendBIN(wav, bytes)) {
        Serial.print("Clip sent ");
        Serial.println(bytes);
      } else if (bytes == 0) {
        Serial.println("Silence dropped.");
      } else {
        Serial.println("Clip not sent.");
      }
      clipWipe(clip);
    }
  }

  if (dirty) {
    dirty = false;
    glassPaint(shown);
  }
}
