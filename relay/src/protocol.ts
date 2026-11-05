// Badge wire protocol. The relay owns mode, phone link, relay link, and the lock.
// The glass renders only the face the relay sends. Text frames are JSON.
// One binary frame is one audio clip. The bench control that sends it is not on the glass.

export const LOCK_TEXT = "MIC LOCKED: ENCLAVE OFFLINE";

export const MODES = ["companion", "live"] as const;
export type Mode = (typeof MODES)[number];

export const FACES = ["companion", "live", "not_linked", "locked"] as const;
export type Face = (typeof FACES)[number];

export const CLIENT_EVENTS = ["press"] as const;
export type ClientEventType = (typeof CLIENT_EVENTS)[number];

export interface ClientEvent {
  type: ClientEventType;
}

export interface ScreenState {
  type: "screen";
  face: Face;
  mic_power: boolean;
}

export interface Reminder {
  text: string;
  mentioned_at: number;
  /** Merkle root of the utterance that opened it. Absent until that write is prepared. */
  episode_root?: string;
}

export interface ListItem {
  list: string;
  text: string;
  updated_at: number;
  /** Merkle root of the utterance that opened it. Absent until that write is prepared. */
  episode_root?: string;
}

/** Latest utterance summary. Empty speech does not replace one that is already open. */
export interface MemorySummary {
  text: string;
  points: string[];
  mentioned_at: number;
  /** Merkle root of the utterance that wrote it. Absent until that write is prepared. */
  episode_root?: string;
}

export interface LiveLine {
  transcript: string;
  translation: string;
}

export interface TraceRow {
  step: "transcribe" | "reason";
  model: string;
  request_id: string;
  provider: string;
  tee_verified: true;
}

/** A trace a later task may offer. Only `tee_verified: true` is kept. */
export interface TraceInput {
  step: "transcribe" | "reason";
  model: string;
  request_id: string;
  provider: string;
  tee_verified: boolean;
}

/** Live socket. Reminders and list items are not on this frame. */
export interface PhoneState {
  type: "phone";
  mode: Mode;
  live_lines: LiveLine[];
  traces: TraceRow[];
}

export interface CompanionView {
  reminders: Reminder[];
  items: ListItem[];
  summary?: MemorySummary | null;
}

/**
 * What a later task applies after a captured chunk.
 * Reminders and items update RAM whether or not the phone socket is open.
 * A live line is kept only while Live and the phone page are linked.
 */
export interface MemoryFeed {
  reminders?: Reminder[];
  items?: ListItem[];
  live?: LiveLine | null;
  traces?: TraceInput[];
}

export type Result = { ok: true } | { ok: false; reason: string };

const CLIENT_EVENT_SET = new Set<string>(CLIENT_EVENTS);

export function parseClientEvent(raw: string): ClientEvent | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: "bad_message" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { error: "bad_message" };
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || !CLIENT_EVENT_SET.has(type)) {
    return { error: "bad_message" };
  }
  return { type: type as ClientEventType };
}

export function faceLabel(face: Face): string {
  if (face === "locked") return LOCK_TEXT;
  if (face === "not_linked") return "Not linked";
  if (face === "live") return "Live";
  return "Companion";
}
