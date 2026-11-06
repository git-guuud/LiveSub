import assert from "node:assert/strict";
import test from "node:test";
import { guardUtterance, judgeHearing } from "../src/hearing.ts";
import { BANDS, CORPUS, type CorpusRow } from "./hearing-corpus.ts";

test("the corpus climbs from a clean sentence to gibberish", () => {
  assert.ok(CORPUS.length >= 80);
  for (const level of BANDS.map((band) => band.level)) {
    const rows = CORPUS.filter((row) => row.level === level);
    assert.ok(rows.length >= 14, `level ${level}`);
    const sample = rows[0];
    if (level === 0) assert.equal(sample.transcript.includes("uh"), false);
    if (level === 1) assert.match(rows.find((row) => row.scene === "kenji-meeting-debt")?.transcript ?? "", /Ken gee/);
    if (level === 2) assert.match(sample.transcript, /\buh\b|\blike\b|\banyway\b/);
    if (level === 3) assert.match(sample.transcript, /blender|squirrel|pigeon/);
    if (level >= 4) assert.match(sample.transcript, /squirrel Thursday 5 USDC/);
    if (level === 5) assert.match(sample.transcript, /zzz|quenda|\?\?\?/);
  }
});

test("metadata gets worse exactly where the proposer stops matching the task", () => {
  const scores = BANDS.map((band) => scoreLevel(band.level));
  for (const band of BANDS) {
    assert.equal(band.clip.speech_ratio > (BANDS[band.level + 1]?.clip.speech_ratio ?? 0) || band.level === 5, true);
  }
  for (const level of [0, 1, 2] as const) {
    assert.equal(scores[level].modelMatched, scores[level].rows, `level ${level} proposer`);
    assert.equal(scores[level].guardMatched, scores[level].rows, `level ${level} guard`);
    assert.equal(scores[level].voice, "clear");
    assert.equal(scores[level].noise, "low");
  }
  assert.equal(scores[3].modelMatched, 0);
  assert.equal(scores[3].guardMatched, scores[3].rows);
  assert.equal(scores[3].voice, "clear");
  assert.equal(scores[3].noise, "high");
  for (const level of [4, 5] as const) {
    assert.equal(scores[level].modelMatched, 0);
    assert.equal(scores[level].guardMatched, scores[level].rows);
    assert.equal(scores[level].voice, "unclear");
    assert.equal(scores[level].keptOps, 0);
  }
});

test("each corrupted transcript keeps only the task that band can support", () => {
  const misses: string[] = [];
  for (const row of CORPUS) {
    const hearing = judgeHearing(row.band.clip, row.band.decoder);
    if (hearing.voice !== row.band.voice || hearing.noise !== row.band.noise) {
      misses.push(`${row.id} judged ${hearing.voice}/${hearing.noise}`);
      continue;
    }
    const guarded = guardUtterance({
      memoryOps: row.proposed,
      summary: { text: row.summary, points: [row.summary] },
      transcript: row.transcript,
      hearing,
      index: row.index,
    });
    if (JSON.stringify(guarded.memory_ops) !== JSON.stringify(row.expected)) {
      misses.push(`${row.id}\n  heard ${row.transcript}\n  got ${JSON.stringify(guarded.memory_ops)}\n  want ${JSON.stringify(row.expected)}`);
    }
    const summaryKept = guarded.summary.text.length > 0;
    if (summaryKept !== (row.level <= 2)) misses.push(`${row.id} summary`);
  }
  assert.deepEqual(misses, []);
});

function scoreLevel(level: CorpusRow["level"]): {
  rows: number;
  modelMatched: number;
  guardMatched: number;
  keptOps: number;
  voice: string;
  noise: string;
} {
  const rows = CORPUS.filter((row) => row.level === level);
  let modelMatched = 0;
  let guardMatched = 0;
  let keptOps = 0;
  for (const row of rows) {
    if (JSON.stringify(row.proposed) === JSON.stringify(row.expected)) modelMatched += 1;
    const hearing = judgeHearing(row.band.clip, row.band.decoder);
    const guarded = guardUtterance({
      memoryOps: row.proposed,
      summary: { text: row.summary, points: [] },
      transcript: row.transcript,
      hearing,
      index: row.index,
    });
    if (JSON.stringify(guarded.memory_ops) === JSON.stringify(row.expected)) guardMatched += 1;
    keptOps += guarded.memory_ops.length;
  }
  const band = BANDS[level];
  const hearing = judgeHearing(band.clip, band.decoder);
  return { rows: rows.length, modelMatched, guardMatched, keptOps, voice: hearing.voice, noise: hearing.noise };
}
