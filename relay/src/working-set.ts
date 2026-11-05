// Open reminders and open list items. Age does not close them.
// A version 1.0 index from the previous badge is not this working set.

import type { ListItem, Reminder } from "./protocol.ts";

export interface WorkingSet {
  version: "2.0";
  reminders: Reminder[];
  items: ListItem[];
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
  return {
    version: "2.0",
    reminders: index.reminders.map((row) => ({ ...row })),
    items: index.items.map((row) => ({ ...row })),
  };
}

/** Version 1.0, or anything else that is not this product, loads as empty. */
export function workingSetFromStored(value: unknown): WorkingSet {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return emptyWorkingSet();
  if ("audio" in value || "direction" in value || "pin" in value || "pinned" in value) return emptyWorkingSet();
  const record = value as { version?: unknown; reminders?: unknown; items?: unknown; lists?: unknown };
  if (record.version !== "2.0") return emptyWorkingSet();
  const next = emptyWorkingSet();
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
      ? index.reminders.map((row) => `- ${row.text} | mentioned_at: ${row.mentioned_at}`).join("\n")
      : "(none)";
  const items =
    index.items.length > 0
      ? index.items.map((row) => `- ${row.list} | ${row.text} | updated_at: ${row.updated_at}`).join("\n")
      : "(none)";
  return [`reminders:`, reminders, `items:`, items].join("\n");
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

function closeItem(index: WorkingSet, text: string): void {
  const label = text.trim();
  if (!label) return;
  index.items = index.items.filter((row) => !same(row.text, label));
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
