// One private chat completion per verified transcript.
// JSON output: memory operations, and in Live a transcript line plus a translation.
// The chat model is chosen from the live catalog: TeeML chatbot, JSON mode,
// most providers, then cheapest prompt. The first successful call records it.
// Never retry on trust mode standard.

import type { Mode } from "./protocol.ts";
import { readTeeTrace, TRUST_MODE, TRUST_MODE_HEADER } from "./tee.ts";
import { workingSetPrompt, type MemoryOp, type WorkingSet } from "./working-set.ts";

export const MODELS_URL = "https://router-api.0g.ai/v1/models";
export const REASON_URL = "https://router-api.0g.ai/v1/chat/completions";

export interface PrivateChatModel {
  id: string;
  disableThinking: boolean;
}

export interface ReasonTrace {
  step: "reason";
  model: string;
  request_id: string;
  provider: string;
  tee_verified: true;
}

export type ReasonFailureReason =
  | "no_key"
  | "no_private_model"
  | "missing_trace"
  | "tee_unverified"
  | "bad_output"
  | "http_503"
  | "http_502"
  | "http_error";

export type ReasonResult =
  | {
      ok: true;
      memory_ops: MemoryOp[];
      transcript: string;
      translation: string;
      trace: ReasonTrace;
    }
  | { ok: false; reason: ReasonFailureReason; status?: number };

/** Remembers the catalog model after the first successful private completion. */
export interface ChatModelMemory {
  model: PrivateChatModel | null;
}

export function createChatModelMemory(): ChatModelMemory {
  return { model: null };
}

export interface ReasonOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Skip the catalog. Production leaves this unset. */
  model?: string;
  disableThinking?: boolean;
  /** Set by the relay so the next utterance reuses the recorded model. */
  record?: ChatModelMemory;
  timestamp: number;
  mode: Mode;
  index: WorkingSet;
}

export function locksReason(result: ReasonResult): boolean {
  return (
    !result.ok &&
    (result.reason === "missing_trace" ||
      result.reason === "tee_unverified" ||
      result.reason === "http_503" ||
      result.reason === "http_502")
  );
}

export function reasonUserContent(
  mode: Mode,
  timestamp: number,
  transcript: string,
  index: WorkingSet,
): string {
  return [`mode: ${mode}`, `timestamp: ${timestamp}`, `transcript: ${transcript}`, workingSetPrompt(index)].join(
    "\n",
  );
}

interface CatalogEntry {
  id: string;
  type: string;
  verifiability: string;
  providerCount: number;
  promptPrice: bigint;
  json: boolean;
  disableThinking: boolean;
}

export function pickPrivateChatModel(body: unknown): PrivateChatModel | null {
  const candidates = catalogEntries(body).filter(
    (entry) =>
      entry.type === "chatbot" &&
      entry.verifiability === "TeeML" &&
      entry.json &&
      entry.providerCount > 0,
  );
  candidates.sort((a, b) => {
    if (b.providerCount !== a.providerCount) return b.providerCount - a.providerCount;
    if (a.promptPrice < b.promptPrice) return -1;
    if (a.promptPrice > b.promptPrice) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  const winner = candidates[0];
  if (!winner) return null;
  return { id: winner.id, disableThinking: winner.disableThinking };
}

export async function reasonUtterance(
  transcript: string,
  options: ReasonOptions,
): Promise<ReasonResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!options.apiKey) return { ok: false, reason: "no_key" };

  const model = await resolveModel(options, fetchImpl);
  if ("ok" in model) return model;

  let response: Response;
  try {
    response = await fetchImpl(REASON_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        [TRUST_MODE_HEADER]: TRUST_MODE,
      },
      body: JSON.stringify(requestBody(transcript, options, model)),
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

  const trace = readTeeTrace(body, response.status);
  if (!trace.ok) return { ok: false, reason: trace.reason, status: trace.status };

  const output = readOutput(body);
  if (!output) return { ok: false, reason: "bad_output", status: response.status };

  remember(options, model);
  return {
    ok: true,
    memory_ops: output.memory_ops,
    transcript: output.transcript,
    translation: output.translation,
    trace: {
      step: "reason",
      model: model.id,
      request_id: trace.request_id,
      provider: trace.provider,
      tee_verified: true,
    },
  };
}

function requestBody(transcript: string, options: ReasonOptions, model: PrivateChatModel): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.id,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: reasonUserContent(options.mode, options.timestamp, transcript, options.index),
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    verify_tee: true,
  };
  if (model.disableThinking) {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  return body;
}

async function resolveModel(
  options: ReasonOptions,
  fetchImpl: typeof fetch,
): Promise<PrivateChatModel | ReasonResult> {
  if (options.model) {
    return { id: options.model, disableThinking: options.disableThinking ?? false };
  }
  if (options.record?.model) return options.record.model;

  let response: Response;
  try {
    response = await fetchImpl(MODELS_URL, { method: "GET" });
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
    return { ok: false, reason: "no_private_model" };
  }
  const picked = pickPrivateChatModel(body);
  if (!picked) return { ok: false, reason: "no_private_model" };
  return picked;
}

function remember(options: ReasonOptions, model: PrivateChatModel): void {
  if (options.model || !options.record || options.record.model) return;
  options.record.model = { id: model.id, disableThinking: model.disableThinking };
}

function catalogEntries(body: unknown): CatalogEntry[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const entries: CatalogEntry[] = [];
  for (const item of data) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as {
      id?: unknown;
      type?: unknown;
      verifiability?: unknown;
      provider_count?: unknown;
      pricing?: unknown;
      supported_parameters?: unknown;
    };
    if (typeof row.id !== "string" || row.id.length === 0) continue;
    const params = Array.isArray(row.supported_parameters)
      ? row.supported_parameters.filter((param): param is string => typeof param === "string")
      : [];
    entries.push({
      id: row.id,
      type: typeof row.type === "string" ? row.type : "",
      verifiability: typeof row.verifiability === "string" ? row.verifiability : "",
      providerCount: typeof row.provider_count === "number" ? row.provider_count : 0,
      promptPrice: promptPrice(row.pricing),
      json: params.includes("response_format"),
      disableThinking: params.includes("chat_template_kwargs"),
    });
  }
  return entries;
}

function promptPrice(pricing: unknown): bigint {
  if (pricing === null || typeof pricing !== "object" || Array.isArray(pricing)) return BigInt(0);
  const prompt = (pricing as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string" || !/^\d+$/.test(prompt)) return BigInt(0);
  return BigInt(prompt);
}

function readOutput(body: unknown): { memory_ops: MemoryOp[]; transcript: string; translation: string } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) return null;
  const message = (first as { message?: unknown }).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  const parsed = parseContent((message as { content?: unknown }).content);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as { memory_ops?: unknown; transcript?: unknown; translation?: unknown };
  const memoryOps = parseOps(record.memory_ops);
  if (!memoryOps) return null;
  if (record.transcript !== undefined && typeof record.transcript !== "string") return null;
  if (record.translation !== undefined && typeof record.translation !== "string") return null;
  return {
    memory_ops: memoryOps,
    transcript: typeof record.transcript === "string" ? record.transcript.trim() : "",
    translation: typeof record.translation === "string" ? record.translation.trim() : "",
  };
}

function parseContent(content: unknown): unknown | null {
  if (content !== null && typeof content === "object") return content;
  if (typeof content !== "string") return null;
  let text = content.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseOps(value: unknown): MemoryOp[] | null {
  if (!Array.isArray(value)) return null;
  const ops: MemoryOp[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as { op?: unknown; text?: unknown; list?: unknown };
    if (record.op === "add_reminder" || record.op === "close_reminder" || record.op === "close_item") {
      if (typeof record.text !== "string" || record.text.trim().length === 0) return null;
      ops.push({ op: record.op, text: record.text.trim() });
      continue;
    }
    if (record.op === "add_item") {
      if (typeof record.text !== "string" || record.text.trim().length === 0) return null;
      if (typeof record.list !== "string" || record.list.trim().length === 0) return null;
      ops.push({ op: "add_item", list: record.list.trim(), text: record.text.trim() });
      continue;
    }
    return null;
  }
  return ops;
}

const SYSTEM_PROMPT = [
  "You fold one spoken utterance into open memory.",
  "Reply with JSON only. Keys: memory_ops, transcript, translation.",
  "memory_ops is an array of {op: add_reminder, text}, {op: close_reminder, text}, {op: add_item, list, text}, or {op: close_item, text}.",
  "Add a reminder for a meeting or commitment that is still open. Add a list item for an amount or obligation that is still open. Use list open unless the utterance names another list.",
  "Close a reminder or an item only when this utterance resolves that same thing. Leave every other open entry out of memory_ops.",
  "transcript is the utterance, cleaned. translation is the English line. Use an empty string for translation when the utterance is already English.",
].join(" ");
