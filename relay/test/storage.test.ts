import assert from "node:assert/strict";
import test from "node:test";
import { buildUtterance, clipDurationSec } from "../src/episode.ts";
import type { ReasonTrace } from "../src/reason.ts";
import { createStorageKey, open, seal } from "../src/seal.ts";
import { CipherLog, InMemoryOg } from "../src/storage.ts";
import { downloadWithProof } from "../src/zerog.ts";
import type { TranscribeTrace } from "../src/transcribe.ts";
import { applyMemoryOps, emptyWorkingSet, stampEpisodeRoots } from "../src/working-set.ts";

const transcript = "I'll meet Kenji on Thursday. I still owe him 5 USDC.";
const translation = "";

const transcribeTrace: TranscribeTrace = {
  step: "transcribe",
  model: "whisper-large-v3",
  request_id: "0852f405-6c56-40c2-a800-e6fd70785065",
  provider: "0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C",
  tee_verified: true,
};

const reasonTrace: ReasonTrace = {
  step: "reason",
  model: "fixture-private-chat",
  request_id: "req-reason",
  provider: "0xprovider",
  tee_verified: true,
};

const kenjiOps = [
  { op: "add_reminder" as const, text: "Meet Kenji Thursday" },
  { op: "add_item" as const, list: "open", text: "Send Kenji 5 USDC" },
];

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

function jsonFrom(key: Uint8Array, bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(open(key, bytes)));
}

test("pcm duration ignores a wav header", () => {
  const pcm = new Uint8Array(32000);
  assert.equal(clipDurationSec(pcm), 1);
  const wav = new Uint8Array(44 + 32000);
  wav.set([0x52, 0x49, 0x46, 0x46], 0);
  wav.set([0x57, 0x41, 0x56, 0x45], 8);
  assert.equal(clipDurationSec(wav), 1);
  assert.equal(clipDurationSec(Uint8Array.from([1, 2, 3, 4])), 0);
});

test("ciphertext round-trips and leaves plaintext and the key out of the stored bytes", async () => {
  const key = createStorageKey();
  const network = new InMemoryOg();
  const log = new CipherLog(key, network);
  const utterance = buildUtterance({
    timestamp: 1729864200,
    mode: "companion",
    audioDurationSec: 3.5,
    transcript,
    translation,
    memoryOps: kenjiOps,
    transcribe: transcribeTrace,
    reason: reasonTrace,
  });
  assert.ok(utterance);
  assert.equal(utterance.version, "2.0");
  assert.equal(Object.hasOwn(utterance, "audio"), false);
  assert.equal(Object.hasOwn(utterance, "direction"), false);
  assert.equal(Object.hasOwn(utterance, "pin"), false);
  assert.equal(Object.hasOwn(utterance, "pinned"), false);
  assert.equal(Object.hasOwn(utterance, "subtitle"), false);
  const prepared = await log.prepareUtterance(utterance);
  assert.match(prepared.root, /^0x[0-9a-f]{64}$/);
  const index = applyMemoryOps(emptyWorkingSet(), kenjiOps, 1729864200);
  stampEpisodeRoots(index, kenjiOps, 1729864200, prepared.root);
  await log.writeUtterance(prepared.root, prepared.cipher, () => index);
  assert.deepEqual(await log.readUtterance(prepared.root), utterance);
  const view = await log.readCompanion();
  assert.equal(view.reminders[0]?.episode_root, prepared.root);
  assert.equal(view.items[0]?.episode_root, prepared.root);
  assert.equal(view.reminders[0]?.mentioned_at, 1729864200);

  const stored = await network.getBlob(prepared.root);
  const pointerBytes = await network.getIndex();
  assert.ok(stored);
  assert.ok(pointerBytes);
  const pointer = jsonFrom(key, pointerBytes) as { version?: string; root?: string };
  assert.equal(pointer.version, "2.0");
  assert.equal(typeof pointer.root, "string");
  const indexCipher = await network.getBlob(pointer.root ?? "");
  assert.ok(indexCipher);
  const document = jsonFrom(key, indexCipher) as {
    version?: string;
    lists?: Array<{ episode_root?: string; text?: string }>;
    items?: unknown;
    audio?: unknown;
  };
  assert.equal(document.version, "2.0");
  assert.equal(document.lists?.[0]?.episode_root, prepared.root);
  assert.equal(document.lists?.[0]?.text, "Send Kenji 5 USDC");
  assert.equal(document.items, undefined);
  assert.equal(document.audio, undefined);
  const plain = new TextEncoder().encode(transcript);
  assert.equal(contains(stored, plain), false);
  assert.equal(contains(indexCipher, plain), false);
  assert.equal(contains(pointerBytes, plain), false);
  assert.equal(contains(stored, key), false);
  assert.equal(contains(indexCipher, key), false);
  assert.equal(contains(pointerBytes, key), false);
  assert.throws(() => open(createStorageKey(), stored));
});

test("a missing or unverified trace is not an utterance", () => {
  const base = {
    timestamp: 1729864200,
    mode: "companion" as const,
    audioDurationSec: 1,
    transcript,
    translation,
    memoryOps: kenjiOps,
    transcribe: transcribeTrace,
    reason: reasonTrace,
  };
  assert.equal(buildUtterance({ ...base, transcribe: null }), null);
  assert.equal(buildUtterance({ ...base, reason: null }), null);
  const unverified = { ...transcribeTrace, tee_verified: false as true };
  assert.equal(buildUtterance({ ...base, transcribe: unverified }), null);
  assert.equal(
    buildUtterance({ ...base, memoryOps: [{ op: "open_loop", text: "Send Kenji 5 USDC", who: "Kenji" } as never] }),
    null,
  );
});

test("a version 1.0 payload does not become an utterance or reminders", async () => {
  const key = createStorageKey();
  const network = new InMemoryOg();
  const log = new CipherLog(key, network);
  const legacy = {
    version: "1.0",
    timestamp: 1729864200,
    direction: "wearer",
    transcript,
    subtitle: "Send Kenji 5 USDC",
    pinned: false,
    memory_ops: [{ op: "open_loop", text: "Send Kenji 5 USDC", who: "Kenji" }],
  };
  const cipher = sealLegacy(key, legacy);
  const root = await network.merkleRoot(cipher);
  await network.putBlob(root, cipher);
  assert.equal(await log.readUtterance(root), null);

  const indexCipher = sealLegacy(key, {
    version: "1.0",
    open_loops: [{ text: "Send Kenji 5 USDC", who: "Kenji", episode_root: root }],
    people: [],
    pins: [],
    recent: [],
  });
  const indexRoot = await network.merkleRoot(indexCipher);
  await network.putBlob(indexRoot, indexCipher);
  await network.putIndex(sealLegacy(key, { version: "2.0", root: indexRoot }));
  const view = await log.readCompanion();
  assert.equal(view.reminders.length, 0);
  assert.equal(view.items.length, 0);
  assert.equal(JSON.stringify(view).includes("Kenji"), false);
});

test("a forced proof failure refuses the blob", async () => {
  const network = new InMemoryOg();
  const log = new CipherLog(createStorageKey(), network);
  const utterance = buildUtterance({
    timestamp: 1729864200,
    mode: "live",
    audioDurationSec: 1,
    transcript,
    translation: "Thursday with Kenji",
    memoryOps: [],
    transcribe: transcribeTrace,
    reason: reasonTrace,
  });
  assert.ok(utterance);
  const prepared = await log.prepareUtterance(utterance);
  await log.writeUtterance(prepared.root, prepared.cipher, () => emptyWorkingSet());
  network.damageProof();
  assert.equal(await log.readUtterance(prepared.root), null);
  assert.equal((await log.readCompanion()).reminders.length, 0);

  let proof: boolean | undefined;
  const refused = await downloadWithProof(
    {
      async downloadToBlob(_root, opts) {
        proof = opts.proof;
        return [null, new Error("merkle proof root mismatch")];
      },
    },
    prepared.root,
  );
  assert.equal(proof, true);
  assert.equal(refused, null);
});

function sealLegacy(key: Uint8Array, document: unknown): Uint8Array {
  return seal(key, new TextEncoder().encode(JSON.stringify(document)));
}
