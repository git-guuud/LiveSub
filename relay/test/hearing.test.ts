import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyDecoder,
  formatHearing,
  guardUtterance,
  judgeHearing,
  measureClip,
  type Hearing,
} from "../src/hearing.ts";
import { REASON_URL, reasonUserContent, reasonUtterance } from "../src/reason.ts";
import { Session } from "../src/session.ts";
import { TRANSCRIBE_MODEL, transcribeClip } from "../src/transcribe.ts";
import { emptyWorkingSet, type WorkingSet } from "../src/working-set.ts";

const when = 1729864200;
const open: WorkingSet = {
  version: "2.0",
  reminders: [{ text: "Meet Kenji Thursday", mentioned_at: when }],
  items: [
    { list: "open", text: "Send Kenji 5 USDC", updated_at: when },
    { list: "todo", text: "Pick up the dry cleaning", updated_at: when },
  ],
};

const clear: Hearing = {
  measured: true,
  voice: "clear",
  noise: "low",
  level: 2400,
  room: 60,
  speech_ratio: 40,
  clipped: 0,
  avg_logprob: -0.2,
  no_speech_prob: 0.01,
  compression_ratio: 1.3,
};

const noisy: Hearing = { ...clear, noise: "high", speech_ratio: 3.3, room: 1200 };
const mumbled: Hearing = { ...clear, voice: "unclear", avg_logprob: -1.1 };

const kenji = "I'll meet Kenji on Thursday. I still owe him 5 USDC.";
const noisyKenji = "I'll meet Kenji on Thursday blender the squirrel owes him 5 USDC anyway coffee.";

test("a quiet room and a raised voice are clear", () => {
  const clip = measureClip(wav(tone(60, 5), tone(5000, 3)));
  const hearing = judgeHearing(clip, emptyDecoder());
  assert.ok(hearing.speech_ratio >= 8);
  assert.ok(hearing.room < 200);
  assert.equal(hearing.voice, "clear");
  assert.equal(hearing.noise, "low");
  assert.equal(hearing.avg_logprob, null);
});

test("a clip that is all voice stays clear enough to caption", () => {
  const clip = measureClip(wav(tone(2200, 8)));
  const hearing = judgeHearing(clip, emptyDecoder());
  assert.equal(hearing.voice, "clear");
  assert.equal(hearing.noise, "high");
});

test("a loud room under a clear voice is high noise", () => {
  const clip = measureClip(wav(tone(1200, 5), tone(4000, 3)));
  const hearing = judgeHearing(clip, emptyDecoder());
  assert.ok(hearing.speech_ratio < 4);
  assert.ok(hearing.speech_ratio >= 2.5);
  assert.equal(hearing.voice, "clear");
  assert.equal(hearing.noise, "high");
});

test("decoder doubt and a looping transcript override a clean clip", () => {
  const clip = measureClip(wav(tone(60, 5), tone(5000, 3)));
  assert.equal(judgeHearing(clip, { ...emptyDecoder(), avg_logprob: -0.95 }).voice, "unclear");
  assert.equal(judgeHearing(clip, { ...emptyDecoder(), no_speech_prob: 0.72 }).voice, "unclear");
  const looped = judgeHearing(clip, { ...emptyDecoder(), compression_ratio: 2.8 });
  assert.equal(looped.voice, "clear");
  assert.equal(looped.noise, "high");
  const smashed = judgeHearing({ ...clip, clipped: 0.05, measured: true }, emptyDecoder());
  assert.equal(smashed.noise, "high");
});

test("a clear quiet sentence keeps the reminder and the debt", () => {
  const guarded = guardUtterance({
    memoryOps: [
      { op: "add_reminder", text: "Meet Kenji Thursday" },
      { op: "add_item", list: "open", text: "Send Kenji 5 USDC" },
    ],
    summary: { text: "Kenji on Thursday, and 5 USDC still open.", points: ["Meet Kenji Thursday"] },
    transcript: kenji,
    hearing: clear,
    index: emptyWorkingSet(),
  });
  assert.deepEqual(guarded.memory_ops, [
    { op: "add_reminder", text: "Meet Kenji Thursday" },
    { op: "add_item", list: "open", text: "Send Kenji 5 USDC" },
  ]);
  assert.equal(guarded.summary.text.includes("Kenji"), true);
});

test("a clear near-name closes the open debt and does not fork Ken gee", () => {
  const guarded = guardUtterance({
    memoryOps: [
      { op: "close_item", text: "Send Ken gee 5 USDC" },
      { op: "close_reminder", text: "Meet Kenji Thursday" },
      { op: "add_item", list: "open", text: "Ken gee" },
      { op: "add_reminder", text: "Meet Ken gee Thursday" },
    ],
    summary: { text: "Sent Kenji the 5 USDC.", points: [] },
    transcript: "I sent Ken gee the five USDC.",
    hearing: clear,
    index: open,
  });
  assert.deepEqual(guarded.memory_ops, [{ op: "close_item", text: "Send Kenji 5 USDC" }]);
});

test("a clear unknown name stays as spoken", () => {
  const guarded = guardUtterance({
    memoryOps: [{ op: "add_reminder", text: "Meet Priya Monday" }],
    summary: { text: "", points: [] },
    transcript: "I'll meet Priya on Monday.",
    hearing: clear,
    index: open,
  });
  assert.deepEqual(guarded.memory_ops, [{ op: "add_reminder", text: "Meet Priya Monday" }]);
});

test("a clear clip still drops a commitment the transcript did not say", () => {
  const guarded = guardUtterance({
    memoryOps: [{ op: "add_item", list: "todo", text: "Buy a boat" }],
    summary: { text: "", points: [] },
    transcript: kenji,
    hearing: clear,
    index: emptyWorkingSet(),
  });
  assert.deepEqual(guarded.memory_ops, []);
});

test("high noise keeps the anchored Kenji facts and drops the stray words", () => {
  const guarded = guardUtterance({
    memoryOps: [
      { op: "add_reminder", text: "Meet Kenji Thursday" },
      { op: "add_item", list: "open", text: "Send Kenji 5 USDC" },
      { op: "add_item", list: "open", text: "blender squirrel" },
      { op: "add_reminder", text: "Meet Kenji Thursday blender squirrel" },
      { op: "add_item", list: "todo", text: "Pick up coffee" },
    ],
    summary: { text: "Squirrel and Kenji.", points: ["blender"] },
    transcript: noisyKenji,
    hearing: noisy,
    index: emptyWorkingSet(),
  });
  assert.deepEqual(guarded.memory_ops, [
    { op: "add_reminder", text: "Meet Kenji Thursday" },
    { op: "add_item", list: "open", text: "Send Kenji 5 USDC" },
  ]);
  assert.deepEqual(guarded.summary, { text: "", points: [] });
});

test("high noise does not close the Thursday reminder from a stray Thursday or from thirsty", () => {
  const stray = guardUtterance({
    memoryOps: [{ op: "close_reminder", text: "Meet Kenji Thursday" }],
    summary: { text: "Closed Thursday.", points: [] },
    transcript: "Thursday the squirrel paid",
    hearing: noisy,
    index: open,
  });
  const thirsty = guardUtterance({
    memoryOps: [{ op: "close_reminder", text: "Meet Kenji Thursday" }],
    summary: { text: "", points: [] },
    transcript: "I am thirsty",
    hearing: clear,
    index: open,
  });
  assert.deepEqual(stray.memory_ops, []);
  assert.deepEqual(thirsty.memory_ops, []);
  assert.equal(stray.summary.text, "");
});

test("high noise still closes the debt when the money was sent", () => {
  const guarded = guardUtterance({
    memoryOps: [
      { op: "close_item", text: "Send Ken gee 5 USDC" },
      { op: "close_reminder", text: "Meet Kenji Thursday" },
      { op: "close_item", text: "Pick up the dry cleaning" },
    ],
    summary: { text: "Paid.", points: ["squirrel"] },
    transcript: "I sent Ken gee the 5 USDC",
    hearing: noisy,
    index: open,
  });
  assert.deepEqual(guarded.memory_ops, [{ op: "close_item", text: "Send Kenji 5 USDC" }]);
});

test("an unclear voice keeps no operations", () => {
  const guarded = guardUtterance({
    memoryOps: [
      { op: "add_reminder", text: "Meet Kenji Thursday" },
      { op: "add_item", list: "open", text: "Send Kenji 5 USDC" },
      { op: "close_item", text: "Send Kenji 5 USDC" },
    ],
    summary: { text: "Kenji.", points: ["5 USDC"] },
    transcript: kenji,
    hearing: mumbled,
    index: open,
  });
  assert.deepEqual(guarded.memory_ops, []);
  assert.deepEqual(guarded.summary, { text: "", points: [] });
});

test("the reason prompt carries the hearing", () => {
  const user = reasonUserContent("companion", when, kenji, open, noisy);
  assert.match(user, /voice: clear/);
  assert.match(user, /noise: high/);
  assert.match(user, /speech_ratio: 3.3/);
  assert.equal(user.indexOf("Meet Kenji Thursday") < user.indexOf("hearing:"), true);
  assert.match(formatHearing(mumbled), /avg_logprob: -1.1/);
});

test("a verified reason call sends the hearing to the model", async () => {
  const result = await reasonUtterance("I sent Ken gee the 5 USDC.", {
    apiKey: "sk-test",
    model: "fixture-private-chat",
    timestamp: when,
    mode: "companion",
    index: open,
    hearing: clear,
    fetchImpl: async (_url, init) => {
      const payload = (await new Request(REASON_URL, init).json()) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const system = payload.messages?.find((message) => message.role === "system")?.content ?? "";
      const user = payload.messages?.find((message) => message.role === "user")?.content ?? "";
      assert.match(system, /noise high/);
      assert.match(user, /voice: clear/);
      assert.match(user, /Ken gee/);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memory_ops: [{ op: "close_item", text: "Send Kenji 5 USDC" }],
                  transcript: "I sent Kenji the 5 USDC.",
                  translation: "",
                  summary: { text: "Sent.", points: [] },
                }),
              },
            },
          ],
          x_0g_trace: { request_id: "req-r", provider: "0xprovider", tee_verified: true },
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.memory_ops[0]?.op, "close_item");
});

test("decoder segments ride along with a verified transcript", async () => {
  const audio = wav(tone(60, 5), tone(5000, 3));
  const result = await transcribeClip(audio, {
    apiKey: "sk-test",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          text: "I sent Kenji the 5 USDC.",
          segments: [{ avg_logprob: -0.91, no_speech_prob: 0.04, compression_ratio: 1.4, text: "I sent Kenji the 5 USDC." }],
          x_0g_trace: { request_id: "req-t", provider: "0xprovider", tee_verified: true },
        }),
        { status: 200 },
      ),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.hearing?.voice, "unclear");
  assert.equal(result.hearing?.noise, "low");
  assert.equal(result.hearing?.avg_logprob, -0.91);
});

test("the session applies a heard close and ignores an unclear window", () => {
  const session = new Session();
  session.setRelayLinked(true);
  session.acceptTranscribe(heard(kenji, clear));
  assert.equal(
    session.acceptReason(reasoned([
      { op: "add_reminder", text: "Meet Kenji Thursday" },
      { op: "add_item", list: "open", text: "Send Kenji 5 USDC" },
    ], kenji), when).ok,
    true,
  );
  session.acceptTranscribe(heard("I sent Ken gee the five USDC.", clear));
  session.acceptReason(
    reasoned([{ op: "close_item", text: "Send Ken gee 5 USDC" }, { op: "add_reminder", text: "Meet Ken gee Thursday" }], "I sent Kenji the 5 USDC."),
    when + 10,
  );
  assert.equal(session.reminders().length, 1);
  assert.equal(session.reminders()[0]?.text, "Meet Kenji Thursday");
  assert.equal(session.items().length, 0);

  session.setPhoneLinked(true);
  assert.equal(session.handle({ type: "press" }).ok, true);
  session.acceptTranscribe(heard(kenji, mumbled));
  session.acceptReason(
    reasoned([{ op: "add_item", list: "open", text: "Send Kenji 9 USDC" }], kenji, "Kenji"),
    when + 20,
  );
  assert.equal(session.screen().face, "live");
  assert.equal(session.screen().mic_power, true);
  assert.equal(session.phone().live_lines.length, 0);
  assert.equal(session.items().length, 0);
  assert.equal(session.reminders().length, 1);
});

test("Live shows a verified transcript before reason, and a sealed reason leaves it", () => {
  const session = new Session();
  session.setRelayLinked(true);
  session.setPhoneLinked(true);
  assert.equal(session.handle({ type: "press" }).ok, true);
  assert.equal(session.acceptTranscribe(heard("Thank you.", clear)).ok, true);
  assert.equal(session.phone().live_lines[0]?.transcript, "Thank you.");
  assert.equal(session.phone().live_lines[0]?.translation, "");
  assert.equal(session.acceptReason({ ok: false, reason: "sealed" }, when).ok, false);
  assert.equal(session.phone().live_lines[0]?.transcript, "Thank you.");
  assert.equal(session.reminders().length, 0);
  assert.equal(session.screen().face, "live");
});

function tone(level: number, count: number): Int16Array {
  const samples = new Int16Array(count * 800);
  samples.fill(level);
  return samples;
}

function wav(...parts: Int16Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const pcm = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    pcm.set(part, offset);
    offset += part.length;
  }
  const bytes = new Uint8Array(44 + pcm.byteLength);
  bytes[0] = 0x52;
  bytes[1] = 0x49;
  bytes[2] = 0x46;
  bytes[3] = 0x46;
  bytes[8] = 0x57;
  bytes[9] = 0x41;
  bytes[10] = 0x56;
  bytes[11] = 0x45;
  bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44);
  return bytes;
}

function heard(text: string, hearing: Hearing) {
  return {
    ok: true as const,
    text,
    hearing,
    trace: {
      step: "transcribe" as const,
      model: TRANSCRIBE_MODEL,
      request_id: "req-t",
      provider: "0xprovider",
      tee_verified: true as const,
    },
  };
}

function reasoned(
  memoryOps: Array<{ op: "add_reminder"; text: string } | { op: "add_item"; list: string; text: string } | { op: "close_item"; text: string } | { op: "close_reminder"; text: string }>,
  transcript: string,
  translation = "",
) {
  return {
    ok: true as const,
    memory_ops: memoryOps,
    transcript,
    translation,
    summary: { text: "", points: [] as string[] },
    trace: {
      step: "reason" as const,
      model: "fixture-private-chat",
      request_id: "req-r",
      provider: "0xprovider",
      tee_verified: true as const,
    },
  };
}
