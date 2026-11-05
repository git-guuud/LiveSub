import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import { parseHTML } from "linkedom";
import type { ScreenState } from "../src/protocol.ts";
import type { ReasonResult } from "../src/reason.ts";
import { createRelay, type Relay } from "../src/server.ts";
import { createStorageKey, seal } from "../src/seal.ts";
import { Session } from "../src/session.ts";
import { CipherLog, InMemoryOg } from "../src/storage.ts";
import { TRANSCRIBE_URL, TRUST_MODE, TRUST_MODE_HEADER } from "../src/transcribe.ts";
import { REASON_URL } from "../src/reason.ts";
import { applyMemoryOps, emptyWorkingSet, stampEpisodeRoots } from "../src/working-set.ts";
import { renderGlass } from "../public/screen.js";
import { renderCompanion, renderPhone } from "../public/phone.js";

const spoken = "I'll meet Kenji on Thursday. I still owe him 5 USDC.";
const when = 1729864200;
const week = when + 8 * 24 * 60 * 60;

function reason(
  ops: ReasonResult extends { ok: true } ? Extract<ReasonResult, { ok: true }>["memory_ops"] : never,
  transcript: string,
  translation = "",
  requestId = "req-reason",
): Extract<ReasonResult, { ok: true }> {
  return {
    ok: true,
    memory_ops: ops,
    transcript,
    translation,
    trace: {
      step: "reason",
      model: "fixture-private-chat",
      request_id: requestId,
      provider: "0xprovider",
      tee_verified: true,
    },
  };
}

const kenji = reason(
  [
    { op: "add_reminder", text: "Meet Kenji Thursday" },
    { op: "add_item", list: "open", text: "Send Kenji 5 USDC" },
  ],
  spoken,
);

test("the Kenji sentence is stamped, the money closes, and a restart keeps the reminder", () => {
  const session = new Session();
  session.setRelayLinked(true);
  assert.equal(session.acceptChunk(Uint8Array.from([1, 2, 3])).ok, true);
  assert.equal(session.phoneLinked(), false);
  const source = emptyWorkingSet();
  assert.equal(session.acceptReason(kenji, when).ok, true);
  assert.deepEqual(applyMemoryOps(source, kenji.memory_ops, when).reminders, session.reminders());
  assert.equal(source.reminders.length, 0);
  assert.deepEqual(session.reminders(), [{ text: "Meet Kenji Thursday", mentioned_at: when }]);
  assert.deepEqual(session.items(), [{ list: "open", text: "Send Kenji 5 USDC", updated_at: when }]);
  assert.equal(session.phone().live_lines.length, 0);
  assert.equal(session.screen().face, "companion");
  assert.equal(JSON.stringify(session.screen()).includes("Kenji"), false);
  assert.equal(JSON.stringify(session.screen()).includes(spoken), false);

  assert.equal(session.acceptReason(kenji, when + 100).ok, true);
  assert.equal(session.reminders()[0]?.mentioned_at, when);
  assert.equal(session.items()[0]?.updated_at, when);

  const paid = reason([{ op: "close_item", text: "Send Kenji 5 USDC" }], "I sent Kenji the 5 USDC.", "", "req-paid");
  assert.equal(session.acceptReason(paid, when + 3600).ok, true);
  assert.equal(session.items().length, 0);
  assert.deepEqual(session.reminders(), [{ text: "Meet Kenji Thursday", mentioned_at: when }]);

  const neither = reason([], "The weather is clear.", "", "req-week");
  assert.equal(session.acceptReason(neither, week).ok, true);
  assert.deepEqual(session.reminders(), [{ text: "Meet Kenji Thursday", mentioned_at: when }]);

  const restarted = new Session();
  restarted.loadWorkingSet(session.workingSet());
  restarted.setRelayLinked(true);
  restarted.setPhoneLinked(true);
  assert.deepEqual(restarted.reminders(), [{ text: "Meet Kenji Thursday", mentioned_at: when }]);
  assert.equal(restarted.items().length, 0);
  assert.equal(restarted.phone().live_lines.length, 0);
  assert.equal(restarted.reminders()[0]?.mentioned_at, when);
});

test("a duplicate add keeps the original episode root", () => {
  const index = applyMemoryOps(emptyWorkingSet(), kenji.memory_ops, when);
  stampEpisodeRoots(index, kenji.memory_ops, when, "0xaaa");
  const again = applyMemoryOps(index, kenji.memory_ops, when + 100);
  stampEpisodeRoots(again, kenji.memory_ops, when + 100, "0xbbb");
  assert.equal(again.reminders[0]?.episode_root, "0xaaa");
  assert.equal(again.reminders[0]?.mentioned_at, when);
  assert.equal(again.items[0]?.episode_root, "0xaaa");
});

test("a version 1.0 index leaves the phone with no items", async () => {
  const key = createStorageKey();
  const network = new InMemoryOg();
  const log = new CipherLog(key, network);
  await network.putIndex(
    seal(
      key,
      new TextEncoder().encode(
        JSON.stringify({
          version: "1.0",
          open_loops: [{ text: "Send Kenji 5 USDC", who: "Kenji", episode_root: "0xkenji" }],
          people: [{ who: "Kenji", episode_root: "0xkenji" }],
          pins: ["0xkenji"],
          recent: [],
        }),
      ),
    ),
  );
  const session = new Session();
  session.setStore(log);
  await session.loadMemory();
  session.setPhoneLinked(true);
  assert.equal(session.reminders().length, 0);
  assert.equal(session.items().length, 0);
  assert.equal(JSON.stringify(session.phone()).includes("Kenji"), false);

  const { document: doc } = parseHTML(`<!doctype html><main class="phone">
    <p id="reminders-empty"></p><ol id="reminders"></ol>
    <p id="items-empty"></p><ol id="items"></ol>
    <section id="live-section"><p id="live-empty"></p><ol id="live"></ol></section>
    <p id="traces-empty"></p><ol id="traces"></ol>
    <p id="link-status"></p>
  </main>`);
  globalThis.document = doc;
  const root = doc.querySelector("main.phone");
  assert.ok(root);
  renderCompanion(root, { reminders: session.reminders(), items: session.items() });
  renderPhone(root, session.phone());
  assert.equal(root.querySelector("#reminders")?.childElementCount, 0);
  assert.equal(root.querySelector("#items")?.childElementCount, 0);
  assert.equal(root.querySelector("#live-section")?.hasAttribute("hidden"), true);
});

test("live lines are emitted only while the phone page is linked", () => {
  const away = new Session();
  away.setRelayLinked(true);
  assert.equal(away.acceptReason(kenji, when).ok, true);
  assert.equal(away.phone().live_lines.length, 0);
  assert.equal(away.reminders().length, 1);

  const session = new Session();
  session.setRelayLinked(true);
  session.setPhoneLinked(true);
  assert.equal(session.handle({ type: "press" }).ok, true);
  assert.equal(session.mode(), "live");
  const line = reason(kenji.memory_ops, spoken, "Thursday with Kenji");
  assert.equal(session.acceptReason(line, when).ok, true);
  assert.equal(session.phone().live_lines[0]?.transcript, spoken);
  assert.equal(session.phone().live_lines[0]?.translation, "Thursday with Kenji");
  assert.equal(session.screen().face, "live");
  assert.equal(JSON.stringify(session.screen()).includes(spoken), false);

  const { document: doc } = parseHTML("<!doctype html><div id='glass'></div>");
  globalThis.document = doc;
  const glass = doc.querySelector("#glass");
  assert.ok(glass);
  renderGlass(glass, session.screen());
  assert.equal(glass.textContent, "Live");
  assert.equal((glass.textContent ?? "").includes("Kenji"), false);

  session.setPhoneLinked(false);
  assert.equal(session.mode(), "companion");
  assert.equal(session.phone().live_lines.length, 0);
  assert.equal(session.reminders()[0]?.mentioned_at, when);
  assert.equal(session.items().length, 1);
});

test("an unverified reason locks, paints nothing, and leaves the index unchanged", () => {
  const session = new Session();
  session.setRelayLinked(true);
  session.setPhoneLinked(true);
  assert.equal(session.handle({ type: "press" }).ok, true);
  assert.equal(session.acceptReason(kenji, when).ok, true);
  const before = session.workingSet();
  assert.equal(session.phone().live_lines.length, 1);

  for (const failure of ["tee_unverified", "missing_trace", "http_503", "http_502"] as const) {
    const attempt = new Session();
    attempt.setRelayLinked(true);
    attempt.loadWorkingSet(before);
    attempt.setPhoneLinked(true);
    assert.equal(attempt.handle({ type: "press" }).ok, true);
    const status = failure === "http_502" ? 502 : failure === "http_503" ? 503 : 200;
    assert.equal(attempt.acceptReason({ ok: false, reason: failure, status }, when + 10).ok, false);
    assert.equal(attempt.screen().face, "locked");
    assert.equal(attempt.screen().mic_power, false);
    assert.deepEqual(attempt.workingSet(), before);
    assert.equal(attempt.phone().live_lines.length, 0);
    assert.equal(JSON.stringify(attempt.screen()).includes(spoken), false);
    assert.equal(JSON.stringify(attempt.phone()).includes("I sent Kenji"), false);
  }

  assert.equal(session.acceptReason({ ok: false, reason: "bad_output", status: 200 }, when + 10).ok, false);
  assert.equal(session.screen().face, "live");
  assert.deepEqual(session.workingSet(), before);

  session.lock();
  assert.equal(session.acceptReason(kenji, when + 20).ok, false);
  assert.deepEqual(session.workingSet(), before);
  assert.equal(session.phone().live_lines.length, 0);

  const { document: doc } = parseHTML("<!doctype html><div id='glass'></div>");
  globalThis.document = doc;
  const glass = doc.querySelector("#glass");
  assert.ok(glass);
  renderGlass(glass, session.screen());
  assert.equal(glass.textContent, "MIC LOCKED: ENCLAVE OFFLINE");
  assert.equal((glass.textContent ?? "").includes("Kenji"), false);
});

test("a failed transcription locks and paints nothing", () => {
  const session = new Session();
  session.setRelayLinked(true);
  assert.equal(session.acceptChunk(Uint8Array.from([1])).ok, true);
  session.acceptTranscribe({ ok: false, reason: "tee_unverified", status: 200 });
  assert.equal(session.screen().face, "locked");
  assert.equal(session.screen().mic_power, false);
  assert.equal(session.reminders().length, 0);
  assert.equal(JSON.stringify(session.screen()).includes(spoken), false);
  assert.equal(session.acceptReason(kenji, when).ok, false);
  assert.equal(session.reminders().length, 0);
});

class SocketClient {
  ws: WebSocket;
  queue: unknown[] = [];
  waiters: Array<(message: unknown) => void> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const message = JSON.parse(text(data));
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  next(): Promise<unknown> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

function text(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

async function listen(relay: Relay): Promise<number> {
  await new Promise<void>((resolve) => {
    relay.server.listen(0, "127.0.0.1", () => resolve());
  });
  return (relay.server.address() as AddressInfo).port;
}

test("a phone-closed clip applies the Kenji memory inside the process", async () => {
  const calls: string[] = [];
  const relay = createRelay(undefined, {
    apiKey: "sk-test",
    chatModel: "fixture-private-chat",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request.url);
      assert.equal(request.headers.get(TRUST_MODE_HEADER), TRUST_MODE);
      assert.equal([...request.headers.values()].includes("standard"), false);
      if (request.url.startsWith(TRANSCRIBE_URL)) {
        assert.equal(new URL(request.url).searchParams.get("verify_tee"), "true");
        return new Response(
          JSON.stringify({
            text: spoken,
            x_0g_trace: { request_id: "req-t", provider: "0xprovider", tee_verified: true },
          }),
          { status: 200 },
        );
      }
      assert.equal(request.url, REASON_URL);
      const body = (await request.json()) as { verify_tee?: unknown; messages?: Array<{ content?: string }> };
      assert.equal(body.verify_tee, true);
      const user = body.messages?.[1]?.content ?? "";
      assert.match(user, /mode: companion/);
      assert.match(user, /reminders:\n\(none\)/);
      assert.match(user, new RegExp(spoken.replace(/[.]/g, "\\.")));
      assert.equal(user.includes("standard"), false);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memory_ops: kenji.memory_ops,
                  transcript: spoken,
                  translation: "",
                }),
              },
            },
          ],
          x_0g_trace: { request_id: "req-reason", provider: "0xprovider", tee_verified: true },
        }),
        { status: 200 },
      );
    },
  });
  const port = await listen(relay);
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const badge = new SocketClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const hello = (await badge.next()) as ScreenState;
    assert.equal(hello.face, "companion");
    badge.ws.send(Buffer.from([9, 8, 7]));
    for (let i = 0; i < 40 && relay.session.reminders().length === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(relay.session.phoneLinked(), false);
    assert.deepEqual(
      relay.session.reminders().map((row) => row.text),
      ["Meet Kenji Thursday"],
    );
    assert.equal(relay.session.items()[0]?.text, "Send Kenji 5 USDC");
    assert.equal(relay.session.phone().live_lines.length, 0);
    assert.equal(relay.session.screen().face, "companion");
    assert.equal(JSON.stringify(relay.session.screen()).includes("Kenji"), false);
    assert.equal(relay.session.retainedAudioBytes(), 0);
    assert.deepEqual(calls.map((url) => (url.startsWith(TRANSCRIBE_URL) ? "transcribe" : "reason")), [
      "transcribe",
      "reason",
    ]);
  } finally {
    await relay.close();
  }
});
