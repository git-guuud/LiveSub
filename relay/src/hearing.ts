// Hearing is measured from the clip and, when the router sends them, the decoder stats.
// The transcript stays the words. Hearing says how much those words can change memory.
//
// voice unclear: no memory operations and no summary. A mumbled window is not a commitment.
// noise high: a new reminder needs a day and at most two other words. A new debt needs an
// amount. A todo waits for a quieter clip. Stray words do not become items.
// A close is kept only when this utterance resolves that same open row.
// voice clear and noise low: a near pronunciation of an open row is that row, not a second copy.

import type { MemoryOp, SummaryDraft, WorkingSet } from "./working-set.ts";

const FRAME = 800;
const CLIPPED_AT = 30000;

// Cutoffs sit between the bands in relay/test/hearing-corpus.ts.
// Levels 0–2 still match the gold task: ratio at least 4, logprob above -0.8.
// Level 3 is where stray nouns become tasks: ratio 3.4, voice still clear.
// Levels 4–5 no longer recover the task: ratio 2.2 and logprob -1.05.
const UNCLEAR_RATIO = 2.5;
const UNCLEAR_LOGPROB = -0.8;
const UNCLEAR_NO_SPEECH = 0.5;
const NOISY_RATIO = 4;
const NOISY_CLIPPED = 0.03;
const NOISY_COMPRESSION = 2.4;

const STOP = new Set([
  "a", "an", "the", "i", "ill", "im", "ive", "id", "me", "my", "him", "her", "his", "we", "our",
  "you", "your", "it", "its", "to", "for", "of", "on", "in", "at", "and", "or", "but", "so",
  "still", "just", "that", "this", "with", "from", "was", "were", "is", "are", "be", "been",
  "uh", "um", "uhh", "like", "anyway", "yeah", "oh", "hey", "up", "do", "did", "does",
]);

const STEM: Record<string, string> = {
  sent: "send",
  sending: "send",
  paid: "pay",
  payed: "pay",
  paying: "pay",
  picked: "pick",
  picking: "pick",
  finished: "finish",
  finishing: "finish",
  done: "finish",
  cancelled: "cancel",
  canceled: "cancel",
  returned: "return",
  returning: "return",
  settled: "settle",
  settling: "settle",
  gave: "give",
  given: "give",
  giving: "give",
  met: "meet",
  meeting: "meet",
  owes: "owe",
  owed: "owe",
};

const NUMBER: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7",
  eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14",
  fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20",
  thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90",
};

const WEEKDAYS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "today", "tomorrow", "tonight", "morning", "afternoon", "evening",
]);

const CURRENCY = new Set(["usdc", "usd", "usdt", "eth", "btc", "dai", "dollar", "dollars", "euro", "euros"]);

const RESOLVERS = new Set(["send", "pay", "pick", "finish", "cancel", "return", "settle", "give"]);

/** Verbs the model uses to tidy a sentence. They are not what makes a fact true. */
const GENERIC = new Set([
  "meet", "send", "owe", "pick", "pay", "give", "finish", "return", "settle", "cancel", "buy", "get", "make",
]);

export interface ClipAcoustics {
  /** False when the clip is shorter than one 50 ms frame. The room was not measured. */
  measured: boolean;
  level: number;
  room: number;
  speech: number;
  speech_ratio: number;
  clipped: number;
}

export interface DecoderHearing {
  avg_logprob: number | null;
  no_speech_prob: number | null;
  compression_ratio: number | null;
}

export interface Hearing {
  /** False when the clip was too short to separate the room from the voice. */
  measured: boolean;
  /** The voice stood out and the decoder was not lost. */
  voice: "clear" | "unclear";
  /** The room was loud under the voice, or the decoder looped. Extra words are likely. */
  noise: "low" | "high";
  /** Mean absolute sample level of the whole clip. */
  level: number;
  /** Mean absolute level of the quieter frames. */
  room: number;
  /** Loud frames divided by the room. */
  speech_ratio: number;
  /** Share of samples at full scale. Clipping smears consonants into other words. */
  clipped: number;
  /** Mean decoder logprob. Null when the router returned text only. */
  avg_logprob: number | null;
  /** Highest chance the decoder thought a segment was not speech. */
  no_speech_prob: number | null;
  /** Highest decoder repeat score. A high value is the model looping on noise. */
  compression_ratio: number | null;
}

export function emptyDecoder(): DecoderHearing {
  return { avg_logprob: null, no_speech_prob: null, compression_ratio: null };
}

/** 16 kHz, 16-bit, mono. A WAV header is skipped. Quiet frames are the room. */
export function measureClip(bytes: Uint8Array): ClipAcoustics {
  const pcm = pcmSamples(bytes);
  if (pcm.length < FRAME) return { measured: false, level: 0, room: 0, speech: 0, speech_ratio: 0, clipped: 0 };
  let sum = 0;
  let clipped = 0;
  const frames: number[] = [];
  let frameSum = 0;
  let frameCount = 0;
  for (const sample of pcm) {
    const abs = Math.abs(sample);
    sum += abs;
    if (abs >= CLIPPED_AT) clipped += 1;
    frameSum += abs;
    frameCount += 1;
    if (frameCount === FRAME) {
      frames.push(frameSum / FRAME);
      frameSum = 0;
      frameCount = 0;
    }
  }
  if (frameCount > 0) frames.push(frameSum / frameCount);
  const sorted = [...frames].sort((a, b) => a - b);
  const room = portion(sorted, 0.4, true);
  const speech = portion(sorted, 0.2, false);
  return {
    measured: true,
    level: Math.round(sum / pcm.length),
    room: Math.round(room),
    speech: Math.round(speech),
    speech_ratio: round(speech / Math.max(room, 1), 100),
    clipped: round(clipped / pcm.length, 1000),
  };
}

export function readDecoderHearing(body: unknown): DecoderHearing {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return emptyDecoder();
  const record = body as {
    segments?: unknown;
    avg_logprob?: unknown;
    no_speech_prob?: unknown;
    compression_ratio?: unknown;
  };
  const logprobs: number[] = [];
  const noSpeech: number[] = [];
  const compression: number[] = [];
  if (Array.isArray(record.segments)) {
    for (const segment of record.segments) {
      if (segment === null || typeof segment !== "object" || Array.isArray(segment)) continue;
      const row = segment as { avg_logprob?: unknown; no_speech_prob?: unknown; compression_ratio?: unknown };
      if (typeof row.avg_logprob === "number" && Number.isFinite(row.avg_logprob)) logprobs.push(row.avg_logprob);
      if (typeof row.no_speech_prob === "number" && Number.isFinite(row.no_speech_prob)) noSpeech.push(row.no_speech_prob);
      if (typeof row.compression_ratio === "number" && Number.isFinite(row.compression_ratio)) {
        compression.push(row.compression_ratio);
      }
    }
  }
  return {
    avg_logprob: meanOr(logprobs, record.avg_logprob),
    no_speech_prob: maxOr(noSpeech, record.no_speech_prob),
    compression_ratio: maxOr(compression, record.compression_ratio),
  };
}

export function judgeHearing(clip: ClipAcoustics, decoder: DecoderHearing): Hearing {
  const decoderUnclear =
    (decoder.avg_logprob !== null && decoder.avg_logprob <= UNCLEAR_LOGPROB) ||
    (decoder.no_speech_prob !== null && decoder.no_speech_prob >= UNCLEAR_NO_SPEECH);
  const decoderNoisy = decoder.compression_ratio !== null && decoder.compression_ratio >= NOISY_COMPRESSION;
  // A flat loud clip has no quiet room to compare, so the ratio collapses. That is still a voice.
  const acousticUnclear = clip.measured && clip.speech_ratio < UNCLEAR_RATIO && clip.level < 900;
  const unclear = decoderUnclear || acousticUnclear;
  const noisy = decoderNoisy || (clip.measured && (clip.speech_ratio < NOISY_RATIO || clip.clipped >= NOISY_CLIPPED));
  return {
    measured: clip.measured,
    voice: unclear ? "unclear" : "clear",
    noise: noisy ? "high" : "low",
    level: clip.level,
    room: clip.room,
    speech_ratio: clip.speech_ratio,
    clipped: clip.clipped,
    avg_logprob: decoder.avg_logprob,
    no_speech_prob: decoder.no_speech_prob,
    compression_ratio: decoder.compression_ratio,
  };
}

export function formatHearing(hearing: Hearing): string {
  return [
    "hearing:",
    `voice: ${hearing.voice}`,
    `noise: ${hearing.noise}`,
    `speech_ratio: ${hearing.measured ? hearing.speech_ratio : "unknown"}`,
    `room: ${hearing.measured ? hearing.room : "unknown"}`,
    `level: ${hearing.measured ? hearing.level : "unknown"}`,
    `clipped: ${hearing.clipped}`,
    `avg_logprob: ${hearing.avg_logprob ?? "unknown"}`,
    `no_speech_prob: ${hearing.no_speech_prob ?? "unknown"}`,
    `compression_ratio: ${hearing.compression_ratio ?? "unknown"}`,
  ].join("\n");
}

const EMPTY_SUMMARY: SummaryDraft = { text: "", points: [] };

/**
 * Drop operations the hearing cannot support. Does not invent a new commitment.
 * A close is rewritten onto the open row it actually matches.
 */
export function guardUtterance(input: {
  memoryOps: MemoryOp[];
  summary?: SummaryDraft | null;
  transcript: string;
  hearing: Hearing;
  index: WorkingSet;
}): { memory_ops: MemoryOp[]; summary: SummaryDraft } {
  if (input.hearing.voice === "unclear") return { memory_ops: [], summary: EMPTY_SUMMARY };
  const memoryOps: MemoryOp[] = [];
  for (const op of input.memoryOps) {
    const kept = settleOp(op, input.transcript, input.hearing, input.index);
    if (kept) memoryOps.push(kept);
  }
  if (input.hearing.noise === "high") return { memory_ops: memoryOps, summary: EMPTY_SUMMARY };
  const summary = input.summary;
  if (!summary || !summary.text.trim()) return { memory_ops: memoryOps, summary: EMPTY_SUMMARY };
  return {
    memory_ops: memoryOps,
    summary: { text: summary.text, points: summary.points.filter((point) => point.trim().length > 0) },
  };
}

function settleOp(op: MemoryOp, transcript: string, hearing: Hearing, index: WorkingSet): MemoryOp | null {
  if (op.op === "close_reminder" || op.op === "close_item") return settleClose(op, transcript, index);
  if (!supportsAdd(op.text, transcript)) return null;
  if (duplicates(op, index)) return null;
  if (hearing.noise === "low") return copyOp(op);
  if (op.op === "add_reminder") return anchoredReminder(op);
  if (op.op === "add_item" && !isTodo(op.list)) return anchoredDebt(op);
  return null;
}

function settleClose(
  op: Extract<MemoryOp, { op: "close_reminder" | "close_item" }>,
  transcript: string,
  index: WorkingSet,
): MemoryOp | null {
  if (!hasResolver(transcript)) return null;
  const pool = op.op === "close_reminder" ? index.reminders : index.items;
  const covered = pool.filter((row) => covers(row.text, transcript));
  const named = covered.filter((row) => samePhrase(row.text, op.text) || covers(op.text, row.text));
  if (named.length !== 1) return null;
  return { op: op.op, text: named[0].text };
}

function anchoredReminder(op: Extract<MemoryOp, { op: "add_reminder" }>): MemoryOp | null {
  const words = contentWords(op.text);
  const anchors = words.filter((word) => WEEKDAYS.has(word));
  const rest = words.length - anchors.length;
  if (anchors.length < 1 || rest < 1 || rest > 2) return null;
  return copyOp(op);
}

function anchoredDebt(op: Extract<MemoryOp, { op: "add_item" }>): MemoryOp | null {
  const words = contentWords(op.text);
  const anchors = words.filter((word) => CURRENCY.has(word) || /^\d+$/.test(word));
  const rest = words.length - anchors.length;
  if (anchors.length < 1 || rest > 2) return null;
  return copyOp(op);
}

function duplicates(op: Extract<MemoryOp, { op: "add_reminder" | "add_item" }>, index: WorkingSet): boolean {
  if (op.op === "add_reminder") return index.reminders.some((row) => covers(op.text, row.text));
  const list = op.list.trim().toLowerCase();
  return index.items.some((row) => row.list.trim().toLowerCase() === list && covers(op.text, row.text));
}

function covers(need: string, heard: string): boolean {
  return align(contentWords(need), contentWords(heard));
}

function supportsAdd(text: string, transcript: string): boolean {
  const marks = contentWords(text).filter((word) => !GENERIC.has(word));
  if (marks.length === 0) return covers(text, transcript);
  return align(marks, contentWords(transcript));
}

function samePhrase(a: string, b: string): boolean {
  const left = contentWords(a);
  const right = contentWords(b);
  return align(left, right) && align(right, left);
}

function hasResolver(transcript: string): boolean {
  return contentWords(transcript).some((word) => RESOLVERS.has(word));
}

function copyOp(op: MemoryOp): MemoryOp {
  if (op.op === "add_item") return { op: "add_item", list: op.list, text: op.text };
  return { op: op.op, text: op.text };
}

function isTodo(list: string): boolean {
  const name = list.trim().toLowerCase();
  return name === "todo" || name === "todos" || name === "to-do" || name === "to-dos" || name === "task" || name === "tasks";
}

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/'/g, "")
    .split(/[^a-z0-9]+/)
    .map((word) => NUMBER[word] ?? STEM[word] ?? word)
    .filter((word) => word.length > 0 && !STOP.has(word));
}

/** True when every needed word is a heard word, a join of two heard words, or a split of one. */
function align(need: string[], heard: string[]): boolean {
  if (need.length === 0 || need.length > 16 || heard.length > 48) return false;
  const used = new Array<boolean>(heard.length).fill(false);
  function search(index: number): boolean {
    if (index >= need.length) return true;
    const word = need[index];
    const joined = index + 1 < need.length ? word + need[index + 1] : "";
    for (let h = 0; h < heard.length; h++) {
      if (used[h]) continue;
      if (soundsLike(word, heard[h])) {
        used[h] = true;
        if (search(index + 1)) return true;
        used[h] = false;
      }
      if (joined && soundsLike(joined, heard[h])) {
        used[h] = true;
        if (search(index + 2)) return true;
        used[h] = false;
      }
      if (h + 1 < heard.length && !used[h + 1] && soundsLike(word, heard[h] + heard[h + 1])) {
        used[h] = true;
        used[h + 1] = true;
        if (search(index + 1)) return true;
        used[h] = false;
        used[h + 1] = false;
      }
    }
    return false;
  }
  return search(0);
}

function soundsLike(a: string, b: string): boolean {
  if (a === b) return true;
  const left = skeleton(a);
  const right = skeleton(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.max(left.length, right.length) < 4) return false;
  return levenshtein(left, right) <= 1;
}

function skeleton(word: string): string {
  if (/^\d+$/.test(word)) return word;
  return word
    .toLowerCase()
    .replace(/ph/g, "f")
    .replace(/g(?=[eiy])/g, "j")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/th/g, "t")
    .replace(/[aeiouy]/g, "")
    .replace(/(.)\1+/g, "$1");
}

function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const next = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = next[j];
  }
  return prev[b.length];
}

function pcmSamples(bytes: Uint8Array): Int16Array {
  let offset = 0;
  if (
    bytes.byteLength >= 44 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    offset = 44;
  }
  const count = Math.floor((bytes.byteLength - offset) / 2);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const value = bytes[offset + i * 2] | (bytes[offset + i * 2 + 1] << 8);
    samples[i] = value & 0x8000 ? value - 0x10000 : value;
  }
  return samples;
}

function portion(sorted: number[], fraction: number, low: boolean): number {
  const count = Math.max(1, Math.round(sorted.length * fraction));
  const slice = low ? sorted.slice(0, count) : sorted.slice(-count);
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

function meanOr(values: number[], fallback: unknown): number | null {
  if (values.length > 0) return round(values.reduce((sum, value) => sum + value, 0) / values.length, 100);
  return typeof fallback === "number" && Number.isFinite(fallback) ? round(fallback, 100) : null;
}

function maxOr(values: number[], fallback: unknown): number | null {
  if (values.length > 0) return round(Math.max(...values), 100);
  return typeof fallback === "number" && Number.isFinite(fallback) ? round(fallback, 100) : null;
}

function round(value: number, scale: number): number {
  return Math.round(value * scale) / scale;
}
