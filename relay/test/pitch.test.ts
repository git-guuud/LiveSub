// IDEA.md section 9, on the stand-in and the phone.
// The router is mocked. Storage is CipherLog, the real AES-256-GCM encrypt-and-log
// path, on InMemoryOg, an in-process log.

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { parseHTML } from "linkedom";
import { WebSocket, type RawData } from "ws";
import { formatWhen, loadCompanion, renderPhone } from "../public/phone.js";
import { FACE_LABEL, LOCK_TEXT, renderGlass } from "../public/screen.js";
import type { CompanionView, PhoneState, ScreenState } from "../src/protocol.ts";
import { REASON_URL } from "../src/reason.ts";
import { createStorageKey } from "../src/seal.ts";
import { createRelay, type Relay } from "../src/server.ts";
import { CipherLog, InMemoryOg } from "../src/storage.ts";
import { TRANSCRIBE_MODEL, TRANSCRIBE_URL, TRUST_MODE, TRUST_MODE_HEADER } from "../src/transcribe.ts";
import type { MemoryOp } from "../src/working-set.ts";

const REMINDER = "Meet Kenji Thursday";
const ITEM = "Send Kenji 5 USDC";
const KENJI = "I'll meet Kenji on Thursday. I still owe him 5 USDC.";
const PAID = "I sent Kenji the 5 USDC.";
const NEITHER = "The train was on time.";
const LIVE_LINE = "¿Dónde está la cafetería?";
const LIVE_TRANSLATION = "Where is the cafe?";
const AYA = "Remind me to call Aya tomorrow.";
const AYA_REMINDER = "Call Aya tomorrow";
const CLIP = Uint8Array.from([1, 2, 3, 4]);
const PROVIDER = "0xprovider";

type Fail =
  | { status: 503 | 502; stage: "transcribe" | "reason" }
  | { tee: true; stage: "transcribe" | "reason" };

interface Beat {
  transcript: string;
  translation: string;
  memory_ops: MemoryOp[];
  fail?: Fail;
}

class MockRouter {
  readonly prompts: string[] = [];
  readonly calls: string[] = [];
  #beats: Beat[];
  #cursor = 0;

  constructor(beats: Beat[]) {
    this.#beats = beats;
  }

  fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.headers.get(TRUST_MODE_HEADER), TRUST_MODE);
    assert.equal([...request.headers.values()].includes("standard"), false);
    const beat = this.#beats[this.#cursor];
    assert.ok(beat, `unexpected router call ${request.url}`);
    if (request.url.startsWith(TRANSCRIBE_URL.split("?")[0] ?? TRANSCRIBE_URL)) {
      assert.equal(new URL(request.url).searchParams.get("verify_tee"), "true");
      assert.equal(request.headers.get("authorization"), "Bearer sk-test");
      const form = await request.formData();
      assert.equal(form.get("model"), TRANSCRIBE_MODEL);
      this.calls.push("transcribe");
      if (beat.fail?.stage === "transcribe") {
        this.#cursor += 1;
        return failed(beat);
      }
      return Response.json({
        text: beat.transcript,
        x_0g_trace: { request_id: `req-t-${this.#cursor}`, provider: PROVIDER, tee_verified: true },
      });
    }
    assert.equal(request.url, REASON_URL);
    const body = (await request.json()) as {
      verify_tee?: unknown;
      messages?: Array<{ content?: string }>;
    };
    assert.equal(body.verify_tee, true);
    assert.equal(JSON.stringify(body).includes("standard"), false);
    this.prompts.push(body.messages?.[1]?.content ?? "");
    this.calls.push("reason");
    this.#cursor += 1;
    if (beat.fail?.stage === "reason") return failed(beat);
    return Response.json(reasonEnvelope(beat, true));
  };
}

class Client {
  ws: WebSocket;
  queue: unknown[] = [];
  waiters: Array<(message: unknown) => void> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const message = JSON.parse(text(data));
      if ((message as { type?: string }).type === "clip") return;
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

function reasonEnvelope(beat: Beat, verified: boolean): unknown {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            memory_ops: beat.memory_ops,
            transcript: beat.transcript,
            translation: beat.translation,
          }),
        },
      },
    ],
    x_0g_trace: { request_id: "req-r", provider: PROVIDER, tee_verified: verified },
  };
}

function failed(beat: Beat): Response {
  const fail = beat.fail;
  assert.ok(fail);
  if ("status" in fail) {
    const payload =
      fail.stage === "transcribe"
        ? { text: beat.transcript, x_0g_trace: { request_id: "req-fail", provider: PROVIDER, tee_verified: true } }
        : reasonEnvelope(beat, true);
    return new Response(JSON.stringify(payload), { status: fail.status });
  }
  if (fail.stage === "transcribe") {
    return Response.json({
      text: beat.transcript,
      x_0g_trace: { request_id: "req-fail", provider: PROVIDER, tee_verified: false },
    });
  }
  return Response.json(reasonEnvelope(beat, false));
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

async function withRelay<T>(
  log: CipherLog,
  router: MockRouter,
  run: (relay: Relay, port: number) => Promise<T>,
): Promise<T> {
  const relay = createRelay(undefined, {
    apiKey: "sk-test",
    chatModel: "fixture-private-chat",
    log,
    fetchImpl: router.fetchImpl,
  });
  await relay.session.loadMemory();
  const port = await listen(relay);
  try {
    return await run(relay, port);
  } finally {
    await relay.close();
  }
}

async function until(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function speak(relay: Relay, badge: Client): Promise<void> {
  const traces = relay.session.phone().traces.length;
  badge.ws.send(CLIP);
  await until("utterance", () => relay.session.phone().traces.length === traces + 2);
  await relay.session.storageSettled();
}

function asScreen(message: unknown): ScreenState {
  assert.equal((message as ScreenState).type, "screen");
  return message as ScreenState;
}

function asPhone(message: unknown): PhoneState {
  assert.equal((message as PhoneState).type, "phone");
  return message as PhoneState;
}

async function readCompanion(port: number): Promise<CompanionView> {
  const response = await fetch(`http://127.0.0.1:${port}/companion`);
  assert.equal(response.status, 200);
  return (await response.json()) as CompanionView;
}

function paintGlass(html: string, state: ScreenState): HTMLElement {
  const { document: doc } = parseHTML(html);
  globalThis.document = doc;
  const glass = doc.querySelector("#glass");
  const mic = doc.querySelector("#mic");
  assert.ok(glass);
  assert.ok(mic);
  renderGlass(glass, state);
  mic.textContent = state.mic_power ? "Mic power on" : "Mic power cut";
  assert.equal(glass.textContent, FACE_LABEL[state.face]);
  assert.equal(glass.classList.contains("is-locked"), state.face === "locked");
  assert.equal(mic.textContent, state.mic_power ? "Mic power on" : "Mic power cut");
  const shown = glass.textContent ?? "";
  assert.equal(shown.includes(KENJI), false);
  assert.equal(shown.includes(PAID), false);
  assert.equal(shown.includes(NEITHER), false);
  assert.equal(shown.includes(LIVE_LINE), false);
  assert.equal(shown.includes(LIVE_TRANSLATION), false);
  assert.equal(shown.includes(AYA), false);
  assert.equal(shown.includes(REMINDER), false);
  assert.equal(shown.includes(ITEM), false);
  const root = doc.querySelector("main");
  assert.ok(root);
  return root as HTMLElement;
}

async function paintPhone(html: string, port: number, state: PhoneState | null): Promise<HTMLElement> {
  const { document: doc } = parseHTML(html);
  globalThis.document = doc;
  const root = doc.querySelector("main.phone");
  assert.ok(root);
  await loadCompanion(root, (input) => fetch(`http://127.0.0.1:${port}${String(input)}`));
  renderPhone(root, state);
  return root as HTMLElement;
}

function assertUtteranceTime(root: ParentNode, when: number): void {
  const time = root.querySelector("#reminders time");
  assert.ok(time);
  assert.equal(time.textContent, formatWhen(when));
  assert.equal("dateTime" in time ? time.dateTime : "", new Date(when * 1000).toISOString());
}

test("section 9 pitch on the stand-in and the phone", async () => {
  const key = createStorageKey();
  const network = new InMemoryOg();
  const log = new CipherLog(key, network);
  const router = new MockRouter([
    {
      transcript: KENJI,
      translation: "",
      memory_ops: [
        { op: "add_reminder", text: REMINDER },
        { op: "add_item", list: "open", text: ITEM },
      ],
    },
    {
      transcript: PAID,
      translation: "",
      memory_ops: [{ op: "close_item", text: ITEM }],
    },
    { transcript: NEITHER, translation: "", memory_ops: [] },
    { transcript: LIVE_LINE, translation: LIVE_TRANSLATION, memory_ops: [] },
  ]);
  let standInHtml = "";
  let phoneHtml = "";
  let when = 0;

  await withRelay(log, router, async (relay, port) => {
    standInHtml = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    phoneHtml = await (await fetch(`http://127.0.0.1:${port}/phone`)).text();
    assert.equal(standInHtml.includes("Kenji"), false);
    assert.equal(phoneHtml.includes("Kenji"), false);
    const { document: bench } = parseHTML(standInHtml);
    const glass = bench.querySelector("#glass");
    const clip = bench.querySelector("button.clip");
    assert.ok(glass);
    assert.ok(clip);
    assert.equal(glass.contains(clip), false);

    const badge = await openClient(port, "/ws");
    const hello = asScreen(await badge.next());
    assert.equal(hello.face, "companion");
    assert.equal(hello.mic_power, true);
    paintGlass(standInHtml, hello);

    const refused = badge.next();
    badge.send({ type: "press" });
    assert.deepEqual(await refused, { type: "reject", reason: "phone_closed" });
    assert.equal(relay.session.screen().face, "companion");
    assert.equal(relay.session.screen().mic_power, true);
    assert.equal(relay.session.phoneLinked(), false);

    await speak(relay, badge);
    assert.equal(badge.queue.length, 0);
    assert.equal(JSON.stringify(relay.session.screen()).includes(KENJI), false);
    paintGlass(standInHtml, relay.session.screen());
    assert.equal(relay.session.reminders()[0]?.text, REMINDER);
    assert.equal(relay.session.items()[0]?.text, ITEM);
    when = relay.session.reminders()[0]?.mentioned_at ?? 0;
    assert.equal(relay.session.items()[0]?.updated_at, when);
    assert.ok(Math.abs(when - Math.floor(Date.now() / 1000)) < 5);

    assert.equal(relay.session.phoneLinked(), false);
    const stored = await readCompanion(port);
    assert.equal(stored.reminders[0]?.text, REMINDER);
    assert.equal(stored.reminders[0]?.mentioned_at, when);
    assert.equal(stored.items[0]?.text, ITEM);
    assert.equal(stored.items[0]?.updated_at, when);
    assert.equal(JSON.stringify(stored).includes(KENJI), false);
    const sealed = await network.getIndex();
    assert.ok(sealed);
    assert.equal(Buffer.from(sealed).toString("utf8").includes(REMINDER), false);
    assert.equal(Buffer.from(sealed).toString("utf8").includes(KENJI), false);
    assert.equal(Buffer.from(sealed).includes(Buffer.from(key)), false);

    const phone = await openClient(port, "/phone");
    const opened = asPhone(await phone.next());
    assert.equal(opened.mode, "companion");
    assert.deepEqual(opened.live_lines, []);
    assert.equal(JSON.stringify(opened).includes(REMINDER), false);
    assert.equal(JSON.stringify(opened).includes(ITEM), false);
    const page = await paintPhone(phoneHtml, port, opened);
    assert.equal(page.querySelector(".reminder-text")?.textContent, REMINDER);
    assert.equal(page.querySelector(".item-text")?.textContent, ITEM);
    assertUtteranceTime(page, when);
    assert.equal(page.querySelector("#items time")?.textContent, formatWhen(when));
    assert.equal(page.querySelector("#live-section")?.hasAttribute("hidden"), true);
    assert.equal(page.textContent?.includes(KENJI), false);

    await new Promise<void>((resolve) => {
      phone.ws.once("close", () => resolve());
      phone.ws.close();
    });
    assert.equal(relay.session.phoneLinked(), false);
    assert.equal(relay.session.screen().face, "companion");
    assert.equal(relay.session.screen().mic_power, true);

    await speak(relay, badge);
    assert.equal(badge.queue.length, 0);
    paintGlass(standInHtml, relay.session.screen());
    assert.equal(relay.session.phoneLinked(), false);
    const afterPay = await readCompanion(port);
    assert.equal(afterPay.reminders[0]?.text, REMINDER);
    assert.equal(afterPay.reminders[0]?.mentioned_at, when);
    assert.deepEqual(afterPay.items, []);
    const paidPage = await paintPhone(phoneHtml, port, null);
    assert.equal(paidPage.querySelector(".reminder-text")?.textContent, REMINDER);
    assertUtteranceTime(paidPage, when);
    assert.equal(paidPage.querySelector(".item-text"), null);
    assert.equal(paidPage.querySelector("#items-empty")?.hasAttribute("hidden"), false);
    assert.equal(paidPage.textContent?.includes(PAID), false);
    assert.match(router.prompts[1] ?? "", /mode: companion/);
    assert.match(router.prompts[1] ?? "", new RegExp(`Meet Kenji Thursday \\(mentioned_at ${when}\\)`));
    assert.match(router.prompts[1] ?? "", /Send Kenji 5 USDC/);
  });

  assert.match(router.prompts[0] ?? "", /mode: companion/);
  assert.match(router.prompts[0] ?? "", /I'll meet Kenji on Thursday/);
  assert.equal(router.prompts[0]?.includes("standard"), false);

  await withRelay(log, router, async (relay, port) => {
    assert.equal(relay.session.reminders()[0]?.text, REMINDER);
    assert.equal(relay.session.reminders()[0]?.mentioned_at, when);
    assert.equal(relay.session.items().length, 0);
    assert.equal(relay.session.phone().live_lines.length, 0);

    const badge = await openClient(port, "/ws");
    const hello = asScreen(await badge.next());
    assert.equal(hello.face, "companion");
    assert.equal(hello.mic_power, true);
    paintGlass(standInHtml, hello);
    assert.equal(relay.session.phoneLinked(), false);

    await speak(relay, badge);
    assert.equal(badge.queue.length, 0);
    assert.equal(JSON.stringify(relay.session.screen()).includes(NEITHER), false);
    paintGlass(standInHtml, relay.session.screen());
    assert.equal(relay.session.phoneLinked(), false);
    const kept = await readCompanion(port);
    assert.equal(kept.reminders[0]?.text, REMINDER);
    assert.equal(kept.reminders[0]?.mentioned_at, when);
    assert.deepEqual(kept.items, []);
    const keptPage = await paintPhone(phoneHtml, port, null);
    assert.equal(keptPage.querySelector(".reminder-text")?.textContent, REMINDER);
    assertUtteranceTime(keptPage, when);
    assert.equal(keptPage.querySelector(".item-text"), null);
    assert.match(router.prompts[2] ?? "", /mode: companion/);
    assert.match(router.prompts[2] ?? "", new RegExp(`mentioned_at ${when}`));
    assert.equal(router.prompts[2]?.includes(ITEM), false);
    assert.match(router.prompts[2] ?? "", /The train was on time/);

    const phone = await openClient(port, "/phone");
    const opened = asPhone(await phone.next());
    assert.equal(JSON.stringify(opened).includes(REMINDER), false);
    assert.deepEqual(opened.live_lines, []);
    const { document: doc } = parseHTML(phoneHtml);
    globalThis.document = doc;
    const page = doc.querySelector("main.phone");
    assert.ok(page);
    await loadCompanion(page, (input) => fetch(`http://127.0.0.1:${port}${String(input)}`));
    renderPhone(page, opened);
    assert.equal(page.querySelector(".reminder-text")?.textContent, REMINDER);
    assertUtteranceTime(page, when);

    const liveBadge = badge.next();
    const livePhone = phone.next();
    badge.send({ type: "press" });
    const liveScreen = asScreen(await liveBadge);
    const liveState = asPhone(await livePhone);
    assert.equal(liveScreen.face, "live");
    assert.equal(liveScreen.mic_power, true);
    assert.equal(liveState.mode, "live");
    paintGlass(standInHtml, liveScreen);
    globalThis.document = doc;
    renderPhone(page, liveState);

    const lined = phone.next();
    badge.ws.send(CLIP);
    let withLine = asPhone(await lined);
    if (!withLine.live_lines[0]?.translation) withLine = asPhone(await phone.next());
    await relay.session.storageSettled();
    assert.equal(withLine.live_lines[0]?.transcript, LIVE_LINE);
    assert.equal(withLine.live_lines[0]?.translation, LIVE_TRANSLATION);
    assert.equal(JSON.stringify(withLine).includes(REMINDER), false);
    assert.equal(badge.queue.length, 0);
    assert.equal(JSON.stringify(relay.session.screen()).includes(LIVE_LINE), false);
    paintGlass(standInHtml, relay.session.screen());
    globalThis.document = doc;
    renderPhone(page, withLine);
    assert.equal(page.querySelector(".transcript")?.textContent, LIVE_LINE);
    assert.equal(page.querySelector(".translation")?.textContent, LIVE_TRANSLATION);
    assert.equal(page.querySelector(".reminder-text")?.textContent, REMINDER);
    assertUtteranceTime(page, when);
    assert.equal(page.querySelector("#live-section")?.hasAttribute("hidden"), false);
    assert.match(router.prompts[3] ?? "", /mode: live/);
    assert.match(router.prompts[3] ?? "", new RegExp(`mentioned_at ${when}`));

    const back = badge.next();
    await new Promise<void>((resolve) => {
      phone.ws.once("close", () => resolve());
      phone.ws.close();
    });
    const returned = asScreen(await back);
    assert.equal(returned.face, "companion");
    assert.equal(returned.mic_power, true);
    paintGlass(standInHtml, returned);
    assert.equal(relay.session.phone().live_lines.length, 0);
    assert.equal(relay.session.phoneLinked(), false);
    const still = await readCompanion(port);
    assert.equal(still.reminders[0]?.text, REMINDER);
    assert.equal(still.reminders[0]?.mentioned_at, when);
    assert.deepEqual(still.items, []);
    const again = await openClient(port, "/phone");
    const reopened = asPhone(await again.next());
    assert.deepEqual(reopened.live_lines, []);
    assert.equal(JSON.stringify(reopened).includes(REMINDER), false);
    assert.equal(JSON.stringify(reopened).includes(LIVE_LINE), false);
    const reopenedPage = await paintPhone(phoneHtml, port, reopened);
    assert.equal(reopenedPage.querySelector(".reminder-text")?.textContent, REMINDER);
    assertUtteranceTime(reopenedPage, when);
    assert.equal(reopenedPage.querySelector(".transcript"), null);
    assert.equal(reopenedPage.querySelector("#live-section")?.hasAttribute("hidden"), true);
  });

  assert.deepEqual(router.calls, [
    "transcribe",
    "reason",
    "transcribe",
    "reason",
    "transcribe",
    "reason",
    "transcribe",
    "reason",
  ]);

  const failures: Array<{ name: string; fail: Fail; calls: string[] }> = [
    { name: "HTTP 503", fail: { status: 503, stage: "transcribe" }, calls: ["transcribe"] },
    { name: "HTTP 502", fail: { status: 502, stage: "reason" }, calls: ["transcribe", "reason"] },
    { name: "tee_verified not true", fail: { tee: true, stage: "reason" }, calls: ["transcribe", "reason"] },
  ];

  for (const failure of failures) {
    const failRouter = new MockRouter([
      {
        transcript: AYA,
        translation: AYA_REMINDER,
        memory_ops: [{ op: "add_reminder", text: AYA_REMINDER }],
        fail: failure.fail,
      },
    ]);
    await withRelay(log, failRouter, async (relay, port) => {
      assert.equal(relay.session.reminders()[0]?.mentioned_at, when);
      const badge = await openClient(port, "/ws");
      const hello = asScreen(await badge.next());
      assert.equal(hello.face, "companion");
      assert.equal(hello.mic_power, true);
      paintGlass(standInHtml, hello);

      const refused = badge.next();
      badge.send({ type: "press" });
      assert.deepEqual(await refused, { type: "reject", reason: "phone_closed" });
      assert.equal(relay.session.screen().face, "companion");
      assert.equal(relay.session.screen().mic_power, true);
      assert.notEqual(relay.session.screen().face, "locked");

      const phone = await openClient(port, "/phone");
      const opened = asPhone(await phone.next());
      const { document: doc } = parseHTML(phoneHtml);
      globalThis.document = doc;
      const page = doc.querySelector("main.phone");
      assert.ok(page);
      await loadCompanion(page, (input) => fetch(`http://127.0.0.1:${port}${String(input)}`));
      renderPhone(page, opened);
      assert.equal(page.querySelector(".reminder-text")?.textContent, REMINDER);

      const liveBadge = badge.next();
      const livePhone = phone.next();
      badge.send({ type: "press" });
      assert.equal(asScreen(await liveBadge).face, "live");
      assert.equal(asPhone(await livePhone).mode, "live");
      const before = await readCompanion(port);

      const lockedBadge = badge.next();
      const lockedPhone = phone.next();
      badge.ws.send(CLIP);
      const locked = asScreen(await lockedBadge);
      let phoneAfter = asPhone(await lockedPhone);
      if (phoneAfter.live_lines.length > 0) phoneAfter = asPhone(await phone.next());
      assert.equal(locked.face, "locked", failure.name);
      assert.equal(locked.mic_power, false, failure.name);
      const glass = paintGlass(standInHtml, locked);
      assert.equal(glass.querySelector("#glass")?.textContent, LOCK_TEXT);
      assert.equal(glass.querySelector("#glass")?.classList.contains("is-locked"), true);
      assert.equal(glass.querySelector("#mic")?.textContent, "Mic power cut");
      globalThis.document = doc;
      renderPhone(page, phoneAfter);
      assert.equal(phoneAfter.live_lines.length, 0);
      assert.equal(JSON.stringify(phoneAfter).includes(AYA), false);
      assert.equal(page.querySelector(".transcript"), null);
      assert.equal(page.querySelector(".reminder-text")?.textContent, REMINDER);
      assert.equal(page.textContent?.includes(AYA), false);
      await relay.session.storageSettled();
      assert.deepEqual(await readCompanion(port), before);
      assert.equal(relay.session.reminders()[0]?.text, REMINDER);
      assert.equal(relay.session.reminders()[0]?.mentioned_at, when);
      assert.equal(relay.session.items().length, 0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(failRouter.calls, failure.calls, failure.name);
      for (const prompt of failRouter.prompts) assert.equal(prompt.includes("standard"), false);

      const told = badge.queue.shift() as { type?: string; reason?: string };
      assert.equal(told?.type, "reject", failure.name);
      assert.notEqual(told?.reason, "locked", failure.name);
      const rejected = badge.next();
      badge.ws.send(CLIP);
      assert.deepEqual(await rejected, { type: "reject", reason: "locked" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(failRouter.calls, failure.calls, failure.name);
      assert.deepEqual(await readCompanion(port), before);
      assert.equal(relay.session.screen().face, "locked");
    });
  }
});
