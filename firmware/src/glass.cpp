#include "glass.h"

#include "pins.h"

#include <TFT_eSPI.h>

#include <cstring>

namespace {

TFT_eSPI tft;

constexpr int kWidth = 135;
constexpr int kHeight = 240;
constexpr int kBorder = 6;
constexpr size_t kTextCap = 64;
constexpr uint16_t kGlass = 0xF77C;
constexpr uint16_t kInk = 0x18C2;
constexpr uint16_t kLock = 0xE020;

void drawCentered(const char* text, uint8_t font, uint16_t color) {
  tft.setTextFont(font);
  tft.setTextColor(color, kGlass);
  const int maxW = kWidth - 2 * kBorder - 8;
  const int lineH = tft.fontHeight();

  char lines[6][kTextCap];
  int count = 0;
  const char* cursor = text;
  while (*cursor != '\0' && count < 6) {
    while (*cursor == ' ') ++cursor;
    if (*cursor == '\0') break;
    char row[kTextCap];
    size_t n = 0;
    const char* scan = cursor;
    const char* consumed = cursor;
    while (*scan != '\0') {
      while (*scan == ' ') ++scan;
      if (*scan == '\0') break;
      const char* word = scan;
      while (*scan != '\0' && *scan != ' ') ++scan;
      char trial[kTextCap];
      size_t tn = n;
      if (tn > 0) {
        if (tn + 1 >= sizeof trial) break;
        std::memcpy(trial, row, tn);
        trial[tn++] = ' ';
      }
      bool fitted = false;
      for (size_t take = static_cast<size_t>(scan - word); take > 0; --take) {
        if (tn + take >= sizeof trial) continue;
        std::memcpy(trial + tn, word, take);
        trial[tn + take] = '\0';
        if (tft.textWidth(trial) <= maxW) {
          std::memcpy(row, trial, tn + take + 1);
          n = tn + take;
          consumed = word + take;
          fitted = true;
          if (take == static_cast<size_t>(scan - word)) consumed = scan;
          break;
        }
        if (n > 0) break;
      }
      if (!fitted || consumed < scan) break;
    }
    if (n == 0) break;
    std::memcpy(lines[count], row, n + 1);
    ++count;
    cursor = consumed;
  }

  int y = (kHeight - count * lineH - (count > 0 ? (count - 1) * 2 : 0)) / 2;
  for (int i = 0; i < count; ++i) {
    int x = (kWidth - tft.textWidth(lines[i])) / 2;
    tft.setCursor(x, y);
    tft.print(lines[i]);
    y += lineH + 2;
  }
}

}  // namespace

void glassBegin() {
  // Backlight stays GPIO4. Buttons and the mic are configured in their own files.
  static_assert(kPinBacklight == 4, "backlight stays GPIO4");
  static_assert(kPinSclk == 18 && kPinMosi == 19, "display clock and data");
  static_assert(kPinCs == 5 && kPinDc == 16 && kPinRst == 23, "display bus");
  static_assert(TFT_BL == 4 && TFT_SCLK == 18 && TFT_MOSI == 19, "TFT_eSPI bus");
  static_assert(TFT_CS == 5 && TFT_DC == 16 && TFT_RST == 23, "TFT_eSPI bus");
  static_assert(kPinBoot == 0 && kPinHold == 35, "buttons stay on GPIO0 and GPIO35");

  tft.init();
  tft.setRotation(0);
  tft.fillScreen(kGlass);
}

void glassPaint(const ScreenState& state) {
  tft.fillScreen(kGlass);
  if (faceUsesRedBorder(state)) {
    for (int i = 0; i < kBorder; ++i) {
      tft.drawRect(i, i, kWidth - 2 * i, kHeight - 2 * i, kLock);
    }
  }
  const char* label = faceLabel(state);
  tft.setTextFont(4);
  const int maxW = kWidth - 2 * kBorder - 8;
  if (tft.textWidth(label) <= maxW) {
    const int lineH = tft.fontHeight();
    tft.setTextColor(kInk, kGlass);
    tft.setCursor((kWidth - tft.textWidth(label)) / 2, (kHeight - lineH) / 2);
    tft.print(label);
    return;
  }
  drawCentered(label, 2, kInk);
}
