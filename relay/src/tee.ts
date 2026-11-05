// Shared private-router trace check. tee_verified is response metadata, not a header.
// Never retry a failed check on trust mode standard.

export const TRUST_MODE_HEADER = "X-0G-Provider-Trust-Mode";
export const TRUST_MODE = "private";

export type TeeTraceFailure = {
  ok: false;
  /** `tee_unclaimed` is a trace with no boolean. A sealed response uses that for "no claim". */
  reason: "missing_trace" | "tee_unverified" | "tee_unclaimed";
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
  const requestId = typeof fields.request_id === "string" ? fields.request_id : "";
  const provider = typeof fields.provider === "string" ? fields.provider : "";
  if (requestId.length === 0 || provider.length === 0) {
    return { ok: false, reason: "missing_trace", status };
  }
  if (fields.tee_verified === true) return { ok: true, request_id: requestId, provider };
  if (fields.tee_verified === false) return { ok: false, reason: "tee_unverified", status };
  return { ok: false, reason: "tee_unclaimed", status };
}
