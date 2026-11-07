import {
  badgeNameOf,
  emptyAddressMemory,
  hearAddress,
  normalizeBadgeName,
  withForcedAdd,
  type AddressMemory,
} from "./address.ts";
import { buildUtterance, clipDurationSec, type Utterance } from "./episode.ts";
import { guardUtterance, type Hearing } from "./hearing.ts";
import type {
  ClientEvent,
  Face,
  ListItem,
  LiveLine,
  MemoryFeed,
  Mode,
  PhoneState,
  Reminder,
  Result,
  ScreenState,
  TraceInput,
  TraceRow,
} from "./protocol.ts";
import { locksReason, type ReasonResult } from "./reason.ts";
import type { BackgroundLog } from "./storage.ts";
import { locksEnclave, type TranscribeResult } from "./transcribe.ts";
import {
  applyMemoryOps,
  applySummary,
  emptyWorkingSet,
  reviseWorkingSet,
  stampEpisodeRoots,
  workingSetFromStored,
  type MemoryOp,
  type PhoneRevision,
  type WorkingSet,
} from "./working-set.ts";

const MAX_CHUNK_BYTES = 256 * 1024;

export class Session {
  #fallbackName: string;
  #address: AddressMemory = emptyAddressMemory();
  #mode: Mode = "companion";
  #phoneLinked = false;
  #relayLinked = false;
  #locked = false;
  #index: WorkingSet = emptyWorkingSet();
  #liveLines: LiveLine[] = [];
  /** The latest live line is waiting for a translation from reason. */
  #caption = false;
  #traces: TraceRow[] = [];
  #pendingTrace: TraceRow | null = null;
  #capturedMode: Mode = "companion";
  #audioDurationSec = 0;
  #hearing: Hearing | null = null;
  #heard = "";
  #chunk: Uint8Array | null = null;
  #store: BackgroundLog | null = null;
  #log: Promise<void> = Promise.resolve();
  #screenListener: (() => void) | null = null;
  #phoneListener: (() => void) | null = null;

  constructor(options?: { badgeName?: string }) {
    this.#fallbackName = normalizeBadgeName(options?.badgeName ?? "") ?? "seer";
  }

  setScreenListener(listener: () => void): void {
    this.#screenListener = listener;
  }

  setPhoneListener(listener: () => void): void {
    this.#phoneListener = listener;
  }

  /** Ciphertext log. A version 1.0 index loads as an empty working set. */
  setStore(store: BackgroundLog): void {
    this.#store = store;
  }

  /** Resolves when the utterance log and the index write have finished. */
  storageSettled(): Promise<void> {
    return this.#log;
  }

  async loadMemory(): Promise<void> {
    if (!this.#store) return;
    try {
      this.#index = await this.#store.readCompanion();
    } catch (err) {
      console.error("index load failed", err);
    }
  }

  mode(): Mode {
    return this.#mode;
  }

  capturedMode(): Mode {
    return this.#capturedMode;
  }

  /** The name the wearer addresses. A stored name wins over the relay default. */
  badgeName(): string {
    return badgeNameOf(this.#index.badge_name ?? this.#fallbackName);
  }

  workingSet(): WorkingSet {
    return workingSetFromStored(this.#index);
  }

  /** Reload open reminders and items. A version 1.0 payload stays empty. */
  loadWorkingSet(value: unknown): void {
    this.#index = workingSetFromStored(value);
    if (this.#phoneLinked) this.#emitPhone();
  }

  relayLinked(): boolean {
    return this.#relayLinked;
  }

  phoneLinked(): boolean {
    return this.#phoneLinked;
  }

  /**
   * Badge socket count crossed zero. A drop cuts the mic and ends Live.
   * The next socket resumes Companion and does not replay a live line.
   */
  setRelayLinked(linked: boolean): void {
    if (linked === this.#relayLinked) return;
    this.#relayLinked = linked;
    if (!linked) {
      this.#mode = "companion";
      this.#liveLines = [];
      this.#caption = false;
      this.#wipeChunk();
    }
    this.#emit();
  }

  /**
   * Phone page socket. Closing it is how the page goes away.
   * Live returns to Companion. Open reminders and list items stay.
   */
  setPhoneLinked(linked: boolean): void {
    if (linked === this.#phoneLinked) return;
    this.#phoneLinked = linked;
    if (!linked) {
      const wasLive = this.#mode === "live";
      this.#mode = "companion";
      const hadLines = this.#liveLines.length > 0;
      this.#liveLines = [];
      this.#caption = false;
      if (wasLive || hadLines) this.#emitScreen();
      return;
    }
    this.#emitPhone();
  }

  screen(): ScreenState {
    return {
      type: "screen",
      face: this.#face(),
      mic_power: this.#micPower(),
    };
  }

  phone(): PhoneState {
    return {
      type: "phone",
      mode: this.#mode,
      live_lines: this.#liveLines.map((row) => ({ ...row })),
      traces: this.#traces.map((row) => ({ ...row })),
    };
  }

  /**
   * Dismiss or reword one open row, then write the index.
   * Null leaves the working set unchanged. The glass is not part of this.
   */
  async reviseCompanion(change: PhoneRevision): Promise<WorkingSet | null> {
    const previous = this.#index;
    const next = reviseWorkingSet(previous, change);
    if (!next) return null;
    this.#index = next;
    const store = this.#store;
    if (!store) return workingSetFromStored(this.#index);
    const pending = this.#log.then(() => store.writeCompanion(this.#index));
    this.#log = pending.then(
      () => undefined,
      () => undefined,
    );
    try {
      await pending;
    } catch (err) {
      console.error("companion revise failed", err);
      if (this.#index === next) this.#index = previous;
      return null;
    }
    return workingSetFromStored(this.#index);
  }

  /** Proof-checked read of the stored index. A failed proof is an empty view. */
  async readCompanion(): Promise<WorkingSet> {
    if (!this.#store) return emptyWorkingSet();
    try {
      return await this.#store.readCompanion();
    } catch {
      return emptyWorkingSet();
    }
  }

  reminders(): Reminder[] {
    return this.#index.reminders.map((row) => ({ ...row }));
  }

  items(): ListItem[] {
    return this.#index.items.map((row) => ({ ...row }));
  }

  retainedAudioBytes(): number {
    return this.#chunk?.byteLength ?? 0;
  }

  /** Clip waiting for a later task. Ownership moves to the caller. */
  takeClip(): Uint8Array | null {
    const clip = this.#chunk;
    this.#chunk = null;
    return clip;
  }

  handle(event: ClientEvent): Result {
    if (event.type === "press") return this.#press();
    return { ok: false, reason: "bad_message" };
  }

  /** One short clip. Companion accepts it while the phone page is closed. */
  acceptChunk(bytes: Uint8Array): Result {
    if (!this.#relayLinked) return { ok: false, reason: "not_linked" };
    if (this.#locked) return { ok: false, reason: "locked" };
    if (bytes.byteLength === 0) return { ok: false, reason: "empty_chunk" };
    if (bytes.byteLength > MAX_CHUNK_BYTES) return { ok: false, reason: "chunk_too_large" };
    if (this.#chunk) return { ok: false, reason: "one_chunk" };
    this.#chunk = new Uint8Array(bytes);
    this.#capturedMode = this.#mode;
    this.#audioDurationSec = clipDurationSec(this.#chunk);
    return { ok: true };
  }

  /**
   * A verified transcript stays off the glass. The trace is kept until reason
   * accepts the utterance. A failed TEE check or a 502/503 locks and paints nothing.
   */
  acceptTranscribe(result: TranscribeResult): Result {
    if (this.#locked) return { ok: false, reason: "locked" };
    if (!result.ok) {
      this.#pendingTrace = null;
      this.#hearing = null;
      this.#heard = "";
      if (locksEnclave(result)) this.lock();
      return { ok: false, reason: result.reason };
    }
    this.#pendingTrace = { ...result.trace };
    this.#hearing = result.hearing ?? null;
    this.#heard = result.text;
    this.#showCaption(result.text, "");
    return { ok: true };
  }

  /**
   * Apply memory operations only after a verified reason.
   * RAM updates and the live line go out before the storage write is awaited.
   * An unverified result locks, paints nothing, and leaves the index unchanged.
   * A missing trace updates RAM for a direct apply and does not become an utterance.
   */
  acceptReason(
    result: ReasonResult,
    timestamp: number,
    source?: { mode?: Mode; audioDurationSec?: number },
  ): Result {
    if (this.#locked) return { ok: false, reason: "locked" };
    if (!result.ok) {
      this.#caption = false;
      this.#pendingTrace = null;
      this.#hearing = null;
      this.#heard = "";
      if (locksReason(result)) this.lock();
      return { ok: false, reason: result.reason };
    }
    if (!Number.isFinite(timestamp)) return { ok: false, reason: "bad_timestamp" };
    const pending = this.#pendingTrace;
    const heard = this.#heard;
    const voice = this.#hearing?.voice ?? null;
    const transcript = this.#heard || result.transcript;
    const addressed = hearAddress({
      transcript,
      name: this.badgeName(),
      state: this.#address,
      voice,
    });
    this.#address = addressed.state;
    const guarded = this.#hearing
      ? guardUtterance({
          memoryOps: result.memory_ops,
          summary: result.summary,
          transcript,
          hearing: this.#hearing,
          index: this.#index,
        })
      : null;
    const memoryOps = withForcedAdd(guarded ? guarded.memory_ops : result.memory_ops, addressed.add, this.badgeName());
    const summary = guarded ? guarded.summary : result.summary;
    const utterance = buildUtterance({
      timestamp,
      mode: source?.mode ?? this.#capturedMode,
      audioDurationSec: source?.audioDurationSec ?? this.#audioDurationSec,
      transcript: result.transcript,
      translation: result.translation,
      memoryOps,
      summary,
      transcribe: pending,
      reason: result.trace,
    });
    this.#index = applySummary(applyMemoryOps(this.#index, memoryOps, timestamp), summary, timestamp);
    if (pending) this.#traces.push(pending);
    this.#pendingTrace = null;
    this.#traces.push({ ...result.trace });
    if (voice !== "unclear") this.#showCaption(result.transcript || heard, result.translation);
    this.#caption = false;
    this.#hearing = null;
    this.#heard = "";
    if (this.#phoneLinked) this.#emitPhone();
    if (utterance) this.#schedule(utterance, memoryOps, timestamp);
    return { ok: true };
  }

  /**
   * Apply a later task's memory update. The phone socket is not required.
   * A lock leaves the index unchanged and paints no live line.
   */
  feedMemory(feed: MemoryFeed): Result {
    if (this.#locked) return { ok: false, reason: "locked" };
    let changed = false;
    for (const reminder of feed.reminders ?? []) {
      const next = cleanReminder(reminder);
      if (!next) continue;
      this.#index.reminders.push(next);
      changed = true;
    }
    for (const item of feed.items ?? []) {
      const next = cleanItem(item);
      if (!next) continue;
      this.#index.items.push(next);
      changed = true;
    }
    for (const trace of feed.traces ?? []) {
      const next = cleanTrace(trace);
      if (!next) continue;
      this.#traces.push(next);
      changed = true;
    }
    if (feed.live && this.#mode === "live" && this.#phoneLinked) {
      const line = cleanLine(feed.live);
      if (line) {
        this.#liveLines.push(line);
        changed = true;
      }
    }
    if (changed && this.#phoneLinked) this.#emitPhone();
    return { ok: true };
  }

  /** Enclave failure. Mic power drops. Nothing new is painted or remembered. */
  lock(): void {
    this.#locked = true;
    this.#mode = "companion";
    this.#liveLines = [];
    this.#caption = false;
    this.#pendingTrace = null;
    this.#hearing = null;
    this.#heard = "";
    this.#address = emptyAddressMemory();
    this.#wipeChunk();
    this.#emit();
  }

  /** Live shows the verified words now. Reason fills the translation when it verifies. */
  #showCaption(transcript: string, translation: string): void {
    if (this.#mode !== "live" || !this.#phoneLinked) return;
    if (this.#hearing?.voice === "unclear") return;
    const line = cleanLine({ transcript, translation });
    if (!line) return;
    if (this.#caption && this.#liveLines.length > 0) this.#liveLines[this.#liveLines.length - 1] = line;
    else {
      this.#liveLines.push(line);
      this.#caption = true;
    }
    this.#emitPhone();
  }

  /** Successful private heartbeat. Live lines stay gone. */
  heartbeatOk(): Result {
    if (!this.#locked) return { ok: false, reason: "not_locked" };
    this.#locked = false;
    this.#mode = "companion";
    this.#liveLines = [];
    this.#emit();
    return { ok: true };
  }

  #press(): Result {
    if (!this.#relayLinked) return { ok: false, reason: "not_linked" };
    if (this.#locked) return { ok: false, reason: "locked" };
    if (this.#mode === "live") {
      this.#mode = "companion";
      this.#liveLines = [];
      this.#emit();
      return { ok: true };
    }
    if (!this.#phoneLinked) return { ok: false, reason: "phone_closed" };
    this.#mode = "live";
    this.#emit();
    return { ok: true };
  }

  #face(): Face {
    if (!this.#relayLinked) return "not_linked";
    if (this.#locked) return "locked";
    return this.#mode;
  }

  #micPower(): boolean {
    return this.#relayLinked && !this.#locked;
  }

  #schedule(utterance: Utterance, ops: MemoryOp[], timestamp: number): void {
    const store = this.#store;
    if (!store) return;
    const memoryOps = ops.map((op) =>
      op.op === "add_item" ? { op: op.op, list: op.list, text: op.text } : { op: op.op, text: op.text },
    );
    this.#log = this.#log.then(() => this.#logUtterance(store, utterance, memoryOps, timestamp));
  }

  async #logUtterance(store: BackgroundLog, utterance: Utterance, ops: MemoryOp[], timestamp: number): Promise<void> {
    try {
      const prepared = await store.prepareUtterance(utterance);
      stampEpisodeRoots(this.#index, ops, timestamp, prepared.root);
      await store.writeUtterance(prepared.root, prepared.cipher, () => this.#index);
    } catch (err) {
      console.error("utterance log failed", err);
    }
  }

  #wipeChunk(): void {
    this.#chunk?.fill(0);
    this.#chunk = null;
  }

  #emit(): void {
    this.#emitScreen();
    this.#emitPhone();
  }

  #emitScreen(): void {
    this.#screenListener?.();
  }

  #emitPhone(): void {
    this.#phoneListener?.();
  }
}

function cleanReminder(value: Reminder): Reminder | null {
  if (typeof value?.text !== "string" || !Number.isFinite(value.mentioned_at)) return null;
  const text = value.text.trim();
  if (!text) return null;
  return { text, mentioned_at: value.mentioned_at };
}

function cleanItem(value: ListItem): ListItem | null {
  if (typeof value?.text !== "string" || typeof value?.list !== "string") return null;
  if (!Number.isFinite(value.updated_at)) return null;
  const text = value.text.trim();
  const list = value.list.trim();
  if (!text || !list) return null;
  return { list, text, updated_at: value.updated_at };
}

function cleanLine(value: LiveLine): LiveLine | null {
  if (typeof value?.transcript !== "string" || typeof value?.translation !== "string") return null;
  const transcript = value.transcript.trim();
  if (!transcript) return null;
  return { transcript, translation: value.translation.trim() };
}

function cleanTrace(value: TraceInput): TraceRow | null {
  if (value?.tee_verified !== true) return null;
  if (value.step !== "transcribe" && value.step !== "reason") return null;
  if (!nonEmpty(value.model) || !nonEmpty(value.request_id) || !nonEmpty(value.provider)) return null;
  return {
    step: value.step,
    model: value.model,
    request_id: value.request_id,
    provider: value.provider,
    tee_verified: true,
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
