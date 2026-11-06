#include "buttons.h"

#include "pins.h"

#include <Arduino.h>

void buttonsBegin() {
  static_assert(kPinBoot == 0, "GPIO0 stays the boot button");
  static_assert(kPinHold == 35, "GPIO35 stays input-only and is not a capture button");
  pinMode(kPinBoot, INPUT_PULLUP);
  pinMode(kPinHold, INPUT);
}

bool bootDown() { return digitalRead(kPinBoot) == LOW; }

bool holdDown() { return digitalRead(kPinHold) == LOW; }
