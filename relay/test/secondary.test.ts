// The badge is not on the bench. A clip still becomes sealed memory:
// reminders, a todo list, and a summary with the important points.
// Storage here is CipherLog on InMemoryOg. The proof check is the 0G SDK's.

import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/session.ts";
import { createStorageKey } from "../src/seal.ts";
import { CipherLog, InMemoryOg } from "../src/storage.ts";
import type { TranscribeTrace } from "../src/transcribe.ts";
import type { ReasonTrace } from "../src/reason.ts";
import { applySummary, emptyWorkingSet } from "../src/working-set.ts";
import { GALILEO_FLOW, GALILEO_RPC, MAINNET_FLOW, MAINNET_INDEXER, MAINNET_RPC, storageEndpoints } from "../src/zerog.ts";

const spoken =
  "Remind me to meet Kenji on Thursday. I still owe him 5 USDC. Pick up the dry cleaning and email the landlord about the leak.";
const when = 1729864200;

const transcribe: TranscribeTrace = {
  step: "transcribe",
  model: "whisper-large-v3",
  request_id: "req-transcribe",
  provider: "0xtranscribe",
  tee_verified: true,
};

function reasonTrace(requestId: string): ReasonTrace {
  return {
    step: "reason",
    model: "fixture-private-chat",
    request_id: requestId,
    provider: "0xreason",
    tee_verified: true,
  };
}

const summary = {
  text: "Thursday with Kenji is open, 5 USDC is unpaid, and two chores were added.",
  points: [
    "Meet Kenji Thursday",
    "5 USDC still unpaid",
    "Pick up the dry cleaning",
    "Email the landlord about the leak",
  ],
};

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return false;
  for (let i = 0; i <= haystack.byteLength - needle.byteLength; i += 1) {
    let same = true;
    for (let j = 0; j < needle.byteLength; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        same = false;
        break;
      }
    }
    if (same) return true;
  }
  return false;
}

test("storage stays on Galileo unless the network is mainnet", () => {
  assert.equal(storageEndpoints(undefined).rpcUrl, GALILEO_RPC);
  assert.equal(storageEndpoints("galileo").flowAddress, GALILEO_FLOW);
  assert.equal(storageEndpoints("mainnet").rpcUrl, MAINNET_RPC);
  assert.equal(storageEndpoints("mainnet").indexerUrl, MAINNET_INDEXER);
  assert.equal(storageEndpoints("mainnet").flowAddress, MAINNET_FLOW);
});

test("an empty summary leaves the previous points in place", () => {
  const opened = applySummary(emptyWorkingSet(), summary, when);
  const kept = applySummary(opened, { text: "", points: [] }, when + 30);
  assert.equal(kept.summary?.mentioned_at, when);
  assert.deepEqual(kept.summary?.points, summary.points);
  assert.equal(opened.summary?.episode_root, undefined);
});

test("a clip uploads todos and a summary without the badge, and a later close keeps the rest", async () => {
  const key = createStorageKey();
  const network = new InMemoryOg();
  const log = new CipherLog(key, network);
  const session = new Session();
  session.setStore(log);
  session.setRelayLinked(true);
  assert.equal(session.phoneLinked(), false);
  assert.equal(session.acceptChunk(new Uint8Array(3200)).ok, true);
  assert.equal(
    session.acceptTranscribe({ ok: true, text: spoken, trace: transcribe }).ok,
    true,
  );
  assert.equal(
    session.acceptReason(
      {
        ok: true,
        memory_ops: [
          { op: "add_reminder", text: "Meet Kenji Thursday" },
          { op: "add_item", list: "open", text: "Send Kenji 5 USDC" },
          { op: "add_item", list: "todo", text: "Pick up the dry cleaning" },
          { op: "add_item", list: "todo", text: "Email the landlord about the leak" },
        ],
        transcript: spoken,
        translation: "",
        summary,
        trace: reasonTrace("req-reason"),
      },
      when,
    ).ok,
    true,
  );
  assert.equal(session.screen().face, "companion");
  assert.equal(JSON.stringify(session.screen()).includes("dry cleaning"), false);
  assert.equal(JSON.stringify(session.screen()).includes(spoken), false);
  await session.storageSettled();

  const view = await session.readCompanion();
  assert.equal(view.reminders[0]?.text, "Meet Kenji Thursday");
  assert.equal(view.reminders[0]?.mentioned_at, when);
  const root = view.reminders[0]?.episode_root ?? "";
  assert.match(root, /^0x[0-9a-f]{64}$/);
  assert.equal(view.summary?.episode_root, root);
  assert.deepEqual(view.summary?.points, summary.points);
  assert.equal(view.summary?.text, summary.text);
  const todos = view.items.filter((item) => item.list === "todo");
  assert.deepEqual(
    todos.map((item) => item.text),
    ["Pick up the dry cleaning", "Email the landlord about the leak"],
  );
  assert.equal(todos.every((item) => item.episode_root === root), true);
  assert.equal(view.items.find((item) => item.list === "open")?.text, "Send Kenji 5 USDC");

  const utterance = await log.readUtterance(root);
  assert.deepEqual(utterance?.summary, summary);
  assert.equal(utterance?.traces[1]?.request_id, "req-reason");
  assert.equal(Object.hasOwn(utterance ?? {}, "audio"), false);
  const stored = await network.getBlob(root);
  assert.ok(stored);
  assert.equal(contains(stored, new TextEncoder().encode("dry cleaning")), false);
  assert.equal(contains(stored, new TextEncoder().encode(spoken)), false);
  assert.equal(contains(stored, key), false);

  assert.equal(
    session.acceptTranscribe({ ok: true, text: "I picked up the dry cleaning.", trace: { ...transcribe, request_id: "req-t2" } }).ok,
    true,
  );
  assert.equal(
    session.acceptReason(
      {
        ok: true,
        memory_ops: [{ op: "close_item", text: "Pick up the dry cleaning" }],
        transcript: "I picked up the dry cleaning.",
        translation: "",
        summary: { text: "The dry cleaning is done.", points: ["Dry cleaning picked up"] },
        trace: reasonTrace("req-close"),
      },
      when + 3600,
    ).ok,
    true,
  );
  await session.storageSettled();
  const later = await session.readCompanion();
  assert.equal(later.reminders[0]?.mentioned_at, when);
  assert.equal(later.items.some((item) => item.text === "Pick up the dry cleaning"), false);
  assert.equal(later.items.some((item) => item.text === "Email the landlord about the leak"), true);
  assert.equal(later.items.some((item) => item.text === "Send Kenji 5 USDC"), true);
  assert.equal(later.summary?.text, "The dry cleaning is done.");
  assert.equal(later.summary?.mentioned_at, when + 3600);
  assert.equal(later.reminders[0]?.episode_root, root);
});
