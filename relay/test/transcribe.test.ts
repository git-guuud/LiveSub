import assert from "node:assert/strict";
import test from "node:test";
import {
  TRANSCRIBE_MODEL,
  TRANSCRIBE_URL,
  TRUST_MODE,
  TRUST_MODE_HEADER,
  transcribeClip,
} from "../src/transcribe.ts";

const transcript = "I'll send Kenji 5 USDC for the coffee.";
const requestId = "0852f405-6c56-40c2-a800-e6fd70785065";
const provider = "0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C";

function verifiedBody(text = transcript): string {
  return JSON.stringify({
    text,
    x_0g_trace: { request_id: requestId, provider, tee_verified: true },
  });
}

test("a verified transcript is kept and the audio is wiped", async () => {
  const audio = Uint8Array.from([9, 8, 7, 6]);
  let calls = 0;
  const result = await transcribeClip(audio, {
    apiKey: "sk-test",
    fetchImpl: async (url, init) => {
      calls += 1;
      const request = new Request(url, init);
      assert.equal(request.method, "POST");
      assert.equal(request.url, TRANSCRIBE_URL);
      assert.equal(new URL(request.url).searchParams.get("verify_tee"), "true");
      assert.equal(request.headers.get(TRUST_MODE_HEADER), TRUST_MODE);
      assert.equal(request.headers.get("authorization"), "Bearer sk-test");
      const form = await request.formData();
      assert.equal(form.get("model"), TRANSCRIBE_MODEL);
      assert.equal(form.get("response_format"), "json");
      const file = form.get("file");
      assert.ok(file instanceof Blob);
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), Uint8Array.from([9, 8, 7, 6]));
      return new Response(verifiedBody(), { status: 200 });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    ok: true,
    text: transcript,
    trace: {
      step: "transcribe",
      model: TRANSCRIBE_MODEL,
      request_id: requestId,
      provider,
      tee_verified: true,
    },
  });
  assert.deepEqual(audio, Uint8Array.from([0, 0, 0, 0]));
  assert.equal(JSON.stringify(result).includes("audio"), false);
});

test("a missing trace paints nothing and wipes the audio", async () => {
  const audio = Uint8Array.from([1, 2, 3]);
  const result = await transcribeClip(audio, {
    apiKey: "sk-test",
    fetchImpl: async () => new Response(JSON.stringify({ text: transcript }), { status: 200 }),
  });
  assert.deepEqual(result, { ok: false, reason: "missing_trace", status: 200 });
  assert.equal(JSON.stringify(result).includes(transcript), false);
  assert.deepEqual(audio, Uint8Array.from([0, 0, 0]));
});

test("tee_verified false paints nothing", async () => {
  const audio = Uint8Array.from([4]);
  const result = await transcribeClip(audio, {
    apiKey: "sk-test",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          text: transcript,
          x_0g_trace: { request_id: requestId, provider, tee_verified: false },
        }),
        { status: 200 },
      ),
  });
  assert.deepEqual(result, { ok: false, reason: "tee_unverified", status: 200 });
  assert.equal(JSON.stringify(result).includes(transcript), false);
  assert.deepEqual(audio, Uint8Array.from([0]));
});

test("HTTP 503 and 502 lock the result and do not retry", async () => {
  for (const status of [503, 502] as const) {
    let calls = 0;
    const audio = Uint8Array.from([status]);
    const result = await transcribeClip(audio, {
      apiKey: "sk-test",
      fetchImpl: async () => {
        calls += 1;
        return new Response(verifiedBody("should not paint"), { status });
      },
    });
    const reason = status === 503 ? "http_503" : "http_502";
    assert.deepEqual(result, { ok: false, reason, status });
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes("should not paint"), false);
    assert.deepEqual(audio, Uint8Array.from([0]));
  }
});

test("no API key never calls the router", async () => {
  const audio = Uint8Array.from([1, 1, 1]);
  let calls = 0;
  const result = await transcribeClip(audio, {
    fetchImpl: async () => {
      calls += 1;
      return new Response(verifiedBody(), { status: 200 });
    },
  });
  assert.deepEqual(result, { ok: false, reason: "no_key" });
  assert.equal(calls, 0);
  assert.deepEqual(audio, Uint8Array.from([0, 0, 0]));
});
