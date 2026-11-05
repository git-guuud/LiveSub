// Shared private-router trace check. tee_verified is response metadata, not a header.
// Never retry a failed check on trust mode standard.

export const TRUST_MODE_HEADER = "X-0G-Provider-Trust-Mode";
export const TRUST_MODE = "private";

export type TeeTraceFailure = {
  ok: false;
  reason: "missing_trace" | "tee_unverified";
  status: number;
};

export type TeeTraceSuccess = {
  ok: true;
  request_id: string;
  provider: string;
};

export function readTeeTrace(body: unknown, status: number): TeeTraceSuccess | TeeTraceFailure {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "missing_trace", status };
  }
  const trace = (body as { x_0g_trace?: unknown }).x_0g_trace;
  if (trace === null || typeof trace !== "object" || Array.isArray(trace)) {
    return { ok: false, reason: "missing_trace", status };
  }
  const fields = trace as { tee_verified?: unknown; request_id?: unknown; provider?: unknown };
  if (fields.tee_verified !== true) return { ok: false, reason: "tee_unverified", status };
  if (typeof fields.request_id !== "string" || fields.request_id.length === 0) {
    return { ok: false, reason: "missing_trace", status };
  }
  if (typeof fields.provider !== "string" || fields.provider.length === 0) {
    return { ok: false, reason: "missing_trace", status };
  }
  return { ok: true, request_id: fields.request_id, provider: fields.provider };
}
