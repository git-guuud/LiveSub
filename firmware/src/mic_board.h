#pragma once

#include "clip.h"

// I2S and the mic-power pin. The PCM lives in one static buffer. No PSRAM.

void micBoardBegin();
void micBoardSetPower(bool on);
Clip& micBoardClip();
uint8_t* micBoardWav();
void micBoardRead();
