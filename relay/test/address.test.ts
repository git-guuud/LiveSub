import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { emptyAddressMemory, hearAddress, normalizeBadgeName, type AddressMemory } from "../src/address.ts";
import type { Hearing } from "../src/hearing.ts";
import { createRelay, type Relay } from "../src/server.ts";
import { createStorageKey } from "../src/seal.ts";
import { Session } from "../src/session.ts";
import { CipherLog, InMemoryOg } from "../src/storage.ts";
import { TRANSCRIBE_MODEL } from "../src/transcribe.ts";

const when = 1729864200;

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

test("a badge name is a short word, and the default is seer", () => {
  assert.equal(normalizeBadgeName("  seer "), "seer");
  assert.equal(normalizeBadgeName("Blue Jay"), "Blue Jay");
  assert.equal(normalizeBadgeName("todo"), null);
  assert.equal(normalizeBadgeName("a"), null);
  assert.equal(normalizeBadgeName("hey!!"), null);
  assert.equal(new Session().badgeName(), "seer");
  assert.equal(new Session({ badgeName: "Oracle" }).badgeName(), "Oracle");
});

test("hey seer adds the sentence before, after, or still to come", () => {
  const before = hear("Buy oat milk. Hey seer, add this to the todo list.");
  assert.deepEqual(before.add, { list: "todo", text: "Buy oat milk" });

  const after = hear("Hey seer, add this to the TODO list. Call the dentist.");
  assert.deepEqual(after.add, { list: "todo", text: "Call the dentist" });

  const pointed = hear("We need oat milk.");
  const saved = hear("Hey seer can you add this to the TODO list", pointed.state);
  assert.deepEqual(saved.add, { list: "todo", text: "We need oat milk" });

  const waiting = hear("Hey seer, add the next thing to the important list.");
  assert.equal(waiting.add, null);
  assert.equal(waiting.state.armed, "important");
  const followed = hear("Email the landlord about the leak.", waiting.state);
  assert.deepEqual(followed.add, { list: "important", text: "Email the landlord about the leak" });

  const inline = hear("Hey seer add the gate code is 4412 to the important list.");
  assert.deepEqual(inline.add, { list: "important", text: "the gate code is 4412" });

  const named = hear("Hey seer, important: the gate code is 4412.");
  assert.deepEqual(named.add, { list: "important", text: "the gate code is 4412" });
});

test("the request itself is not the item, and a bare name adds nothing", () => {
  const weather = hear("Hey seer, what's the weather like today.");
  assert.equal(weather.add, null);
  const asked = hear("Hey seer, add that to the todo list.", weather.state);
  assert.equal(asked.add?.text, "Hey seer, what's the weather like today");

  const both = hear("Buy oat milk. Hey seer add this to the todo. And eggs.");
  assert.equal(both.add?.text, "Buy oat milk");

  const slipped = hear("Pick up the dry cleaning.");
  const near = hear("Hey sear, add this to the todo.", slipped.state);
  assert.equal(near.add?.text, "Pick up the dry cleaning");

  const planted = hear("I planted a seed and I should add water to the todo.");
  assert.equal(planted.add, null);

  const laundry = hear("Hey seer, add this to do the laundry.");
  assert.equal(laundry.add, null);

  const other = hear("Hey oracle add eggs to the todo.");
  assert.equal(other.add, null);
});

test("a mumbled address adds nothing, and a noisy one still does", () => {
  const session = new Session();
  session.setRelayLinked(true);
  say(session, "Buy oat milk.", noisy, when);
  assert.equal(session.items().length, 0);
  say(
    session,
    "Hey seer can you add this to the TODO list.",
    noisy,
    when + 1,
    [{ op: "add_item", list: "todo", text: "Hey seer can you add this to the TODO list." }],
  );
  assert.deepEqual(
    session.items().map((item) => item.text),
    ["Buy oat milk"],
  );

  const unclear = new Session();
  unclear.setRelayLinked(true);
  say(unclear, "Hey seer, add the next thing to the todo.", mumbled, when);
  say(unclear, "Call the dentist.", clear, when + 1);
  assert.equal(unclear.items().length, 0);

  const armed = new Session();
  armed.setRelayLinked(true);
  say(armed, "Hey seer, add the next thing to the important list.", clear, when);
  say(armed, "blender squirrel", mumbled, when + 1);
  assert.equal(armed.items().length, 0);
  say(armed, "Email the landlord about the leak.", noisy, when + 2);
  assert.equal(armed.items()[0]?.list, "important");
  assert.equal(armed.items()[0]?.text, "Email the landlord about the leak");
  assert.equal(JSON.stringify(armed.screen()).includes("landlord"), false);
});

test("a clear address drops the request the model stored and keeps the other sentence", () => {
  const session = new Session();
  session.setRelayLinked(true);
  say(session, "Meet Kenji Thursday. Hey seer add buy oat milk to the todo list.", clear, when, [
    { op: "add_item", list: "todo", text: "Hey seer add buy oat milk to the todo list." },
    { op: "add_reminder", text: "Meet Kenji Thursday" },
  ]);
  assert.deepEqual(
    session.items().map((item) => item.text),
    ["buy oat milk"],
  );
  assert.equal(session.reminders()[0]?.text, "Meet Kenji Thursday");
});

test("adding a row that is already open keeps its original time", () => {
  const session = new Session();
  session.setRelayLinked(true);
  session.loadWorkingSet({
    version: "2.0",
    reminders: [],
    items: [{ list: "todo", text: "Pick up the dry cleaning", updated_at: when }],
  });
  say(session, "Pick up the dry cleaning.", clear, when + 5);
  say(session, "Hey seer, add this to the todo list.", clear, when + 6);
  assert.equal(session.items().length, 1);
  assert.equal(session.items()[0]?.updated_at, when);
});

test("a lock drops a waiting sentence", () => {
  const session = new Session();
  session.setRelayLinked(true);
  say(session, "Hey seer, add the next thing to the todo.", clear, when);
  session.lock();
  assert.equal(session.heartbeatOk().ok, true);
  say(session, "Call the dentist.", clear, when + 1);
  assert.equal(session.items().length, 0);
});

test("renaming the badge is what the next relay answers to", async () => {
  const key = createStorageKey();
  const network = new InMemoryOg();
  const log = new CipherLog(key, network);
  const relay = createRelay(undefined, { log, badgeName: "seer" });
  await relay.session.loadMemory();
  const port = await listen(relay);
  try {
    const first = (await (await fetch(`http://127.0.0.1:${port}/companion`)).json()) as { badge_name?: string };
    assert.equal(first.badge_name, "seer");
    const refused = await revise(port, { action: "rename_badge", name: "todo" });
    assert.equal(refused.status, 409);
    const saved = await revise(port, { action: "rename_badge", name: "Oracle" });
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as { badge_name?: string };
    assert.equal(body.badge_name, "Oracle");
    assert.equal(JSON.stringify(relay.session.screen()).includes("Oracle"), false);
  } finally {
    await relay.close();
  }

  const next = createRelay(undefined, { log, badgeName: "seer" });
  await next.session.loadMemory();
  await listen(next);
  try {
    assert.equal(next.session.badgeName(), "Oracle");
    next.session.setRelayLinked(true);
    say(next.session, "Hey seer add eggs to the todo list.", clear, when);
    assert.equal(next.session.items().length, 0);
    say(next.session, "Hey oracle add eggs to the todo list.", clear, when + 1);
    assert.equal(next.session.items()[0]?.list, "todo");
    assert.equal(next.session.items()[0]?.text, "eggs");
    assert.equal(next.session.badgeName(), "Oracle");
    assert.equal(JSON.stringify(next.session.screen()).includes("Oracle"), false);
    assert.equal(JSON.stringify(next.session.screen()).includes("eggs"), false);
  } finally {
    await next.close();
  }
});

function hear(transcript: string, state: AddressMemory = emptyAddressMemory(), voice: "clear" | "unclear" | null = "clear") {
  return hearAddress({ transcript, name: "seer", state, voice });
}

function say(
  session: Session,
  text: string,
  hearing: Hearing,
  timestamp: number,
  memoryOps: Array<{ op: "add_item"; list: string; text: string } | { op: "add_reminder"; text: string }> = [],
): void {
  assert.equal(session.acceptTranscribe(heard(text, hearing)).ok, true);
  assert.equal(session.acceptReason(reasoned(memoryOps, text), timestamp).ok, true);
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
  memoryOps: Array<{ op: "add_item"; list: string; text: string } | { op: "add_reminder"; text: string }>,
  transcript: string,
) {
  return {
    ok: true as const,
    memory_ops: memoryOps,
    transcript,
    translation: "",
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

async function listen(relay: Relay): Promise<number> {
  await new Promise<void>((resolve) => {
    relay.server.listen(0, "127.0.0.1", () => resolve());
  });
  return (relay.server.address() as AddressInfo).port;
}

function revise(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/companion`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
