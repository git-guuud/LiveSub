import assert from "node:assert/strict";
import test from "node:test";
import {
  MODELS_URL,
  REASON_URL,
  pickPrivateChatModel,
  reasonUserContent,
  reasonUtterance,
  locksReason,
  createChatModelMemory,
  type ReasonResult,
} from "../src/reason.ts";
import { TRUST_MODE, TRUST_MODE_HEADER } from "../src/tee.ts";
import { emptyWorkingSet, type WorkingSet } from "../src/working-set.ts";

const spoken = "I'll meet Kenji on Thursday. I still owe him 5 USDC.";
const when = 1729864200;
const requestId = "0852f405-6c56-40c2-a800-e6fd70785065";
const provider = "0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C";
const chatModel = "fixture-private-chat";

const index: WorkingSet = {
  version: "2.0",
  reminders: [{ text: "Meet Aya Friday", mentioned_at: when }],
  items: [{ list: "open", text: "Send Kenji 5 USDC", updated_at: when }],
};

const kenjiOps = {
  memory_ops: [
    { op: "add_reminder", text: "Meet Kenji Thursday" },
    { op: "add_item", list: "open", text: "Send Kenji 5 USDC" },
  ],
  transcript: spoken,
  translation: "",
};

const catalog = {
  object: "list",
  data: [
    {
      id: "tee-tls-many",
      type: "chatbot",
      verifiability: "TeeTLS",
      provider_count: 9,
      supported_parameters: ["response_format", "chat_template_kwargs"],
      pricing: { prompt: "1" },
    },
    {
      id: "teeml-no-json",
      type: "chatbot",
      verifiability: "TeeML",
      provider_count: 8,
      supported_parameters: ["temperature"],
      pricing: { prompt: "1" },
    },
    {
      id: "teeml-one",
      type: "chatbot",
      verifiability: "TeeML",
      provider_count: 1,
      supported_parameters: ["response_format", "chat_template_kwargs"],
      pricing: { prompt: "1" },
    },
    {
      id: "teeml-four",
      type: "chatbot",
      verifiability: "TeeML",
      provider_count: 4,
      supported_parameters: ["response_format", "chat_template_kwargs"],
      pricing: { prompt: "50" },
    },
    {
      id: "teeml-four-cheap",
      type: "chatbot",
      verifiability: "TeeML",
      provider_count: 4,
      supported_parameters: ["response_format"],
      pricing: { prompt: "10" },
    },
    {
      id: "whisper-large-v3",
      type: "speech-to-text",
      verifiability: "TeeML",
      provider_count: 6,
      supported_parameters: ["response_format"],
      pricing: { prompt: "1" },
    },
  ],
};

function reasonBody(content: unknown, trace: Record<string, unknown> | null): string {
  return JSON.stringify({
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    ...(trace ? { x_0g_trace: trace } : {}),
  });
}

const verifiedTrace = { request_id: requestId, provider, tee_verified: true };

test("the prompt is the mode, the timestamp, the transcript, and the open items", () => {
  const user = reasonUserContent("companion", when, spoken, index);
  assert.equal(user.startsWith("mode: companion\n"), true);
  assert.match(user, /badge: seer/);
  assert.match(user, new RegExp(`timestamp: ${when}`));
  assert.match(user, /Meet Aya Friday/);
  assert.ok(user.indexOf("Meet Aya Friday") < user.indexOf("Send Kenji 5 USDC"));
  assert.equal(user.includes("hearing:"), false);
  assert.equal(user.includes("direction:"), false);
  assert.equal(user.includes("open_loop"), false);
  assert.equal(user.includes("standard"), false);
  assert.equal(reasonUserContent("live", when, spoken, emptyWorkingSet()).includes("(none)"), true);
});

test("the catalog pick is a TeeML chatbot with JSON, most providers, then cheapest", () => {
  assert.deepEqual(pickPrivateChatModel(catalog), {
    id: "teeml-four-cheap",
    disableThinking: false,
  });
  assert.deepEqual(
    pickPrivateChatModel({
      data: [
        {
          id: "only-thinking",
          type: "chatbot",
          verifiability: "TeeML",
          provider_count: 1,
          supported_parameters: ["response_format", "chat_template_kwargs"],
          pricing: { prompt: "3" },
        },
      ],
    }),
    { id: "only-thinking", disableThinking: true },
  );
});

test("a verified reason returns the Kenji operations and does not change the index", async () => {
  const before = structuredClone(index);
  let calls = 0;
  const result = await reasonUtterance(spoken, {
    apiKey: "sk-test",
    model: chatModel,
    timestamp: when,
    mode: "companion",
    index,
    fetchImpl: async (url, init) => {
      calls += 1;
      const request = new Request(url, init);
      assert.equal(String(url), REASON_URL);
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get(TRUST_MODE_HEADER), TRUST_MODE);
      assert.equal([...request.headers.values()].some((value) => value === "standard"), false);
      const payload = (await request.json()) as {
        model?: string;
        verify_tee?: boolean;
        response_format?: { type?: string };
        messages?: Array<{ role?: string; content?: string }>;
      };
      assert.equal(payload.model, chatModel);
      assert.equal(payload.verify_tee, true);
      assert.equal(payload.response_format?.type, "json_object");
      assert.equal(JSON.stringify(payload).includes("standard"), false);
      const user = payload.messages?.find((message) => message.role === "user")?.content ?? "";
      assert.match(user, /mode: companion/);
      assert.match(user, /Meet Aya Friday/);
      return new Response(reasonBody(kenjiOps, verifiedTrace), { status: 200 });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    ok: true,
    memory_ops: kenjiOps.memory_ops,
    transcript: spoken,
    translation: "",
    summary: { text: "", points: [] },
    trace: {
      step: "reason",
      model: chatModel,
      request_id: requestId,
      provider,
      tee_verified: true,
    },
  });
  assert.deepEqual(index, before);
});

test("the first successful catalog call records the private chat model and does not refetch", async () => {
  const record = createChatModelMemory();
  let catalogCalls = 0;
  let chatCalls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const href = String(url);
    if (href === MODELS_URL) {
      catalogCalls += 1;
      return new Response(JSON.stringify(catalog), { status: 200 });
    }
    chatCalls += 1;
    const request = new Request(url, init);
    const payload = (await request.json()) as { model?: string; chat_template_kwargs?: unknown };
    assert.equal(payload.model, "teeml-four-cheap");
    assert.equal(payload.chat_template_kwargs, undefined);
    assert.equal(request.headers.get(TRUST_MODE_HEADER), "private");
    return new Response(reasonBody(kenjiOps, verifiedTrace), { status: 200 });
  };
  const first = await reasonUtterance(spoken, {
    apiKey: "sk-test",
    timestamp: when,
    mode: "live",
    index,
    record,
    fetchImpl,
  });
  const second = await reasonUtterance(spoken, {
    apiKey: "sk-test",
    timestamp: when,
    mode: "live",
    index,
    record,
    fetchImpl,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(catalogCalls, 1);
  assert.equal(chatCalls, 2);
  assert.equal(record.model?.id, "teeml-four-cheap");
});

test("a todo list and a summary with points are kept, and a broken summary is refused", async () => {
  const spokenTasks =
    "Remind me to meet Kenji on Thursday. I still owe him 5 USDC. Pick up the dry cleaning and email the landlord about the leak.";
  const content = {
    memory_ops: [
      { op: "add_reminder", text: "Meet Kenji Thursday" },
      { op: "add_item", list: "debt", text: "Send Kenji 5 USDC" },
      { op: "add_item", list: "to-do", text: "Pick up the dry cleaning" },
      { op: "add_item", list: "tasks", text: "Email the landlord about the leak" },
    ],
    transcript: spokenTasks,
    translation: "",
    summary: {
      text: "Thursday with Kenji is open, the 5 USDC is unpaid, and two chores were added.",
      points: ["Meet Kenji Thursday", "5 USDC still unpaid", "Pick up the dry cleaning", "Email the landlord about the leak"],
    },
  };
  let system = "";
  const result = await reasonUtterance(spokenTasks, {
    apiKey: "sk-test",
    model: chatModel,
    timestamp: when,
    mode: "companion",
    index: emptyWorkingSet(),
    fetchImpl: async (_url, init) => {
      const request = new Request(REASON_URL, init);
      const payload = (await request.json()) as { messages?: Array<{ role?: string; content?: string }> };
      system = payload.messages?.find((message) => message.role === "system")?.content ?? "";
      return new Response(reasonBody(content, verifiedTrace), { status: 200 });
    },
  });
  assert.match(system, /list todo/);
  assert.match(system, /summary is \{text, points\}/);
  assert.match(system, /badge/);
  assert.equal(system.includes("standard"), false);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.memory_ops.map((op) => (op.op === "add_item" ? op.list : op.op)),
    ["add_reminder", "open", "todo", "todo"],
  );
  assert.equal(result.summary.points.length, 4);
  assert.match(result.summary.text, /5 USDC/);

  const broken = await reasonUtterance(spokenTasks, {
    apiKey: "sk-test",
    model: chatModel,
    timestamp: when,
    mode: "companion",
    index: emptyWorkingSet(),
    fetchImpl: async () =>
      new Response(reasonBody({ ...content, summary: { text: "Kept", points: "not a list" } }, verifiedTrace), {
        status: 200,
      }),
  });
  assert.deepEqual(broken, { ok: false, reason: "bad_output", status: 200 });
});

test("an old loop operation is not a reason result", async () => {
  const result = await reasonUtterance(spoken, {
    apiKey: "sk-test",
    model: chatModel,
    timestamp: when,
    mode: "companion",
    index: emptyWorkingSet(),
    fetchImpl: async () =>
      new Response(
        reasonBody(
          { memory_ops: [{ op: "open_loop", text: "Send Kenji 5 USDC", who: "Kenji" }], transcript: spoken },
          verifiedTrace,
        ),
        { status: 200 },
      ),
  });
  assert.deepEqual(result, { ok: false, reason: "bad_output", status: 200 });
  assert.equal(JSON.stringify(result).includes("open_loop"), false);
});

test("HTTP 503 and 502 do not retry and do not send trust mode standard", async () => {
  for (const status of [503, 502] as const) {
    let calls = 0;
    const result = await reasonUtterance(spoken, {
      apiKey: "sk-test",
      model: chatModel,
      timestamp: when,
      mode: "companion",
      index,
      fetchImpl: async (_url, init) => {
        calls += 1;
        const request = new Request(REASON_URL, init);
        assert.equal(request.headers.get(TRUST_MODE_HEADER), "private");
        assert.equal([...request.headers.values()].includes("standard"), false);
        return new Response(reasonBody(kenjiOps, verifiedTrace), { status });
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, {
      ok: false,
      reason: status === 503 ? "http_503" : "http_502",
      status,
    });
  }
});

test("a missing trace is not a reason result", async () => {
  const result: ReasonResult = await reasonUtterance(spoken, {
    apiKey: "sk-test",
    model: chatModel,
    timestamp: when,
    mode: "companion",
    index,
    fetchImpl: async () => new Response(reasonBody(kenjiOps, null), { status: 200 }),
  });
  assert.deepEqual(result, { ok: false, reason: "missing_trace", status: 200 });
  assert.equal(JSON.stringify(result).includes(spoken), false);
});

test("a sealed response with no tee boolean does not lock and is not memory", async () => {
  const result = await reasonUtterance(spoken, {
    apiKey: "sk-test",
    model: chatModel,
    timestamp: when,
    mode: "companion",
    index,
    fetchImpl: async () =>
      new Response(reasonBody(kenjiOps, { request_id: requestId, provider }), {
        status: 200,
        headers: { "x-0g-e2ee": "sealed" },
      }),
  });
  assert.deepEqual(result, { ok: false, reason: "sealed", status: 200 });
  assert.equal(locksReason(result), false);
});

test("tee_verified false is not a reason result", async () => {
  const result = await reasonUtterance(spoken, {
    apiKey: "sk-test",
    model: chatModel,
    timestamp: when,
    mode: "companion",
    index,
    fetchImpl: async () =>
      new Response(reasonBody(kenjiOps, { request_id: requestId, provider, tee_verified: false }), { status: 200 }),
  });
  assert.deepEqual(result, { ok: false, reason: "tee_unverified", status: 200 });
  assert.equal(JSON.stringify(result).includes("Meet Kenji Thursday"), false);
});
