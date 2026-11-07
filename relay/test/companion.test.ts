import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import type { PhoneState, ScreenState } from "../src/protocol.ts";
import { createStorageKey, seal } from "../src/seal.ts";
import { createRelay, type Relay } from "../src/server.ts";
import { CipherLog, InMemoryOg } from "../src/storage.ts";
import type { WorkingSet } from "../src/working-set.ts";

const when = 1729864200;
const spoken = "I'll meet Kenji on Thursday.";
const translation = "Thursday with Kenji";

const stored: WorkingSet = {
  version: "2.0",
  reminders: [{ text: "Meet Kenji Thursday", mentioned_at: when }],
  items: [{ list: "open", text: "Send Kenji 5 USDC", updated_at: when }],
};

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

async function companion(port: number): Promise<WorkingSet> {
  return (await (await fetch(`http://127.0.0.1:${port}/companion`)).json()) as WorkingSet;
}

test("the phone reads the stored index after every socket is closed", async () => {
  const key = createStorageKey();
  const network = new InMemoryOg();
  const log = new CipherLog(key, network);
  await log.writeCompanion(stored);
  const relay = createRelay(undefined, { log });
  const port = await listen(relay);
  try {
    const phone = await openClient(port, "/phone");
    const hello = (await phone.next()) as PhoneState;
    assert.equal(hello.type, "phone");
    assert.equal(JSON.stringify(hello).includes("Kenji"), false);
    assert.equal(hello.live_lines.length, 0);
    await new Promise<void>((resolve) => {
      phone.ws.once("close", () => resolve());
      phone.ws.close();
    });
    assert.equal(relay.session.phoneLinked(), false);

    const opened = await companion(port);
    assert.deepEqual(opened.reminders, stored.reminders);
    assert.deepEqual(opened.items, stored.items);
    assert.equal(JSON.stringify(opened).includes(spoken), false);
    assert.equal(JSON.stringify(opened).includes(Buffer.from(key).toString("hex")), false);

    const badge = await openClient(port, "/ws");
    assert.equal(((await badge.next()) as ScreenState).face, "companion");
    const again = await openClient(port, "/phone");
    assert.equal(((await again.next()) as PhoneState).mode, "companion");
    const liveBadge = badge.next();
    const livePhone = again.next();
    badge.send({ type: "press" });
    assert.equal(((await liveBadge) as ScreenState).face, "live");
    assert.equal(((await livePhone) as PhoneState).mode, "live");

    const lined = again.next();
    assert.equal(relay.session.feedMemory({ live: { transcript: spoken, translation } }).ok, true);
    const frame = (await lined) as PhoneState;
    assert.equal(frame.live_lines[0]?.transcript, spoken);
    assert.equal(frame.live_lines[0]?.translation, translation);
    const view = await relay.session.readCompanion();
    assert.deepEqual(view.reminders, stored.reminders);
    assert.equal(JSON.stringify(view).includes(spoken), false);
    assert.equal(JSON.stringify(await companion(port)).includes(translation), false);

    await new Promise<void>((resolve) => {
      again.ws.once("close", () => resolve());
      again.ws.close();
    });
    const reopened = await openClient(port, "/phone");
    const quiet = (await reopened.next()) as PhoneState;
    assert.equal(quiet.live_lines.length, 0);
    assert.equal(JSON.stringify(quiet).includes(spoken), false);
    assert.deepEqual((await companion(port)).reminders, stored.reminders);

    network.damageProof();
    const damaged = await companion(port);
    assert.deepEqual(damaged.reminders, []);
    assert.deepEqual(damaged.items, []);
  } finally {
    await relay.close();
  }
});

test("a version 1.0 index reads as an empty companion view", async () => {
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
          people: [],
          pins: [],
          recent: [],
        }),
      ),
    ),
  );
  const view = await log.readCompanion();
  assert.equal(view.reminders.length, 0);
  assert.equal(view.items.length, 0);
  assert.equal(JSON.stringify(view).includes("Kenji"), false);
});

test("the phone can dismiss an item and reword a reminder", async () => {
  const key = createStorageKey();
  const network = new InMemoryOg();
  const log = new CipherLog(key, network);
  await log.writeCompanion({
    version: "2.0",
    reminders: [
      { text: "Meet Kenji Thursday", mentioned_at: when, episode_root: "0xmeet" },
      { text: "Call Mum after the appointment", mentioned_at: when + 80 },
    ],
    items: [
      { list: "open", text: "Send Kenji 5 USDC", updated_at: when, episode_root: "0xpay" },
      { list: "todo", text: "Pick up the dry cleaning", updated_at: when + 10 },
      { list: "Errands", text: "Return the library books", updated_at: when + 20 },
    ],
    summary: { text: "Thursday is still open.", points: ["Meet Kenji"], mentioned_at: when },
  });
  const relay = createRelay(undefined, { log });
  await relay.session.loadMemory();
  const beforeGlass = relay.session.screen();
  const port = await listen(relay);
  try {
    const dismissed = await revise(port, { action: "close_item", list: "todo", text: "Pick up the dry cleaning" });
    assert.equal(dismissed.status, 200);
    const afterDismiss = await companion(port);
    assert.deepEqual(afterDismiss.items.map((row) => row.text), ["Send Kenji 5 USDC", "Return the library books"]);
    assert.equal(afterDismiss.summary?.text, "Thursday is still open.");

    const edited = await revise(port, {
      action: "edit_reminder",
      text: "Meet Kenji Thursday",
      next: "Meet Kenji Friday",
    });
    assert.equal(edited.status, 200);
    const afterEdit = await companion(port);
    assert.equal(afterEdit.reminders[0]?.text, "Meet Kenji Friday");
    assert.equal(afterEdit.reminders[0]?.mentioned_at, when);
    assert.equal(afterEdit.reminders[0]?.episode_root, "0xmeet");
    assert.equal(afterEdit.items[0]?.updated_at, when);
    assert.equal(afterEdit.items[0]?.episode_root, "0xpay");

    const blank = await revise(port, { action: "edit_reminder", text: "Meet Kenji Friday", next: "   " });
    assert.equal(blank.status, 409);
    const duplicate = await revise(port, {
      action: "edit_reminder",
      text: "Meet Kenji Friday",
      next: "Call Mum after the appointment",
    });
    assert.equal(duplicate.status, 409);
    const kept = await companion(port);
    assert.equal(kept.reminders[0]?.text, "Meet Kenji Friday");
    assert.equal(kept.reminders[1]?.text, "Call Mum after the appointment");
    assert.deepEqual(relay.session.screen(), beforeGlass);
    assert.equal(JSON.stringify(relay.session.screen()).includes("Friday"), false);
  } finally {
    await relay.close();
  }
});

async function revise(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/companion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
