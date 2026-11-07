// Phone microphone stand-in. One speech burst becomes one 16 kHz WAV clip.
// Silence stays on the phone. The glass never shows a level.

export const PHONE_RATE = 16000;

export function phoneIsBadge(search, stored) {
  const flag = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("badge");
  if (flag === "1" || flag === "phone") return true;
  if (flag === "0" || flag === "board") return false;
  return stored === "1";
}

export function floatToInt16(input) {
  const samples = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const value = Math.max(-1, Math.min(1, input[i]));
    samples[i] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff);
  }
  return samples;
}

export function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate || input.length === 0) return input;
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const scale = fromRate / toRate;
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * scale;
    const index = Math.floor(pos);
    const frac = pos - index;
    const left = input[Math.min(index, input.length - 1)] ?? 0;
    const right = input[Math.min(index + 1, input.length - 1)] ?? left;
    out[i] = left + (right - left) * frac;
  }
  return out;
}

export function encodeWav(samples, rate = PHONE_RATE) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + samples.length * 2, true);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}

function meanAbs(frame) {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) sum += Math.abs(sample);
  return sum / frame.length;
}

/**
 * Opens on a jump above the room and closes after a quiet tail.
 * A blip shorter than minSamples is dropped. warmSamples calibrates the room first.
 */
export function createSpeechGate(options = {}) {
  const rate = options.rate ?? PHONE_RATE;
  const minSamples = options.minSamples ?? Math.round(rate * 0.45);
  const maxSamples = options.maxSamples ?? rate * 6;
  const tailSamples = options.tailSamples ?? Math.round(rate * 0.4);
  const startFloor = options.startFloor ?? 700;
  const startRatio = options.startRatio ?? 2.8;
  let noise = options.noise ?? 180;
  let warm = options.warmSamples ?? Math.round(rate * 0.25);
  let speaking = false;
  let quiet = 0;
  let buf = [];

  function finish() {
    speaking = false;
    const samples = Int16Array.from(buf);
    buf = [];
    quiet = 0;
    if (samples.length < minSamples) return null;
    return samples;
  }

  return {
    push(frame) {
      const level = meanAbs(frame);
      if (!speaking) {
        if (warm > 0) {
          warm -= frame.length;
          noise = noise * 0.75 + level * 0.25;
          return null;
        }
        if (level <= Math.max(noise * 1.4, startFloor * 0.5)) noise = noise * 0.9 + level * 0.1;
        const open = level >= startFloor && level >= noise * startRatio;
        if (!open) return null;
        speaking = true;
        quiet = 0;
        buf = Array.from(frame);
        if (buf.length >= maxSamples) return finish();
        return null;
      }
      for (let i = 0; i < frame.length; i += 1) buf.push(frame[i]);
      if (level < Math.max(280, noise * 1.5)) quiet += frame.length;
      else quiet = 0;
      if (buf.length >= maxSamples || quiet >= tailSamples) return finish();
      return null;
    },
  };
}
