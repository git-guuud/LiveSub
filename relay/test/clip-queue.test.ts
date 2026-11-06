import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import { REASON_URL } from "../src/reason.ts";
import { createRelay } from "../src/server.ts";
import { TRANSCRIBE_URL } from "../src/transcribe.ts";

test("a second clip waits until the first transcription returns", async () => {
  let release = (): void => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const relay = createRelay(undefined, {
    apiKey: "sk-test",
    chatModel: "fixture-private-chat",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.startsWith(TRANSCRIBE_URL)) {
        started += 1;
        if (started === 1) await hold;
        return new Response(
          JSON.stringify({
            text: "hello there",
            x_0g_trace: { request_id: "req-t", provider: "0xprovider", tee_verified: true },
          }),
          { status: 200 },
        );
      }
      assert.equal(url, REASON_URL);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ memory_ops: [], transcript: "hello there", translation: "" }),
              },
            },
          ],
          x_0g_trace: { request_id: "req-r", provider: "0xprovider", tee_verified: true },
        }),
        { status: 200 },
      );
    },
  });
  await new Promise<void>((resolve) => {
    relay.server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (relay.server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(Buffer.from([1, 2, 3, 4]));
    ws.send(Buffer.from([5, 6, 7, 8]));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(started, 1);
    release();
    for (let i = 0; i < 40 && started < 2; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(started, 2);
  } finally {
    release();
    ws.close();
    await relay.close();
  }
});
