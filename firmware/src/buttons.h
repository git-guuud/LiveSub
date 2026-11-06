#pragma once

// GPIO0 is INPUT_PULLUP. GPIO35 is INPUT. Neither is an output.
// GPIO35 is not a capture button.

void buttonsBegin();
bool bootDown();
bool holdDown();
