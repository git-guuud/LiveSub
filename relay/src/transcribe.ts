// One clip, one private transcription. Audio is wiped when the request ends.
// A missing trace, or tee_verified other than true, is not a transcript.
// Never retry on trust mode standard. The live call stays off until OG_API_KEY is set.

import { judgeHearing, measureClip, readDecoderHearing, type Hearing } from "./hearing.ts";
import { preferReachableAddress } from "./net.ts";
import { readTeeTrace, TRUST_MODE, TRUST_MODE_HEADER } from "./tee.ts";

export const TRANSCRIBE_URL =
  "https://router-api.0g.ai/v1/audio/transcriptions?verify_tee=true";
export const TRANSCRIBE_MODEL = "whisper-large-v3";
export { TRUST_MODE, TRUST_MODE_HEADER };

export interface TranscribeTrace {
  step: "transcribe";
  model: typeof TRANSCRIBE_MODEL;
  request_id: string;
  provider: string;
  tee_verified: true;
}

export type TranscribeFailureReason =
  | "no_key"
  | "missing_trace"
  | "tee_unverified"
  | "sealed"
  | "tee_unclaimed"
  | "empty_transcript"
  | "http_503"
  | "http_502"
  | "http_error";

export type TranscribeResult =
  | { ok: true; text: string; hearing?: Hearing; trace: TranscribeTrace }
  | { ok: false; reason: TranscribeFailureReason; status?: number };

export interface TranscribeOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export function locksEnclave(result: TranscribeResult): boolean {
  return (
    !result.ok &&
    (result.reason === "missing_trace" ||
      result.reason === "tee_unverified" ||
      result.reason === "http_503" ||
      result.reason === "http_502")
  );
}

export async function transcribeClip(
  audio: Uint8Array,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (fetchImpl === fetch) preferReachableAddress();
  const clip = measureClip(audio);
  try {
    if (!options.apiKey) return { ok: false, reason: "no_key" };
    let response: Response;
    try {
      const form = new FormData();
      form.append("file", new Blob([audio]), "clip.bin");
      form.append("model", TRANSCRIBE_MODEL);
      form.append("response_format", "json");
      response = await fetchImpl(TRANSCRIBE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          [TRUST_MODE_HEADER]: TRUST_MODE,
        },
        body: form,
      });
    } catch {
      return { ok: false, reason: "http_error" };
    }
    if (response.status === 503) return { ok: false, reason: "http_503", status: 503 };
    if (response.status === 502) return { ok: false, reason: "http_502", status: 502 };
    if (!response.ok) return { ok: false, reason: "http_error", status: response.status };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: "missing_trace", status: response.status };
    }
    return readVerified(body, response, clip);
  } finally {
    audio.fill(0);
  }
}

function heardText(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("text" in body)) return null;
  const text = (body as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

function readVerified(body: unknown, response: Response, clip: ReturnType<typeof measureClip>): TranscribeResult {
  const trace = readTeeTrace(body, response.status);
  if (!trace.ok) {
    const reason = trace.reason === "tee_unclaimed" && response.headers.get("x-0g-e2ee") === "sealed" ? "sealed" : trace.reason;
    const settled = reason === "tee_unclaimed" ? "tee_unverified" : reason;
    const heard = heardText(body);
    if (heard !== null) console.log("transcript", heard);
    return { ok: false, reason: settled, status: trace.status };
  }
  const record = body as { text?: unknown };
  if (typeof record.text !== "string" || record.text.trim().length === 0) {
    return { ok: false, reason: "empty_transcript", status: response.status };
  }
  return {
    ok: true,
    text: record.text.trim(),
    hearing: judgeHearing(clip, readDecoderHearing(body)),
    trace: {
      step: "transcribe",
      model: TRANSCRIBE_MODEL,
      request_id: trace.request_id,
      provider: trace.provider,
      tee_verified: true,
    },
  };
}
