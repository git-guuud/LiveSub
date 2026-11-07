// Live 0G check. Skipped unless LIVESUB_LIVE=1.
// The mainnet router answers the private chat call. A sealed response omits
// tee_verified, so the product does not treat it as memory and does not lock.
// This test still checks the todos and the summary, then uploads that draft
// under the KV key livesub.secondary-test. The companion key is left alone.
// There is no microphone here, so nothing claims a transcription trace.

import assert from "node:assert/strict";
import test from "node:test";
import { preferReachableAddress } from "../src/net.ts";
import {
  createChatModelMemory,
  locksReason,
  readReasonOutput,
  REASON_URL,
  reasonUtterance,
  type ReasonResult,
} from "../src/reason.ts";
import { createStorageKey, open } from "../src/seal.ts";
import { CipherLog } from "../src/storage.ts";
import { applyMemoryOps, applySummary, emptyWorkingSet, type WorkingSet } from "../src/working-set.ts";
import { galileoTransport, storageEndpoints, ZeroGNetwork } from "../src/zerog.ts";

const live = process.env.LIVESUB_LIVE === "1";
const spoken =
  "Remind me to meet Kenji on Thursday. I still owe him 5 USDC. Pick up the dry cleaning and email the landlord about the leak.";
const done = "I sent Kenji the 5 USDC and I picked up the dry cleaning.";

function redact(value: unknown): string {
  let text = value instanceof Error ? value.message : JSON.stringify(value);
  for (const secret of [process.env.OG_API_KEY, process.env.OG_STORAGE_PRIVATE_KEY]) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text;
}

function joined(index: WorkingSet): string {
  return [
    ...index.reminders.map((row) => row.text),
    ...index.items.map((row) => `${row.list} ${row.text}`),
    index.summary?.text ?? "",
    ...(index.summary?.points ?? []),
  ].join("\n");
}

async function ask(
  transcript: string,
  index: WorkingSet,
  when: number,
  record: ReturnType<typeof createChatModelMemory>,
): Promise<{ result: ReasonResult; index: WorkingSet }> {
  let body: unknown = null;
  const result = await reasonUtterance(transcript, {
    apiKey: process.env.OG_API_KEY,
    timestamp: when,
    mode: "companion",
    index,
    record,
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url) === REASON_URL) body = await response.clone().json();
      return response;
    },
  });
  if (result.ok) return { result, index: applySummary(applyMemoryOps(index, result.memory_ops, when), result.summary, when) };
  const output = readReasonOutput(body);
  assert.ok(output, redact(result));
  return {
    result,
    index: applySummary(applyMemoryOps(index, output.memory_ops, when), output.summary, when),
  };
}

test(
  "private reason writes todos and a summary, then the sealed index uploads",
  { skip: live ? false : "set LIVESUB_LIVE=1 to call 0G", timeout: 300_000 },
  async () => {
    const privateKey = process.env.OG_STORAGE_PRIVATE_KEY;
    const streamId = process.env.OG_KV_STREAM_ID;
    const kvNodeUrl = process.env.OG_KV_NODE;
    assert.ok(process.env.OG_API_KEY, "OG_API_KEY is set");
    assert.ok(privateKey && streamId && kvNodeUrl, "storage env is set");
    preferReachableAddress();

    const when = 1_729_864_200;
    const record = createChatModelMemory();
    const first = await ask(spoken, emptyWorkingSet(), when, record);
    assert.equal(locksReason(first.result), false, redact(first.result));
    const opened = joined(first.index);
    assert.match(opened, /kenji/i, opened);
    assert.match(opened, /thursday/i, opened);
    assert.equal(first.index.items.some((item) => item.list === "open" && /usdc/i.test(item.text)), true, opened);
    assert.equal(first.index.items.some((item) => item.list === "todo" && /dry cleaning/i.test(item.text)), true, opened);
    assert.equal(
      first.index.items.some((item) => item.list === "todo" && /landlord|leak/i.test(item.text)),
      true,
      opened,
    );
    assert.ok((first.index.summary?.points.length ?? 0) >= 3, opened);

    const second = await ask(done, first.index, when + 3600, record);
    assert.equal(locksReason(second.result), false, redact(second.result));
    const after = joined(second.index);
    assert.match(after, /kenji/i, after);
    assert.match(after, /thursday/i, after);
    assert.equal(second.index.reminders[0]?.mentioned_at, when, after);
    assert.equal(second.index.items.some((item) => /usdc/i.test(item.text)), false, after);
    assert.equal(second.index.items.some((item) => /dry cleaning/i.test(item.text)), false, after);
    assert.equal(second.index.items.some((item) => item.list === "todo" && /landlord|leak/i.test(item.text)), true, after);
    assert.match(second.index.summary?.text ?? "", /dry cleaning|usdc/i, after);

    const key = createStorageKey();
    const roots: string[] = [];
    const inner = new ZeroGNetwork(
      galileoTransport({
        privateKey,
        streamId,
        kvNodeUrl,
        indexKey: "livesub.secondary-test",
        ...storageEndpoints(process.env.OG_STORAGE_NETWORK),
      }),
    );
    const network = {
      merkleRoot: (bytes: Uint8Array) => inner.merkleRoot(bytes),
      putBlob: async (root: string, bytes: Uint8Array) => {
        roots.push(root);
        await inner.putBlob(root, bytes);
      },
      getBlob: (root: string) => inner.getBlob(root),
      putIndex: (bytes: Uint8Array) => inner.putIndex(bytes),
      getIndex: () => inner.getIndex(),
    };
    const log = new CipherLog(key, network);
    await log.writeCompanion(second.index);
    const root = roots[0] ?? "";
    assert.match(root, /^0x[0-9a-f]{64}$/);
    const cipher = await network.getBlob(root);
    assert.ok(cipher, "proof-checked download returned no bytes");
    const stored = JSON.parse(new TextDecoder().decode(open(key, cipher))) as {
      lists?: Array<{ text?: string }>;
      reminders?: Array<{ text?: string; mentioned_at?: number }>;
      summary?: { points?: string[] };
    };
    assert.equal(stored.reminders?.[0]?.mentioned_at, when);
    assert.match(stored.reminders?.[0]?.text ?? "", /kenji/i);
    assert.equal(stored.lists?.some((item) => /usdc/i.test(item.text ?? "")), false);
    assert.equal(stored.lists?.some((item) => /landlord|leak/i.test(item.text ?? "")), true);
    assert.deepEqual(stored.summary?.points, second.index.summary?.points);

    const started = Date.now();
    let pointerBytes: Uint8Array | null = null;
    while (Date.now() - started < 20_000) {
      pointerBytes = await network.getIndex();
      if (pointerBytes && pointerBytes.byteLength > 0) break;
      pointerBytes = null;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const plain = new TextEncoder().encode(spoken);
    let found = false;
    for (let i = 0; i <= cipher.byteLength - plain.byteLength; i += 1) {
      let same = true;
      for (let j = 0; j < plain.byteLength; j += 1) {
        if (cipher[i + j] !== plain[j]) {
          same = false;
          break;
        }
      }
      if (same) found = true;
    }
    assert.equal(found, false);
    let keyFound = false;
    for (let i = 0; i <= cipher.byteLength - key.byteLength; i += 1) {
      let same = true;
      for (let j = 0; j < key.byteLength; j += 1) {
        if (cipher[i + j] !== key[j]) {
          same = false;
          break;
        }
      }
      if (same) keyFound = true;
    }
    assert.equal(keyFound, false);
    let kv = "reader_behind";
    if (pointerBytes) {
      const pointer = JSON.parse(new TextDecoder().decode(open(key, pointerBytes))) as { root?: string };
      assert.equal(pointer.root, root);
      kv = "read";
    }
    const claim = second.result.ok ? "tee_verified" : second.result.reason;
    console.log(
      JSON.stringify({
        claim,
        model: record.model?.id ?? null,
        network: process.env.OG_STORAGE_NETWORK ?? "galileo",
        root,
        kv,
      }),
    );
  },
);
