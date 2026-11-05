import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { parseHTML } from "linkedom";
import { WebSocket, type RawData } from "ws";
import type { PhoneState } from "../src/protocol.ts";
import { createRelay, type Relay } from "../src/server.ts";
import { renderCompanion, renderPhone } from "../public/phone.js";

const when = 1729864200;

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

function phoneDocument(): { root: HTMLElement } {
  const html = `<!doctype html><main class="phone">
    <p id="reminders-empty">Nothing to remember yet.</p><ol id="reminders"></ol>
    <p id="items-empty">No open items.</p><ol id="items"></ol>
    <section id="live-section" hidden><p id="live-empty">Words show up here as you speak.</p><ol id="live"></ol></section>
    <p id="traces-empty">No verified call yet.</p><ol id="traces"></ol>
    <p id="link-status"></p>
  </main>`;
  const { document: doc } = parseHTML(html);
  globalThis.document = doc;
  const root = doc.querySelector("main.phone");
  assert.ok(root);
  return { root };
}

test("an empty index leaves the phone with no items", () => {
  const { root } = phoneDocument();
  renderCompanion(root, { reminders: [], items: [] });
  renderPhone(root, { type: "phone", mode: "companion", live_lines: [], traces: [] });
  assert.equal(root.querySelector("#reminders")?.childElementCount, 0);
  assert.equal(root.querySelector("#items")?.childElementCount, 0);
  assert.equal(root.querySelector("#live")?.childElementCount, 0);
  assert.equal(root.querySelector("#reminders-empty")?.hasAttribute("hidden"), false);
  assert.equal(root.querySelector("#items-empty")?.hasAttribute("hidden"), false);
  assert.equal(root.querySelector("#live-section")?.hasAttribute("hidden"), true);
  assert.equal(root.textContent?.includes("Kenji"), false);
});

test("the phone renders reminders, items, a live line, and verified traces", () => {
  const { root } = phoneDocument();
  renderCompanion(root, {
    reminders: [{ text: "Meet Kenji Thursday", mentioned_at: when }],
    items: [{ list: "open", text: "Send Kenji 5 USDC", updated_at: when }],
  });
  renderPhone(root, {
    type: "phone",
    mode: "live",
    live_lines: [{ transcript: "I'll meet Kenji on Thursday.", translation: "Thursday with Kenji" }],
    traces: [
      {
        step: "transcribe",
        model: "whisper-large-v3",
        request_id: "req-t",
        provider: "0xprovider",
        tee_verified: true,
      },
      {
        step: "reason",
        model: "fixture-private-chat",
        request_id: "req-r",
        provider: "0xreason",
        tee_verified: false,
      },
    ],
  });
  assert.equal(root.querySelector(".reminder-text")?.textContent, "Meet Kenji Thursday");
  assert.equal(root.querySelector("#reminders time")?.dateTime, new Date(when * 1000).toISOString());
  assert.equal(root.querySelector(".item-text")?.textContent, "Send Kenji 5 USDC");
  assert.equal(root.querySelector(".transcript")?.textContent, "I'll meet Kenji on Thursday.");
  assert.equal(root.querySelector(".translation")?.textContent, "Thursday with Kenji");
  assert.equal(root.querySelector("#live-section")?.hasAttribute("hidden"), false);
  assert.equal(root.querySelectorAll(".trace").length, 1);
  assert.equal(root.querySelector(".request")?.textContent, "req-t");
  assert.equal(root.querySelector(".status")?.textContent, "Verified");
  assert.equal(root.textContent?.includes("req-r"), false);
});

test("closing the socket clears the page", () => {
  const { root } = phoneDocument();
  renderPhone(root, null);
  assert.match(root.querySelector("#link-status")?.textContent ?? "", /disconnected/);
  assert.equal(root.querySelector("#reminders")?.childElementCount, 0);
  assert.equal(root.querySelector("#live-section")?.hasAttribute("hidden"), true);
});

test("the phone page is served without a baked sentence", async () => {
  const relay = createRelay();
  const port = await listen(relay);
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/phone`)).text();
    assert.match(html, /Phone/);
    assert.match(html, /id="reminders"/);
    assert.match(html, /id="items"/);
    assert.match(html, /id="live"/);
    assert.match(html, /id="traces"/);
    assert.equal(html.includes("Kenji"), false);
    const phone = await openClient(port, "/phone");
    const hello = await phone.next();
    assert.equal((hello as PhoneState).type, "phone");
    assert.equal(JSON.stringify(hello).includes("reminders"), false);
    assert.deepEqual((hello as PhoneState).live_lines, []);
  } finally {
    await relay.close();
  }
});
