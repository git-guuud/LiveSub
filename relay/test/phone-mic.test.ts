import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { clipDurationSec } from "../src/episode.ts";
import { measureClip } from "../src/hearing.ts";
import {
  createSpeechGate,
  encodeWav,
  floatToInt16,
  phoneIsBadge,
  resampleLinear,
} from "../public/phone-mic.js";

function frame(level: number, count: number): Int16Array {
  const samples = new Int16Array(count);
  samples.fill(level);
  return samples;
}

test("the badge switch stays off unless this visit asks for the phone", () => {
  assert.equal(phoneIsBadge("", null), false);
  assert.equal(phoneIsBadge("", "1"), true);
  assert.equal(phoneIsBadge("?badge=0", "1"), false);
  assert.equal(phoneIsBadge("?badge=board", "1"), false);
  assert.equal(phoneIsBadge("badge=phone", "0"), true);
  assert.equal(phoneIsBadge("?badge=1", null), true);
});

test("the phone page hides the badge glass until the switch is on", () => {
  const html = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/phone.html"),
    "utf8",
  );
  const { document } = parseHTML(html);
  const badge = document.querySelector("#badge");
  const glass = document.querySelector("#glass");
  const mode = document.querySelector("#mode");
  assert.ok(badge);
  assert.ok(glass);
  assert.ok(mode);
  assert.equal(badge.hasAttribute("hidden"), true);
  assert.equal(badge.contains(glass), true);
  assert.equal(glass.contains(mode), false);
  assert.equal(html.includes("Inject clip"), false);
  assert.match(html, /This phone is the badge/);
  assert.match(html, /STAND_IN/);
});

test("silence stays put and a burst becomes one clip", () => {
  const gate = createSpeechGate({ warmSamples: 0, minSamples: 400, tailSamples: 200, maxSamples: 5000 });
  assert.equal(gate.push(frame(80, 200)), null);
  assert.equal(gate.push(frame(80, 200)), null);
  assert.equal(gate.push(frame(4000, 300)), null);
  const heard = gate.push(frame(80, 200));
  assert.ok(heard);
  assert.equal(heard.length >= 400, true);
});

test("a short blip is dropped", () => {
  const gate = createSpeechGate({ warmSamples: 0, minSamples: 800, tailSamples: 100 });
  assert.equal(gate.push(frame(4000, 200)), null);
  assert.equal(gate.push(frame(40, 100)), null);
});

test("a phone clip is 16 kHz wav the relay can measure", () => {
  const samples = new Int16Array(16000);
  samples.fill(1200);
  const wav = encodeWav(samples);
  assert.equal(clipDurationSec(wav), 1);
  const heard = measureClip(wav);
  assert.equal(heard.measured, true);
  assert.equal(heard.level > 500, true);
  assert.equal(floatToInt16(new Float32Array([1, -1, 0]))[0], 32767);
  assert.equal(floatToInt16(new Float32Array([1, -1, 0]))[1], -32768);
  const down = resampleLinear(new Float32Array(48).fill(0.25), 48000, 16000);
  assert.equal(down.length, 16);
  assert.equal(down[0] > 0.2 && down[0] < 0.3, true);
});
