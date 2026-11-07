// The badge answers to a name. The default is seer. The phone can rename it.
// Addressing that name and asking to add a todo or an important item forces the add.
// The item is the other sentence: the one before the request, the one after it,
// or the next utterance when this one only points ahead. The request is not the item.
// An unclear voice does not count. A noisy room still does.

import type { MemoryOp } from "./working-set.ts";

export const DEFAULT_BADGE_NAME = "seer";

export type ForcedList = "todo" | "important";

export interface AddressMemory {
  previous: string;
  armed: ForcedList | null;
}

export interface AddressHit {
  list: ForcedList;
  text: string;
}

export function emptyAddressMemory(): AddressMemory {
  return { previous: "", armed: null };
}

const RESERVED = new Set([
  "hey", "hi", "hello", "ok", "okay", "yo", "the", "a", "an",
  "add", "put", "save", "note", "remember", "keep", "jot", "log", "stick", "capture", "include",
  "todo", "todos", "to-do", "to do", "task", "tasks",
  "important", "importance", "list", "item", "items",
  "this", "that", "reminder", "reminders",
]);

const GREET = new Set([
  "hey", "hi", "hello", "ok", "okay", "yo", "please", "can", "could", "would", "will", "you", "there", "a",
]);

const ADD = new Set(["add", "put", "save", "note", "remember", "keep", "jot", "log", "stick", "capture", "include"]);

const STOP = new Set([
  "a", "an", "the", "to", "on", "onto", "for", "of", "in", "my", "our", "your", "please",
  "hey", "hi", "hello", "ok", "okay", "yo", "can", "could", "would", "will", "you", "there",
  "just", "uh", "um", "and", "or", "yeah", "yep", "thanks", "thank",
]);

const POINTER = new Set([
  "this", "that", "it", "those", "last", "next", "thing", "things", "one", "sentence",
  "following", "previous", "what", "said", "something",
]);

const LISTISH = new Set(["todo", "todos", "task", "tasks", "important", "importance", "list", "item", "items", "do", "dos"]);

interface Span {
  word: string;
  start: number;
  end: number;
}

interface ListHit {
  list: ForcedList;
  start: number;
  end: number;
}

/** A display name of 2–24 letters, numbers, spaces, hyphens, or apostrophes. Null when it cannot be a name. */
export function normalizeBadgeName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 24) return null;
  if (!/^[A-Za-z][A-Za-z0-9 '-]*$/.test(name)) return null;
  if (RESERVED.has(name.toLowerCase())) return null;
  return name;
}

export function badgeNameOf(name: string | null | undefined): string {
  return normalizeBadgeName(name ?? "") ?? DEFAULT_BADGE_NAME;
}

/**
 * Read one verified transcript. `voice: "unclear"` leaves the memory untouched and adds nothing.
 * A missing voice is treated as clear enough to follow the name.
 */
export function hearAddress(input: {
  transcript: string;
  name: string;
  state: AddressMemory;
  voice: "clear" | "unclear" | null;
}): { add: AddressHit | null; state: AddressMemory } {
  if (input.voice === "unclear") return { add: null, state: input.state };
  const nameWords = words(badgeNameOf(input.name));
  const transcript = input.transcript.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  if (!transcript || nameWords.length === 0) return { add: null, state: input.state };

  const sentences = splitSentences(transcript);
  const commandAt = findCommand(sentences, nameWords);
  if (commandAt < 0) {
    if (input.state.armed) {
      const text = cleanPayload(transcript, nameWords);
      if (!text) return { add: null, state: input.state };
      return { add: { list: input.state.armed, text }, state: { previous: text, armed: null } };
    }
    const last = cleanPayload(sentences[sentences.length - 1] ?? transcript, nameWords);
    if (!last) return { add: null, state: input.state };
    return { add: null, state: { previous: last, armed: null } };
  }

  const command = sentences[commandAt];
  const shape = commandShape(command);
  const list = shape?.list ?? "todo";
  const before = sentences
    .slice(0, commandAt)
    .filter((sentence) => !isVocative(sentence, nameWords))
    .map((sentence) => cleanPayload(sentence, nameWords))
    .filter((sentence): sentence is string => sentence !== null);
  const lead = leadingContent(command, nameWords);
  if (lead) before.push(lead);
  const after = sentences
    .slice(commandAt + 1)
    .map((sentence) => cleanPayload(sentence, nameWords))
    .filter((sentence): sentence is string => sentence !== null);
  const inline = inlinePayload(command, nameWords);
  const priorIn = before.length > 0 ? before[before.length - 1] : null;
  const nextIn = after[0] ?? null;
  const pointer = pointerOf(command);
  const chosen = choose(pointer, inline, priorIn, nextIn, input.state.previous);
  const armed = chosen.arm ? list : null;
  const text = chosen.text;
  const previous = text ?? priorIn ?? input.state.previous;
  return {
    add: text ? { list, text } : null,
    state: { previous, armed },
  };
}

/** Drop an address the model stored as the task, and keep the forced item. */
export function withForcedAdd(ops: MemoryOp[], add: AddressHit | null, name: string): MemoryOp[] {
  if (!add) return ops;
  const nameWords = words(badgeNameOf(name));
  const kept = ops.filter((op) => {
    if (op.op !== "add_item" && op.op !== "add_reminder") return true;
    return !(isAddress(op.text, nameWords) && commandShape(op.text) !== null);
  });
  const text = add.text.trim();
  const already = kept.some(
    (op) => op.op === "add_item" && op.list.trim().toLowerCase() === add.list && op.text.trim().toLowerCase() === text.toLowerCase(),
  );
  if (!already) kept.push({ op: "add_item", list: add.list, text });
  return kept;
}

function choose(
  pointer: "next" | "last" | "this" | "none",
  inline: string | null,
  priorIn: string | null,
  nextIn: string | null,
  previous: string,
): { text: string | null; arm: boolean } {
  if (inline) return { text: inline, arm: false };
  if (pointer === "next") {
    if (nextIn) return { text: nextIn, arm: false };
    return { text: null, arm: true };
  }
  if (pointer === "last") {
    if (priorIn) return { text: priorIn, arm: false };
    if (previous) return { text: previous, arm: false };
    return { text: null, arm: false };
  }
  if (priorIn && nextIn) return { text: priorIn, arm: false };
  if (nextIn) return { text: nextIn, arm: false };
  if (priorIn) return { text: priorIn, arm: false };
  if (previous) return { text: previous, arm: false };
  return { text: null, arm: true };
}

function findCommand(sentences: string[], nameWords: string[]): number {
  for (let i = 0; i < sentences.length; i++) {
    if (!commandShape(sentences[i])) continue;
    if (isAddress(sentences[i], nameWords)) return i;
    if (i > 0 && isVocative(sentences[i - 1], nameWords)) return i;
  }
  return -1;
}

function commandShape(sentence: string): { list: ForcedList } | null {
  const colon = colonPayload(sentence);
  if (colon) return { list: colon.list };
  const tokens = spans(sentence).map((span) => span.word);
  const matched = matchCommand(tokens);
  if (!matched) return null;
  return { list: matched.list.list };
}

function isAddress(sentence: string, nameWords: string[]): boolean {
  const found = spans(sentence);
  const exact = nameWindow(found, nameWords, false);
  const slip = exact ?? nameWindow(found, nameWords, true);
  if (!slip) return false;
  const before = found.slice(0, slip.index).map((span) => span.word);
  const front = before.length === 0 || (before.length <= 3 && before.every((word) => GREET.has(word)));
  if (front) return true;
  if (!exact) return false;
  return commandShape(sentence) !== null;
}

function isVocative(sentence: string, nameWords: string[]): boolean {
  if (!isAddress(sentence, nameWords)) return false;
  const found = spans(sentence);
  const hit = nameWindow(found, nameWords, true);
  if (!hit) return false;
  const rest = found.filter((_, index) => index < hit.index || index >= hit.index + nameWords.length);
  return rest.every((span) => GREET.has(span.word) || POINTER.has(span.word));
}

function leadingContent(sentence: string, nameWords: string[]): string | null {
  const found = spans(sentence);
  const hit = nameWindow(found, nameWords, true);
  if (!hit || hit.index === 0) return null;
  let end = hit.index;
  while (end > 0 && GREET.has(found[end - 1].word)) end -= 1;
  if (end === 0) return null;
  return cleanPayload(sentence.slice(found[0].start, found[end - 1].end), nameWords);
}

function inlinePayload(sentence: string, nameWords: string[]): string | null {
  const colon = colonPayload(sentence);
  if (colon) return cleanPayload(colon.text, nameWords);
  const found = spans(sentence);
  const tokens = found.map((span) => span.word);
  const matched = matchCommand(tokens);
  if (!matched) return null;
  const between =
    matched.verb < matched.list.start
      ? cleanPayload(stripListLead(slice(sentence, found, matched.verb + 1, matched.list.start)), nameWords)
      : null;
  if (between) return between;
  let after = matched.list.end;
  if (tokens[after] === "list" || tokens[after] === "item" || tokens[after] === "items") after += 1;
  return cleanPayload(slice(sentence, found, after, tokens.length), nameWords);
}

function colonPayload(sentence: string): { list: ForcedList; text: string } | null {
  const important = /\bimportant\b\s*:\s*(.+)$/i.exec(sentence);
  const todo = /\b(?:to-?dos?|todos?|tasks?)\b\s*:\s*(.+)$/i.exec(sentence);
  if (important && todo) {
    const winner = (important.index ?? 0) > (todo.index ?? 0) ? important : todo;
    return { list: winner === important ? "important" : "todo", text: winner[1] ?? "" };
  }
  if (important) return { list: "important", text: important[1] ?? "" };
  if (todo) return { list: "todo", text: todo[1] ?? "" };
  return null;
}

function pointerOf(sentence: string): "next" | "last" | "this" | "none" {
  const tokens = words(sentence);
  if (tokens.includes("next") || tokens.includes("following")) return "next";
  if (tokens.includes("that") || tokens.includes("those") || tokens.includes("last") || tokens.includes("previous")) return "last";
  if (tokens.includes("this") || tokens.includes("it")) return "this";
  return "none";
}

function matchCommand(tokens: string[]): { verb: number; list: ListHit } | null {
  const lists = listHits(tokens);
  const verbs: number[] = [];
  tokens.forEach((token, index) => {
    if (ADD.has(token)) verbs.push(index);
  });
  let best: { verb: number; list: ListHit; gap: number } | null = null;
  for (const list of lists) {
    for (const verb of verbs) {
      if (verb >= list.start) continue;
      const gap = list.start - verb;
      if (!best || gap < best.gap) best = { verb, list, gap };
    }
  }
  return best ? { verb: best.verb, list: best.list } : null;
}

function listHits(tokens: string[]): ListHit[] {
  const hits: ListHit[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "important" || token === "importance") hits.push({ list: "important", start: i, end: i + 1 });
    else if (token === "todo" || token === "todos" || token === "task" || token === "tasks") {
      hits.push({ list: "todo", start: i, end: i + 1 });
    } else if (token === "to" && (tokens[i + 1] === "do" || tokens[i + 1] === "dos")) {
      const prev = tokens[i - 1];
      const named = prev === "the" || prev === "my" || prev === "our" || prev === "a";
      if (named || tokens[i + 2] === "list") hits.push({ list: "todo", start: i, end: i + 2 });
    }
  }
  return hits;
}

function stripListLead(text: string): string {
  return text.replace(/\s+(?:to|on|onto|for)(?:\s+(?:the|my|our|your|a))?$/i, "");
}

function cleanPayload(text: string, nameWords: string[]): string | null {
  const trimmed = text.replace(/^[\s,;:.-]+/, "").replace(/[.!?]+$/, "").trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  const tokens = words(trimmed);
  const meaningful = tokens.filter((word) => !STOP.has(word));
  if (meaningful.length === 0) return null;
  if (meaningful.every((word) => POINTER.has(word) || LISTISH.has(word))) return null;
  if (tokens.join(" ") === nameWords.join(" ")) return null;
  if (trimmed.length <= 240) return trimmed;
  const cut = trimmed.slice(0, 240);
  const space = cut.lastIndexOf(" ");
  return (space > 40 ? cut.slice(0, space) : cut).trim();
}

function splitSentences(transcript: string): string[] {
  const parts = transcript
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [transcript];
}

function slice(sentence: string, found: Span[], from: number, to: number): string {
  if (from >= to || from >= found.length) return "";
  const end = Math.min(to, found.length) - 1;
  return sentence.slice(found[from].start, found[end].end);
}

function nameWindow(found: Span[], nameWords: string[], allowSlip: boolean): { index: number } | null {
  if (nameWords.length === 0 || found.length < nameWords.length) return null;
  for (let i = 0; i <= found.length - nameWords.length; i++) {
    let matched = true;
    for (let j = 0; j < nameWords.length; j++) {
      if (!wordHit(found[i + j].word, nameWords[j], allowSlip)) {
        matched = false;
        break;
      }
    }
    if (matched) return { index: i };
  }
  return null;
}

function wordHit(heard: string, want: string, allowSlip: boolean): boolean {
  if (heard === want) return true;
  if (!allowSlip || want.length < 4 || heard.length < 4) return false;
  if (heard[0] !== want[0]) return false;
  if (Math.abs(heard.length - want.length) > 1) return false;
  return levenshtein(heard, want) <= 1;
}

function spans(sentence: string): Span[] {
  const found: Span[] = [];
  const pattern = /[A-Za-z0-9']+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sentence))) {
    found.push({
      word: match[0].replace(/'/g, "").toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return found;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/'/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
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
