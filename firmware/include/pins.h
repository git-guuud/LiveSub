#pragma once

// LilyGO T-Display v1.1 GPIO map.
//
// Display bus. These stay on the ST7789. The screen task does not retask them.
//   GPIO18  SCLK
//   GPIO19  MOSI
//   GPIO5   CS
//   GPIO16  DC
//   GPIO23  RST
//   GPIO4   backlight. Stays the backlight. Not a button and not mic power.
//
// Buttons. GPIO0 is read with the internal pull-up. This firmware never drives
// it, never holds it, and never resets on it, so a press cannot strap the bootloader.
//   GPIO0   short press sends the mode toggle. A press already down at boot,
//           or held longer than a tap, sends nothing.
//   GPIO35  input-only. Not a capture button. Not a clock and not mic power.
//   GPIO34  input-only battery sense. Not a clock and not mic power.
//
// INMP441, when it is wired. 3.3V and GND from the header. Tie the mic L/R pin
// to GND so it drives the left slot. GPIO27 goes HIGH to power the mic and LOW
// to cut it. Pull that gate down on the board so power stays off through reset.
//   GPIO26  BCLK
//   GPIO25  LRCLK
//   GPIO33  data into the ESP32
//   GPIO27  mic VDD gate

static constexpr int kPinSclk = 18;
static constexpr int kPinMosi = 19;
static constexpr int kPinCs = 5;
static constexpr int kPinDc = 16;
static constexpr int kPinRst = 23;
static constexpr int kPinBacklight = 4;

static constexpr int kPinBoot = 0;
static constexpr int kPinHold = 35;

static constexpr int kPinI2sBclk = 26;
static constexpr int kPinI2sLrclk = 25;
static constexpr int kPinI2sData = 33;
static constexpr int kPinMicPower = 27;

static_assert(kPinMicPower != kPinBoot && kPinMicPower != kPinHold, "mic power is not a button");
static_assert(kPinMicPower != 4 && kPinMicPower != 34, "mic power is not the backlight or an input-only pin");
static_assert(kPinI2sBclk != 18 && kPinI2sBclk != 19 && kPinI2sBclk != 5, "BCLK stays off the display bus");
static_assert(kPinI2sLrclk != 16 && kPinI2sLrclk != 23 && kPinI2sLrclk != 4, "LRCLK stays off the display bus");
static_assert(kPinI2sData != 34 && kPinI2sData != 35 && kPinI2sData != 0, "mic data is a free header pin");
