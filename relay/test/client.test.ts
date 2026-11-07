import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { WebSocket, type RawData } from "ws";
import { LOCK_TEXT, faceLabel, parseClientEvent, type PhoneState, type ScreenState } from "../src/protocol.ts";
import { createRelay, type Relay } from "../src/server.ts";
import { FACE_LABEL, LOCK_TEXT as GLASS_LOCK, renderGlass } from "../public/screen.js";

const reminder = "Meet Kenji Thursday";

class Client {
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

function openClient(port: number, pathname: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`);
  const client = new Client(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(client));
    ws.once("error", reject);
  });
}

function asScreen(message: unknown): ScreenState {
  assert.equal((message as ScreenState).type, "screen");
  return message as ScreenState;
}

function asPhone(message: unknown): PhoneState {
  assert.equal((message as PhoneState).type, "phone");
  return message as PhoneState;
}

test("parseClientEvent accepts a short press", () => {
  assert.deepEqual(parseClientEvent(JSON.stringify({ type: "press" })), { type: "press" });
  assert.deepEqual(parseClientEvent("nope"), { error: "bad_message" });
  assert.deepEqual(parseClientEvent(JSON.stringify({ type: "flip" })), { error: "bad_message" });
  assert.equal(LOCK_TEXT, GLASS_LOCK);
  assert.equal(faceLabel("companion"), FACE_LABEL.companion);
  assert.equal(faceLabel("live"), FACE_LABEL.live);
  assert.equal(faceLabel("not_linked"), FACE_LABEL.not_linked);
  assert.equal(faceLabel("locked"), FACE_LABEL.locked);
});

test("a test client drives every badge state and the phone", async () => {
  let calls = 0;
  const relay = createRelay(undefined, {
    fetchImpl: async () => {
      calls += 1;
      return new Response("offline", { status: 503 });
    },
  });
  const port = await listen(relay);
  try {
    const badge = await openClient(port, "/ws");
    const other = await openClient(port, "/ws");
    const hello = asScreen(await badge.next());
    assert.equal(hello.face, "companion");
    assert.equal(hello.mic_power, true);
    assert.equal(JSON.stringify(hello).includes(reminder), false);
    assert.equal(asScreen(await other.next()).face, "companion");

    const refused = badge.next();
    badge.send({ type: "press" });
    assert.deepEqual(await refused, { type: "reject", reason: "phone_closed" });
    assert.equal(relay.session.screen().face, "companion");
    assert.equal(relay.session.mode(), "companion");

    badge.ws.send(Buffer.from([4, 5, 6]));
    const stillClosed = badge.next();
    badge.send({ type: "press" });
    assert.deepEqual(await stillClosed, { type: "reject", reason: "phone_closed" });
    assert.equal(relay.session.retainedAudioBytes(), 3);
    assert.equal(relay.session.phoneLinked(), false);
    assert.equal(
      relay.session.feedMemory({
        reminders: [{ text: reminder, mentioned_at: 1729864200 }],
        items: [{ list: "open", text: "Send Kenji 5 USDC", updated_at: 1729864200 }],
        live: { transcript: "I'll meet Kenji on Thursday.", translation: "Thursday" },
      }).ok,
      true,
    );
    assert.equal(relay.session.reminders()[0]?.text, reminder);
    assert.equal(relay.session.items()[0]?.text, "Send Kenji 5 USDC");
    assert.equal(relay.session.phone().live_lines.length, 0);
    assert.equal(calls, 0);

    const phone = await openClient(port, "/phone");
    const opened = asPhone(await phone.next());
    assert.equal(opened.mode, "companion");
    assert.equal(JSON.stringify(opened).includes(reminder), false);
    assert.equal(JSON.stringify(opened).includes("Send Kenji 5 USDC"), false);
    assert.deepEqual(opened.live_lines, []);

    const liveBadge = badge.next();
    const liveOther = other.next();
    const livePhone = phone.next();
    badge.send({ type: "press" });
    assert.equal(asScreen(await liveBadge).face, "live");
    assert.equal(asScreen(await liveOther).face, "live");
    assert.equal(asPhone(await livePhone).mode, "live");
    assert.equal(JSON.stringify(relay.session.screen()).includes("Thursday"), false);

    const lined = phone.next();
    assert.equal(
      relay.session.feedMemory({
        live: { transcript: "I'll meet Kenji on Thursday.", translation: "Thursday with Kenji" },
      }).ok,
      true,
    );
    const withLine = asPhone(await lined);
    assert.equal(withLine.live_lines[0]?.translation, "Thursday with Kenji");
    assert.equal(JSON.stringify(withLine).includes(reminder), false);
    assert.equal(asScreen(relay.session.screen()).face, "live");

    const back = badge.next();
    const otherBack = other.next();
    await new Promise<void>((resolve) => {
      phone.ws.once("close", () => resolve());
      phone.ws.close();
    });
    assert.equal(asScreen(await back).face, "companion");
    assert.equal(asScreen(await otherBack).face, "companion");
    assert.equal(relay.session.phone().live_lines.length, 0);
    assert.equal(relay.session.reminders()[0]?.text, reminder);
    assert.equal(relay.session.items().length, 1);

    const again = await openClient(port, "/phone");
    const restored = asPhone(await again.next());
    assert.deepEqual(restored.live_lines, []);
    assert.equal(JSON.stringify(restored).includes(reminder), false);
    again.ws.close();

    const lockedWait = badge.next();
    const lockedOther = other.next();
    relay.session.lock();
    const locked = asScreen(await lockedWait);
    assert.equal(locked.face, "locked");
    assert.equal(locked.mic_power, false);
    assert.equal(asScreen(await lockedOther).face, "locked");
    const before = relay.session.workingSet();
    assert.equal(
      relay.session.feedMemory({
        reminders: [{ text: "A new reminder", mentioned_at: 1729864300 }],
        live: { transcript: "should not paint", translation: "no" },
      }).ok,
      false,
    );
    assert.deepEqual(relay.session.workingSet(), before);
    assert.equal(relay.session.phone().live_lines.length, 0);
    assert.equal(JSON.stringify(relay.session.screen()).includes("should not paint"), false);
    assert.equal(JSON.stringify(relay.session.screen()).includes(reminder), false);

    const beat = badge.next();
    assert.equal(relay.session.heartbeatOk().ok, true);
    const resumed = asScreen(await beat);
    assert.equal(resumed.face, "companion");
    assert.equal(resumed.mic_power, true);
    assert.equal(relay.session.reminders()[0]?.text, reminder);

    await new Promise<void>((resolve) => {
      other.ws.once("close", () => resolve());
      other.ws.close();
    });
    assert.equal(relay.session.screen().face, "companion");

    await new Promise<void>((resolve) => {
      badge.ws.once("close", () => resolve());
      badge.ws.close();
    });
    const dropped = relay.session.screen();
    assert.equal(dropped.face, "not_linked");
    assert.equal(dropped.mic_power, false);
    assert.equal(relay.session.reminders()[0]?.text, reminder);
    assert.equal(relay.session.retainedAudioBytes(), 0);

    const linked = await openClient(port, "/ws");
    const companion = asScreen(await linked.next());
    assert.equal(companion.face, "companion");
    assert.equal(companion.mic_power, true);
    assert.equal(JSON.stringify(companion).includes(reminder), false);
  } finally {
    await relay.close();
  }
});

test("the stand-in paints only the face the relay sends", () => {
  const { document: doc } = parseHTML("<!doctype html><div id='glass'></div>");
  globalThis.document = doc;
  const glass = doc.querySelector("#glass");
  assert.ok(glass);

  for (const face of ["companion", "live", "not_linked"] as const) {
    renderGlass(glass, { type: "screen", face, mic_power: face !== "not_linked" });
    assert.equal(glass.textContent, FACE_LABEL[face]);
    assert.equal(glass.classList.contains("is-locked"), false);
    assert.equal((glass.textContent ?? "").includes(reminder), false);
  }

  renderGlass(glass, {
    type: "screen",
    face: "locked",
    mic_power: false,
  });
  assert.equal(glass.textContent, LOCK_TEXT);
  assert.equal(glass.classList.contains("is-locked"), true);
  assert.equal((glass.textContent ?? "").includes(reminder), false);
});

test("a dropped badge reconnects locked until a private heartbeat", async () => {
  const relay = createRelay();
  const port = await listen(relay);
  try {
    const badge = await openClient(port, "/ws");
    asScreen(await badge.next());
    const lockedWait = badge.next();
    relay.session.lock();
    assert.equal(asScreen(await lockedWait).face, "locked");
    await new Promise<void>((resolve) => {
      badge.ws.once("close", () => resolve());
      badge.ws.close();
    });
    assert.equal(relay.session.screen().face, "not_linked");
    const again = await openClient(port, "/ws");
    const frame = asScreen(await again.next());
    assert.equal(frame.face, "locked");
    assert.equal(frame.mic_power, false);
  } finally {
    await relay.close();
  }
});

test("stand-in is served without a baked sentence, and the clip control is off the glass", async () => {
  const relay = createRelay();
  const port = await listen(relay);
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /STAND_IN/);
    assert.match(html, /id="glass"/);
    assert.match(html, /Inject clip/);
    assert.equal(html.includes("Kenji"), false);
    assert.equal(html.includes(LOCK_TEXT), false);
    const { document: doc } = parseHTML(html);
    const glass = doc.querySelector("#glass");
    const clip = doc.querySelector("button.clip");
    const bezel = doc.querySelector(".bezel");
    assert.ok(glass);
    assert.ok(clip);
    assert.ok(bezel);
    assert.equal(glass.contains(clip), false);
    assert.equal(bezel.contains(clip), false);
    assert.equal(glass.textContent, "");
    const css = await (await fetch(`http://127.0.0.1:${port}/stand-in.css`)).text();
    assert.match(css, /\.glass\.is-locked/);
    assert.match(css, /#e10600/);
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/stand-in.html");
    assert.match(fs.readFileSync(root, "utf8"), /STAND_IN/);
    const script = await (await fetch(`http://127.0.0.1:${port}/stand-in.js`)).text();
    assert.match(script, /not_linked/);
    assert.match(script, /"press"/);
    const mic = await (await fetch(`http://127.0.0.1:${port}/phone-mic.js`)).text();
    assert.match(mic, /encodeWav/);
    assert.match(mic, /phoneIsBadge/);
  } finally {
    await relay.close();
  }
});
