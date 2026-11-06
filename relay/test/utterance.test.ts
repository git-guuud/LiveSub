import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import type { PhoneState, ScreenState } from "../src/protocol.ts";
import { REASON_URL, type ReasonTrace } from "../src/reason.ts";
import { createStorageKey, open } from "../src/seal.ts";
import { createRelay, type Relay } from "../src/server.ts";
import { Session } from "../src/session.ts";
import { CipherLog, InMemoryOg, type OgNetwork } from "../src/storage.ts";
import { TRANSCRIBE_URL, TRUST_MODE, TRUST_MODE_HEADER, type TranscribeTrace } from "../src/transcribe.ts";
import { emptyWorkingSet } from "../src/working-set.ts";

const spoken = "I'll meet Kenji on Thursday. I still owe him 5 USDC.";
const translation = "Thursday with Kenji";
const when = 1729864200;

const transcribeTrace: TranscribeTrace = {
  step: "transcribe",
  model: "whisper-large-v3",
  request_id: "req-t",
  provider: "0xprovider",
  tee_verified: true,
};

const reasonTrace: ReasonTrace = {
  step: "reason",
  model: "fixture-private-chat",
  request_id: "req-reason",
  provider: "0xprovider",
  tee_verified: true,
};

class HoldOg implements OgNetwork {
  readonly inner = new InMemoryOg();
  readonly roots: string[] = [];
  #release: (() => void) | null = null;
  #gate: Promise<void>;
  #markEntered: (() => void) | null = null;
  entered: Promise<void>;

  constructor() {
    this.#gate = new Promise((resolve) => {
      this.#release = resolve;
    });
    this.entered = new Promise((resolve) => {
      this.#markEntered = resolve;
    });
  }

  release(): void {
    this.#release?.();
    this.#release = null;
  }

  merkleRoot(bytes: Uint8Array): Promise<string> {
    return this.inner.merkleRoot(bytes);
  }

  async putBlob(root: string, bytes: Uint8Array): Promise<void> {
    this.roots.push(root);
    this.#markEntered?.();
    this.#markEntered = null;
    await this.#gate;
    await this.inner.putBlob(root, bytes);
  }

  getBlob(root: string): Promise<Uint8Array | null> {
    return this.inner.getBlob(root);
  }

  async putIndex(bytes: Uint8Array): Promise<void> {
    await this.#gate;
    await this.inner.putIndex(bytes);
  }

  getIndex(): Promise<Uint8Array | null> {
    return this.inner.getIndex();
  }
}

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

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
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

function openClient(port: number, pathname: string): Promise<SocketClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`);
  const client = new SocketClient(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(client));
    ws.once("error", reject);
  });
}

async function companion(port: number): Promise<{ reminders: Array<{ text: string }>; items: unknown[] }> {
  return (await (await fetch(`http://127.0.0.1:${port}/companion`)).json()) as {
    reminders: Array<{ text: string }>;
    items: unknown[];
  };
}

function within(promise: Promise<unknown>, ms: number): Promise<unknown | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

test("a live line is committed before the storage write, and a restart keeps open items only", async () => {
  const key = createStorageKey();
  const network = new HoldOg();
  const log = new CipherLog(key, network);
  const clip = new Uint8Array(320);
  const relay = createRelay(undefined, {
    apiKey: "sk-test",
    chatModel: "fixture-private-chat",
    log,
    fetchImpl: fetchMock(spoken, translation, [
      { op: "add_reminder", text: "Meet Kenji Thursday" },
      { op: "add_item", list: "open", text: "Send Kenji 5 USDC" },
    ]),
  });
  const port = await listen(relay);
  let openedAt = 0;
  let openedRoot = "";
  try {
    const badge = await openClient(port, "/ws");
    assert.equal(((await badge.next()) as ScreenState).face, "companion");
    const phone = await openClient(port, "/phone");
    assert.equal(((await phone.next()) as PhoneState).mode, "companion");
    const liveBadge = badge.next();
    const livePhone = phone.next();
    badge.send({ type: "press" });
    assert.equal(((await liveBadge) as ScreenState).face, "live");
    assert.equal(((await livePhone) as PhoneState).mode, "live");

    const lined = phone.next();
    badge.ws.send(clip);
    let frame = (await within(lined, 1000)) as PhoneState | null;
    if (frame && !frame.live_lines[0]?.translation) frame = (await within(phone.next(), 1000)) as PhoneState | null;
    assert.ok(frame, "live line waited on the storage write");
    assert.equal(frame.live_lines[0]?.transcript, spoken);
    assert.equal(frame.live_lines[0]?.translation, translation);
    assert.equal(JSON.stringify(relay.session.screen()).includes(spoken), false);
    assert.equal(await within(network.entered, 1000), undefined);
    const early = await companion(port);
    assert.deepEqual(early.reminders, []);
    assert.deepEqual(early.items, []);
    assert.equal(relay.session.reminders()[0]?.text, "Meet Kenji Thursday");
    assert.equal(relay.session.items()[0]?.text, "Send Kenji 5 USDC");
    const root = relay.session.reminders()[0]?.episode_root;
    assert.equal(typeof root, "string");

    network.release();
    await relay.session.storageSettled();
    const view = await companion(port);
    assert.deepEqual(
      view.reminders.map((row) => row.text),
      ["Meet Kenji Thursday"],
    );
    assert.equal((view.items[0] as { text: string }).text, "Send Kenji 5 USDC");
    assert.equal(JSON.stringify(view).includes(spoken), false);
    assert.equal(JSON.stringify(view).includes(translation), false);

    const remembered = relay.session.reminders().map((row) => ({ ...row }));
    const openItems = relay.session.items().map((row) => ({ ...row }));
    assert.equal(remembered[0]?.episode_root, root);
    assert.equal(openItems[0]?.episode_root, root);
    openedAt = remembered[0]?.mentioned_at ?? 0;
    openedRoot = remembered[0]?.episode_root ?? "";
    relay.session.loadWorkingSet({
      version: "2.0",
      reminders: [{ text: "Not stored", mentioned_at: 1 }],
      items: [],
    });
    const readBack = await companion(port);
    assert.equal(JSON.stringify(readBack).includes("Not stored"), false);
    assert.equal(readBack.reminders[0]?.text, "Meet Kenji Thursday");

    const pointerBytes = await network.getIndex();
    assert.ok(pointerBytes);
    const pointer = JSON.parse(new TextDecoder().decode(open(key, pointerBytes))) as { root?: string };
    const indexCipher = await network.getBlob(pointer.root ?? "");
    assert.ok(indexCipher);
    const document = JSON.parse(new TextDecoder().decode(open(key, indexCipher))) as {
      lists?: Array<{ text?: string; episode_root?: string }>;
      items?: unknown;
    };
    assert.equal(document.lists?.[0]?.text, "Send Kenji 5 USDC");
    assert.equal(document.lists?.[0]?.episode_root, root);
    assert.equal(document.items, undefined);
    const utterance = await log.readUtterance(network.roots[0] ?? "");
    assert.equal(utterance?.mode, "live");
    assert.equal(utterance?.audio_duration_sec, 0.01);
    assert.equal(utterance?.transcript, spoken);
    assert.equal(Object.hasOwn(utterance ?? {}, "audio"), false);
  } finally {
    network.release();
    await relay.close();
  }

  const restarted = new Session();
  restarted.setStore(log);
  await restarted.loadMemory();
  assert.equal(restarted.reminders()[0]?.text, "Meet Kenji Thursday");
  assert.equal(restarted.reminders()[0]?.mentioned_at, openedAt);
  assert.equal(restarted.reminders()[0]?.episode_root, openedRoot);
  assert.equal(restarted.items()[0]?.text, "Send Kenji 5 USDC");
  assert.equal(restarted.phone().live_lines.length, 0);

  restarted.setRelayLinked(true);
  assert.equal(restarted.acceptChunk(new Uint8Array(320)).ok, true);
  assert.equal(
    restarted.acceptTranscribe({ ok: true, text: "I sent Kenji the 5 USDC.", trace: transcribeTrace }).ok,
    true,
  );
  assert.equal(
    restarted.acceptReason(
      {
        ok: true,
        memory_ops: [{ op: "close_item", text: "Send Kenji 5 USDC" }],
        transcript: "I sent Kenji the 5 USDC.",
        translation: "",
        trace: { ...reasonTrace, request_id: "req-paid" },
      },
      when + 3600,
      { mode: "companion", audioDurationSec: 0.01 },
    ).ok,
    true,
  );
  await restarted.storageSettled();

  const again = new Session();
  again.setStore(log);
  await again.loadMemory();
  assert.equal(again.reminders()[0]?.text, "Meet Kenji Thursday");
  assert.equal(again.reminders()[0]?.mentioned_at, openedAt);
  assert.equal(again.reminders()[0]?.episode_root, openedRoot);
  assert.equal(again.items().length, 0);
  let closedOp = "";
  for (const root of network.roots) {
    const row = await log.readUtterance(root);
    const op = row?.memory_ops.find((item) => item.op === "close_item");
    if (op) closedOp = op.op;
  }
  assert.equal(closedOp, "close_item");
  assert.equal(JSON.stringify(await log.readCompanion()).includes("5 USDC"), false);
});

test("an absent index still translates in live and leaves the lists empty", async () => {
  const log = new CipherLog(createStorageKey(), new InMemoryOg());
  const session = new Session();
  session.setStore(log);
  await session.loadMemory();
  session.setRelayLinked(true);
  session.setPhoneLinked(true);
  assert.equal(session.handle({ type: "press" }).ok, true);
  assert.equal(session.acceptChunk(new Uint8Array(320)).ok, true);
  assert.equal(session.acceptTranscribe({ ok: true, text: "Good morning.", trace: transcribeTrace }).ok, true);
  assert.equal(
    session.acceptReason(
      {
        ok: true,
        memory_ops: [],
        transcript: "Good morning.",
        translation: "Good morning.",
        trace: reasonTrace,
      },
      when,
      { mode: "live", audioDurationSec: 0.01 },
    ).ok,
    true,
  );
  assert.equal(session.phone().live_lines[0]?.translation, "Good morning.");
  assert.equal(session.items().length, 0);
  assert.equal(session.reminders().length, 0);
  await session.storageSettled();
  assert.deepEqual(await session.readCompanion(), emptyWorkingSet());
  const restarted = new Session();
  restarted.setStore(log);
  await restarted.loadMemory();
  assert.deepEqual(restarted.reminders(), []);
  assert.deepEqual(restarted.items(), []);
  assert.equal(restarted.phone().live_lines.length, 0);
});

test("a failed trace writes nothing and leaves the index unchanged", async () => {
  let puts = 0;
  const network = new InMemoryOg();
  const counting: OgNetwork = {
    merkleRoot: (bytes) => network.merkleRoot(bytes),
    async putBlob(root, bytes) {
      puts += 1;
      await network.putBlob(root, bytes);
    },
    getBlob: (root) => network.getBlob(root),
    async putIndex(bytes) {
      puts += 1;
      await network.putIndex(bytes);
    },
    getIndex: () => network.getIndex(),
  };
  const log = new CipherLog(createStorageKey(), counting);
  const session = new Session();
  session.setStore(log);
  session.setRelayLinked(true);
  session.setPhoneLinked(true);
  assert.equal(session.handle({ type: "press" }).ok, true);
  assert.equal(session.acceptChunk(Uint8Array.from([1, 2, 3, 4])).ok, true);
  assert.equal(session.acceptTranscribe({ ok: true, text: spoken, trace: transcribeTrace }).ok, true);
  assert.equal(session.acceptReason({ ok: false, reason: "tee_unverified", status: 200 }, when).ok, false);
  await session.storageSettled();
  assert.equal(puts, 0);
  assert.equal(session.reminders().length, 0);
  assert.equal(session.phone().live_lines.length, 0);
  assert.equal(session.screen().face, "locked");
  assert.deepEqual(await log.readCompanion(), emptyWorkingSet());
});

function fetchMock(
  transcript: string,
  line: string,
  memoryOps: Array<{ op: string; text: string; list?: string }>,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.headers.get(TRUST_MODE_HEADER), TRUST_MODE);
    if (request.url.startsWith(TRANSCRIBE_URL)) {
      return new Response(
        JSON.stringify({
          text: transcript,
          x_0g_trace: { request_id: "req-t", provider: "0xprovider", tee_verified: true },
        }),
        { status: 200 },
      );
    }
    assert.equal(request.url, REASON_URL);
    const body = (await request.json()) as { verify_tee?: unknown; messages?: Array<{ content?: string }> };
    assert.equal(body.verify_tee, true);
    assert.match(body.messages?.[1]?.content ?? "", /mode: live/);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                memory_ops: memoryOps,
                transcript,
                translation: line,
              }),
            },
          },
        ],
        x_0g_trace: { request_id: "req-reason", provider: "0xprovider", tee_verified: true },
      }),
      { status: 200 },
    );
  };
}
