// Open reminders and open list items. Age does not close them.
// A version 1.0 index from the previous badge is not this working set.

import { normalizeBadgeName } from "./address.ts";
import type { ListItem, MemorySummary, Reminder } from "./protocol.ts";

export interface WorkingSet {
  version: "2.0";
  reminders: Reminder[];
  items: ListItem[];
  summary?: MemorySummary | null;
  /** Programmed badge name. Absent means the relay default, which is seer. */
  badge_name?: string;
}

export interface SummaryDraft {
  text: string;
  points: string[];
}

export type MemoryOp =
  | { op: "add_reminder"; text: string }
  | { op: "close_reminder"; text: string }
  | { op: "add_item"; list: string; text: string }
  | { op: "close_item"; text: string };

export function emptyWorkingSet(): WorkingSet {
  return { version: "2.0", reminders: [], items: [] };
}

export function cloneWorkingSet(index: WorkingSet): WorkingSet {
  const summary = index.summary;
  return {
    version: "2.0",
    reminders: index.reminders.map((row) => ({ ...row })),
    items: index.items.map((row) => ({ ...row })),
    ...(summary ? { summary: { ...summary, points: [...summary.points] } } : {}),
    ...(index.badge_name ? { badge_name: index.badge_name } : {}),
  };
}

/** Version 1.0, or anything else that is not this product, loads as empty. */
export function workingSetFromStored(value: unknown): WorkingSet {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return emptyWorkingSet();
  if ("audio" in value || "direction" in value || "pin" in value || "pinned" in value) return emptyWorkingSet();
  const record = value as {
    version?: unknown;
    reminders?: unknown;
    items?: unknown;
    lists?: unknown;
    summary?: unknown;
    badge_name?: unknown;
  };
  if (record.version !== "2.0") return emptyWorkingSet();
  const next = emptyWorkingSet();
  const summary = cleanSummary(record.summary);
  if (summary) next.summary = summary;
  const badgeName = typeof record.badge_name === "string" ? normalizeBadgeName(record.badge_name) : null;
  if (badgeName) next.badge_name = badgeName;
  if (Array.isArray(record.reminders)) {
    for (const row of record.reminders) {
      const reminder = cleanReminder(row);
      if (reminder) next.reminders.push(reminder);
    }
  }
  const itemRows = Array.isArray(record.lists) ? record.lists : record.items;
  if (Array.isArray(itemRows)) {
    for (const row of itemRows) {
      const item = cleanItem(row);
      if (item) next.items.push(item);
    }
  }
  return next;
}

/**
 * Stamp this utterance's root onto rows it just added.
 * A duplicate add keeps its original root. Mutates `index`.
 */
export function stampEpisodeRoots(index: WorkingSet, ops: MemoryOp[], timestamp: number, root: string): void {
  if (!Number.isFinite(timestamp) || root.length === 0) return;
  for (const op of ops) {
    if (op.op === "add_reminder") {
      const row = index.reminders.find((item) => same(item.text, op.text) && item.mentioned_at === timestamp);
      if (row && !row.episode_root) row.episode_root = root;
    } else if (op.op === "add_item") {
      const row = index.items.find(
        (item) => same(item.text, op.text) && same(item.list, op.list) && item.updated_at === timestamp,
      );
      if (row && !row.episode_root) row.episode_root = root;
    }
  }
  if (index.summary && index.summary.mentioned_at === timestamp && !index.summary.episode_root) {
    index.summary.episode_root = root;
  }
}

/**
 * Keep a non-empty summary from this utterance.
 * An empty draft leaves the previous summary in place. Does not mutate `index`.
 */
export function applySummary(index: WorkingSet, draft: SummaryDraft | null | undefined, timestamp: number): WorkingSet {
  const next = cloneWorkingSet(index);
  if (!draft || !Number.isFinite(timestamp)) return next;
  const text = draft.text.trim();
  const points = draft.points.map((point) => point.trim()).filter((point) => point.length > 0);
  if (!text && points.length === 0) return next;
  next.summary = { text, points, mentioned_at: timestamp };
  return next;
}

export type PhoneRevision =
  | { action: "close_reminder"; text: string }
  | { action: "edit_reminder"; text: string; next: string }
  | { action: "close_item"; list: string; text: string }
  | { action: "edit_item"; list: string; text: string; next: string }
  | { action: "rename_badge"; name: string };

/** A phone dismiss, wording change, or badge rename. Null is a bad body. A blank `next` is still a revision, and revise refuses it. */
export function parsePhoneRevision(value: unknown): PhoneRevision | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as { action?: unknown; text?: unknown; next?: unknown; list?: unknown; name?: unknown };
  if (row.action === "rename_badge") {
    if (typeof row.name !== "string") return null;
    return { action: "rename_badge", name: row.name };
  }
  const text = typeof row.text === "string" ? row.text.trim() : "";
  if (!text) return null;
  if (row.action === "close_reminder") return { action: "close_reminder", text };
  if (row.action === "edit_reminder") {
    if (typeof row.next !== "string") return null;
    return { action: "edit_reminder", text, next: row.next };
  }
  const list = typeof row.list === "string" ? row.list.trim() : "";
  if (!list) return null;
  if (row.action === "close_item") return { action: "close_item", list, text };
  if (row.action === "edit_item") {
    if (typeof row.next !== "string") return null;
    return { action: "edit_item", list, text, next: row.next };
  }
  return null;
}

/**
 * Dismiss or reword one open row. Does not mutate `index`.
 * Null when the row is missing, the wording is empty, or it would copy another open row.
 * The time, the list name, and the episode root stay.
 */
export function reviseWorkingSet(index: WorkingSet, change: PhoneRevision): WorkingSet | null {
  const next = cloneWorkingSet(index);
  if (change.action === "rename_badge") {
    const name = normalizeBadgeName(change.name);
    if (!name) return null;
    next.badge_name = name;
    return next;
  }
  if (change.action === "close_reminder") {
    const before = next.reminders.length;
    next.reminders = next.reminders.filter((row) => !same(row.text, change.text));
    return next.reminders.length === before ? null : next;
  }
  if (change.action === "edit_reminder") return editReminder(next, change.text, change.next);
  if (change.action === "close_item") {
    const before = next.items.length;
    next.items = next.items.filter((row) => !(same(row.text, change.text) && same(row.list, change.list)));
    return next.items.length === before ? null : next;
  }
  return editItem(next, change.list, change.text, change.next);
}

/** Apply one verified utterance. Does not mutate `index`. A duplicate add keeps the original time. */
export function applyMemoryOps(index: WorkingSet, ops: MemoryOp[], timestamp: number): WorkingSet {
  const next = cloneWorkingSet(index);
  if (!Number.isFinite(timestamp)) return next;
  for (const op of ops) {
    if (op.op === "add_reminder") addReminder(next, op.text, timestamp);
    else if (op.op === "close_reminder") closeReminder(next, op.text);
    else if (op.op === "add_item") addItem(next, op.list, op.text, timestamp);
    else closeItem(next, op.text);
  }
  return next;
}

export function workingSetPrompt(index: WorkingSet): string {
  const reminders =
    index.reminders.length > 0
      ? index.reminders.map((row) => `- ${row.text} (mentioned_at ${row.mentioned_at})`).join("\n")
      : "(none)";
  const items =
    index.items.length > 0
      ? index.items.map((row) => `- ${row.list}: ${row.text} (updated_at ${row.updated_at})`).join("\n")
      : "(none)";
  return [
    `reminders:`,
    reminders,
    `items:`,
    items,
    `A close copies the text before the parenthesis. Finishing a debt or a task does not close a reminder.`,
  ].join("\n");
}

function addReminder(index: WorkingSet, text: string, timestamp: number): void {
  const label = text.trim();
  if (!label) return;
  if (index.reminders.some((row) => same(row.text, label))) return;
  index.reminders.push({ text: label, mentioned_at: timestamp });
}

function closeReminder(index: WorkingSet, text: string): void {
  const label = text.trim();
  if (!label) return;
  index.reminders = index.reminders.filter((row) => !same(row.text, label));
}

function addItem(index: WorkingSet, list: string, text: string, timestamp: number): void {
  const label = text.trim();
  const name = list.trim();
  if (!label || !name) return;
  if (index.items.some((row) => same(row.text, label) && same(row.list, name))) return;
  index.items.push({ list: name, text: label, updated_at: timestamp });
}

function editReminder(index: WorkingSet, text: string, next: string): WorkingSet | null {
  const edited = next.trim();
  if (!edited) return null;
  const row = index.reminders.find((item) => same(item.text, text));
  if (!row) return null;
  if (index.reminders.some((item) => item !== row && same(item.text, edited))) return null;
  row.text = edited;
  return index;
}

function editItem(index: WorkingSet, list: string, text: string, next: string): WorkingSet | null {
  const edited = next.trim();
  if (!edited) return null;
  const row = index.items.find((item) => same(item.text, text) && same(item.list, list));
  if (!row) return null;
  if (index.items.some((item) => item !== row && same(item.text, edited) && same(item.list, row.list))) return null;
  row.text = edited;
  return index;
}

function closeItem(index: WorkingSet, text: string): void {
  const label = text.trim();
  if (!label) return;
  index.items = index.items.filter((row) => !same(row.text, label));
}

function cleanSummary(value: unknown): MemorySummary | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as { text?: unknown; points?: unknown; mentioned_at?: unknown; episode_root?: unknown };
  if (typeof row.text !== "string" || !Number.isFinite(row.mentioned_at) || !Array.isArray(row.points)) return null;
  const text = row.text.trim();
  const points = row.points
    .filter((point): point is string => typeof point === "string")
    .map((point) => point.trim())
    .filter((point) => point.length > 0);
  if (!text && points.length === 0) return null;
  const episodeRoot = rootOf(row.episode_root);
  return episodeRoot
    ? { text, points, mentioned_at: row.mentioned_at as number, episode_root: episodeRoot }
    : { text, points, mentioned_at: row.mentioned_at as number };
}

function cleanReminder(value: unknown): Reminder | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as { text?: unknown; mentioned_at?: unknown; episode_root?: unknown };
  if (typeof row.text !== "string" || !Number.isFinite(row.mentioned_at)) return null;
  const text = row.text.trim();
  if (!text) return null;
  const episodeRoot = rootOf(row.episode_root);
  return episodeRoot
    ? { text, mentioned_at: row.mentioned_at as number, episode_root: episodeRoot }
    : { text, mentioned_at: row.mentioned_at as number };
}

function cleanItem(value: unknown): ListItem | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as { list?: unknown; text?: unknown; updated_at?: unknown; episode_root?: unknown };
  if (typeof row.text !== "string" || typeof row.list !== "string" || !Number.isFinite(row.updated_at)) {
    return null;
  }
  const text = row.text.trim();
  const list = row.list.trim();
  if (!text || !list) return null;
  const episodeRoot = rootOf(row.episode_root);
  return episodeRoot
    ? { list, text, updated_at: row.updated_at as number, episode_root: episodeRoot }
    : { list, text, updated_at: row.updated_at as number };
}

function rootOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const root = value.trim();
  return root.length > 0 ? root : undefined;
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
