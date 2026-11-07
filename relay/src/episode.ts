// Utterance plaintext. Encrypted before it leaves the relay. No audio field.
// A missing trace, or tee_verified other than true, is not an utterance.

import type { Mode } from "./protocol.ts";
import type { ReasonTrace } from "./reason.ts";
import { TRANSCRIBE_MODEL, type TranscribeTrace } from "./transcribe.ts";
import type { MemoryOp, SummaryDraft } from "./working-set.ts";

const SAMPLE_RATE = 16000;

export interface Utterance {
  version: "2.0";
  timestamp: number;
  mode: Mode;
  audio_duration_sec: number;
  transcript: string;
  translation: string;
  memory_ops: MemoryOp[];
  summary?: SummaryDraft;
  traces: [TranscribeTrace, ReasonTrace];
}

export interface UtteranceInput {
  timestamp: number;
  mode: Mode;
  audioDurationSec: number;
  transcript: string;
  translation: string;
  memoryOps: MemoryOp[];
  summary?: SummaryDraft | null;
  transcribe: TranscribeTrace | null;
  reason: ReasonTrace | null;
}

/** 16 kHz, 16-bit, mono PCM. A WAV header is not part of the duration. */
export function clipDurationSec(bytes: Uint8Array): number {
  let pcm = bytes.byteLength;
  if (isWav(bytes)) pcm = Math.max(0, bytes.byteLength - 44);
  const samples = Math.floor(pcm / 2);
  return roundSeconds(samples / SAMPLE_RATE);
}

/** Null when either trace is missing or not tee_verified. That call is not stored. */
export function buildUtterance(input: UtteranceInput): Utterance | null {
  if (!verified(input.transcribe) || !verified(input.reason)) return null;
  if (input.mode !== "companion" && input.mode !== "live") return null;
  const memoryOps = copyOps(input.memoryOps);
  if (!memoryOps) return null;
  const summary = copySummary(input.summary);
  const transcribe = verifiedTranscribe(input.transcribe);
  const reason = verifiedReason(input.reason);
  if (!transcribe || !reason) return null;
  return {
    version: "2.0",
    timestamp: input.timestamp,
    mode: input.mode,
    audio_duration_sec: roundSeconds(input.audioDurationSec),
    transcript: input.transcript,
    translation: input.translation,
    memory_ops: memoryOps,
    ...(summary ? { summary } : {}),
    traces: [transcribe, reason],
  };
}

export function utteranceBytes(utterance: Utterance): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(utterance));
}

export function parseUtterance(bytes: Uint8Array): Utterance {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const utterance = normalizeUtterance(value);
  if (!utterance) throw new Error("bad_utterance");
  return utterance;
}

function roundSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

function isWav(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 44 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

function verified(trace: TranscribeTrace | ReasonTrace | null): trace is TranscribeTrace | ReasonTrace {
  return trace !== null && trace.tee_verified === true && trace.request_id.length > 0 && trace.provider.length > 0;
}

function verifiedTranscribe(trace: TranscribeTrace): TranscribeTrace | null {
  if (trace.model !== TRANSCRIBE_MODEL || trace.step !== "transcribe") return null;
  return {
    step: "transcribe",
    model: TRANSCRIBE_MODEL,
    request_id: trace.request_id,
    provider: trace.provider,
    tee_verified: true,
  };
}

function verifiedReason(trace: ReasonTrace): ReasonTrace | null {
  if (trace.step !== "reason" || trace.model.length === 0) return null;
  return {
    step: "reason",
    model: trace.model,
    request_id: trace.request_id,
    provider: trace.provider,
    tee_verified: true,
  };
}

function copyOps(value: unknown): MemoryOp[] | null {
  if (!Array.isArray(value)) return null;
  const ops: MemoryOp[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as { op?: unknown; text?: unknown; list?: unknown };
    if (record.op === "add_reminder" || record.op === "close_reminder" || record.op === "close_item") {
      if (typeof record.text !== "string" || record.text.trim().length === 0) return null;
      ops.push({ op: record.op, text: record.text });
      continue;
    }
    if (record.op === "add_item") {
      if (typeof record.text !== "string" || record.text.trim().length === 0) return null;
      if (typeof record.list !== "string" || record.list.trim().length === 0) return null;
      ops.push({ op: "add_item", list: record.list, text: record.text });
      continue;
    }
    return null;
  }
  return ops;
}

const BANNED = ["audio", "direction", "pin", "pinned", "subtitle", "cue"] as const;

function normalizeUtterance(value: unknown): Utterance | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of BANNED) {
    if (key in value) return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== "2.0") return null;
  if (record.mode !== "companion" && record.mode !== "live") return null;
  if (typeof record.timestamp !== "number" || !Number.isFinite(record.timestamp)) return null;
  if (typeof record.audio_duration_sec !== "number" || !Number.isFinite(record.audio_duration_sec)) return null;
  if (typeof record.transcript !== "string" || typeof record.translation !== "string") return null;
  const memoryOps = copyOps(record.memory_ops);
  if (!memoryOps) return null;
  const summary = readStoredSummary(record.summary);
  if (summary === "bad") return null;
  if (!Array.isArray(record.traces) || record.traces.length !== 2) return null;
  const transcribe = readStoredTrace(record.traces[0], "transcribe");
  const reason = readStoredTrace(record.traces[1], "reason");
  if (!transcribe || !reason) return null;
  return {
    version: "2.0",
    timestamp: record.timestamp,
    mode: record.mode,
    audio_duration_sec: record.audio_duration_sec,
    transcript: record.transcript,
    translation: record.translation,
    memory_ops: memoryOps,
    ...(summary ? { summary } : {}),
    traces: [transcribe, reason],
  };
}

function readStoredSummary(value: unknown): SummaryDraft | null | "bad" {
  if (value === undefined || value === null) return null;
  const summary = copySummary(value);
  if (summary) return summary;
  if (typeof value !== "object" || Array.isArray(value)) return "bad";
  const record = value as { text?: unknown; points?: unknown };
  if (typeof record.text !== "string" || !Array.isArray(record.points)) return "bad";
  if (record.points.some((point) => typeof point !== "string")) return "bad";
  if (record.text.trim().length > 500) return "bad";
  if (record.points.some((point) => point.trim().length > 280)) return "bad";
  return null;
}

function copySummary(value: unknown): SummaryDraft | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { text?: unknown; points?: unknown };
  if (typeof record.text !== "string" || !Array.isArray(record.points)) return null;
  const text = record.text.trim();
  const points: string[] = [];
  for (const point of record.points) {
    if (typeof point !== "string") return null;
    const label = point.trim();
    if (!label || label.length > 280) return null;
    points.push(label);
    if (points.length === 8) break;
  }
  if (text.length > 500) return null;
  if (!text && points.length === 0) return null;
  return { text, points };
}

function readStoredTrace(value: unknown, step: "transcribe"): TranscribeTrace | null;
function readStoredTrace(value: unknown, step: "reason"): ReasonTrace | null;
function readStoredTrace(value: unknown, step: "transcribe" | "reason"): TranscribeTrace | ReasonTrace | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { step?: unknown; model?: unknown; request_id?: unknown; provider?: unknown; tee_verified?: unknown };
  if (record.step !== step || record.tee_verified !== true) return null;
  if (typeof record.model !== "string" || record.model.length === 0) return null;
  if (typeof record.request_id !== "string" || record.request_id.length === 0) return null;
  if (typeof record.provider !== "string" || record.provider.length === 0) return null;
  if (step === "transcribe") {
    if (record.model !== TRANSCRIBE_MODEL) return null;
    return {
      step: "transcribe",
      model: TRANSCRIBE_MODEL,
      request_id: record.request_id,
      provider: record.provider,
      tee_verified: true,
    };
  }
  return {
    step: "reason",
    model: record.model,
    request_id: record.request_id,
    provider: record.provider,
    tee_verified: true,
  };
}
