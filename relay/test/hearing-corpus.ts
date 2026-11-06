// Graded transcripts. Level 0 is clean. Each step adds a deliberate error.
// The metadata is the band where a proposer stops matching the gold task:
// 0–2 it still does, 3 it copies stray nouns, 4–5 the task is gone.
// Bait words are appended at 4 and 5 so a merely noisy clip would store them.

import type { ClipAcoustics, DecoderHearing } from "../src/hearing.ts";
import type { MemoryOp, WorkingSet } from "../src/working-set.ts";

export const LEVELS = [0, 1, 2, 3, 4, 5] as const;
export type Level = (typeof LEVELS)[number];

const WHEN = 1729864200;

const BAIT: MemoryOp[] = [
  { op: "add_reminder", text: "Meet squirrel Thursday" },
  { op: "add_item", list: "open", text: "Send pigeon 5 USDC" },
];

const JUNK: MemoryOp[] = [
  { op: "add_item", list: "open", text: "blender squirrel" },
  { op: "add_item", list: "todo", text: "feed the pigeon" },
  { op: "add_reminder", text: "Meet Kenji Thursday blender squirrel" },
];

export interface HearingBand {
  level: Level;
  voice: "clear" | "unclear";
  noise: "low" | "high";
  clip: ClipAcoustics;
  decoder: DecoderHearing;
}

export const BANDS: HearingBand[] = [
  band(0, "clear", "low", 40, 70, 2800, 0, -0.12, 0.01, 1.15),
  band(1, "clear", "low", 14, 180, 2520, 0, -0.34, 0.04, 1.28),
  band(2, "clear", "low", 7.5, 320, 2400, 0.004, -0.55, 0.09, 1.55),
  band(3, "clear", "high", 3.4, 1100, 3740, 0.01, -0.68, 0.18, 1.9),
  band(4, "unclear", "high", 2.2, 1400, 3080, 0.02, -1.05, 0.28, 2.1),
  band(5, "unclear", "high", 1.15, 2000, 2300, 0.07, -1.75, 0.84, 3.3),
];

export interface CorpusRow {
  id: string;
  scene: string;
  level: Level;
  transcript: string;
  index: WorkingSet;
  /** What the proposer emits from this transcript. */
  proposed: MemoryOp[];
  /** What memory may keep. */
  expected: MemoryOp[];
  summary: string;
  band: HearingBand;
}

interface Scene {
  id: string;
  clean: string;
  index: WorkingSet;
  /** Kept while the proposer still matches, levels 0–2. */
  kept: MemoryOp[];
  /** Kept at level 3, once stray nouns are being copied. */
  noisyKept: MemoryOp[];
  junk: MemoryOp[];
  summary: string;
}

const kenjiOpen = memory(["Meet Kenji Thursday"], [
  ["open", "Send Kenji 5 USDC"],
  ["todo", "Pick up the dry cleaning"],
]);

const twoDebts = memory(["Meet Kenji Thursday"], [
  ["open", "Send Kenji 5 USDC"],
  ["open", "Send Mina 12 USDC"],
]);

const SCENES: Scene[] = [
  {
    id: "kenji-meeting-debt",
    clean: "I'll meet Kenji on Thursday. I still owe him 5 USDC.",
    index: memory([], []),
    kept: [
      { op: "add_reminder", text: "Meet Kenji Thursday" },
      { op: "add_item", list: "open", text: "Send Kenji 5 USDC" },
    ],
    noisyKept: [
      { op: "add_reminder", text: "Meet Kenji Thursday" },
      { op: "add_item", list: "open", text: "Send Kenji 5 USDC" },
    ],
    junk: JUNK,
    summary: "Kenji on Thursday, and 5 USDC still open.",
  },
  {
    id: "sara-monday",
    clean: "I'll meet Sara on Monday.",
    index: memory([], []),
    kept: [{ op: "add_reminder", text: "Meet Sara Monday" }],
    noisyKept: [{ op: "add_reminder", text: "Meet Sara Monday" }],
    junk: JUNK,
    summary: "Meet Sara on Monday.",
  },
  {
    id: "mina-debt",
    clean: "I still owe Mina 12 USDC.",
    index: memory([], []),
    kept: [{ op: "add_item", list: "open", text: "Send Mina 12 USDC" }],
    noisyKept: [{ op: "add_item", list: "open", text: "Send Mina 12 USDC" }],
    junk: JUNK,
    summary: "Owe Mina 12 USDC.",
  },
  {
    id: "priya-monday-dollars",
    clean: "I'll meet Priya on Monday. I still owe her 20 dollars.",
    index: memory([], []),
    kept: [
      { op: "add_reminder", text: "Meet Priya Monday" },
      { op: "add_item", list: "open", text: "Send Priya 20 dollars" },
    ],
    noisyKept: [
      { op: "add_reminder", text: "Meet Priya Monday" },
      { op: "add_item", list: "open", text: "Send Priya 20 dollars" },
    ],
    junk: JUNK,
    summary: "Priya on Monday, and 20 dollars still open.",
  },
  {
    id: "noor-tonight-eth",
    clean: "I'll meet Noor tonight. I still owe him 3 ETH.",
    index: memory([], []),
    kept: [
      { op: "add_reminder", text: "Meet Noor tonight" },
      { op: "add_item", list: "open", text: "Send Noor 3 ETH" },
    ],
    noisyKept: [
      { op: "add_reminder", text: "Meet Noor tonight" },
      { op: "add_item", list: "open", text: "Send Noor 3 ETH" },
    ],
    junk: JUNK,
    summary: "Noor tonight, and 3 ETH still open.",
  },
  {
    id: "luis-tomorrow-dentist",
    clean: "Call Luis tomorrow about the dentist.",
    index: memory([], []),
    kept: [
      { op: "add_reminder", text: "Call Luis tomorrow" },
      { op: "add_item", list: "todo", text: "Call the dentist" },
    ],
    noisyKept: [{ op: "add_reminder", text: "Call Luis tomorrow" }],
    junk: JUNK,
    summary: "Call Luis tomorrow, and call the dentist.",
  },
  {
    id: "landlord-tomorrow",
    clean: "Email the landlord tomorrow about the leak.",
    index: memory([], []),
    kept: [
      { op: "add_reminder", text: "Email landlord tomorrow" },
      { op: "add_item", list: "todo", text: "Email the landlord about the leak" },
    ],
    noisyKept: [{ op: "add_reminder", text: "Email landlord tomorrow" }],
    junk: JUNK,
    summary: "Email the landlord tomorrow.",
  },
  {
    id: "dry-cleaning-todo",
    clean: "I need to pick up the dry cleaning.",
    index: memory([], []),
    kept: [{ op: "add_item", list: "todo", text: "Pick up the dry cleaning" }],
    noisyKept: [],
    junk: JUNK,
    summary: "Pick up the dry cleaning.",
  },
  {
    id: "eight-usdc",
    clean: "I owe Luis 8 USDC for lunch.",
    index: memory([], []),
    kept: [{ op: "add_item", list: "open", text: "Send Luis 8 USDC" }],
    noisyKept: [{ op: "add_item", list: "open", text: "Send Luis 8 USDC" }],
    junk: JUNK,
    summary: "Owe Luis 8 USDC.",
  },
  {
    id: "close-kenji-debt",
    clean: "I sent Kenji the 5 USDC.",
    index: kenjiOpen,
    kept: [{ op: "close_item", text: "Send Kenji 5 USDC" }],
    noisyKept: [{ op: "close_item", text: "Send Kenji 5 USDC" }],
    junk: [
      { op: "close_reminder", text: "Meet Kenji Thursday" },
      { op: "close_item", text: "Pick up the dry cleaning" },
      ...JUNK,
    ],
    summary: "Sent Kenji the 5 USDC.",
  },
  {
    id: "close-dry-cleaning",
    clean: "I picked up the dry cleaning.",
    index: kenjiOpen,
    kept: [{ op: "close_item", text: "Pick up the dry cleaning" }],
    noisyKept: [{ op: "close_item", text: "Pick up the dry cleaning" }],
    junk: [{ op: "close_reminder", text: "Meet Kenji Thursday" }, ...JUNK],
    summary: "Picked up the dry cleaning.",
  },
  {
    id: "close-mina-not-kenji",
    clean: "I sent Mina the 12 USDC.",
    index: twoDebts,
    kept: [{ op: "close_item", text: "Send Mina 12 USDC" }],
    noisyKept: [{ op: "close_item", text: "Send Mina 12 USDC" }],
    junk: [{ op: "close_item", text: "Send Kenji 5 USDC" }, { op: "close_reminder", text: "Meet Kenji Thursday" }, ...JUNK],
    summary: "Sent Mina the 12 USDC.",
  },
  {
    id: "close-landlord",
    clean: "I finished the email to the landlord.",
    index: memory([], [["todo", "Email the landlord"]]),
    kept: [{ op: "close_item", text: "Email the landlord" }],
    noisyKept: [{ op: "close_item", text: "Email the landlord" }],
    junk: JUNK,
    summary: "Emailed the landlord.",
  },
  {
    id: "sara-while-kenji-open",
    clean: "I'll meet Sara on Monday.",
    index: kenjiOpen,
    kept: [{ op: "add_reminder", text: "Meet Sara Monday" }],
    noisyKept: [{ op: "add_reminder", text: "Meet Sara Monday" }],
    junk: [
      { op: "close_reminder", text: "Meet Kenji Thursday" },
      { op: "close_item", text: "Send Kenji 5 USDC" },
      ...JUNK,
    ],
    summary: "Meet Sara on Monday.",
  },
];

const SWAPS: Array<[RegExp, string]> = [
  [/\bKenji\b/gi, "Ken gee"],
  [/\bThursday\b/gi, "Thirsty"],
  [/\bFriday\b/gi, "Fryday"],
  [/\bMonday\b/gi, "Munday"],
  [/\bMina\b/gi, "Meena"],
  [/\bPriya\b/gi, "Preeya"],
  [/\bLuis\b/gi, "Luise"],
  [/\bNoor\b/gi, "Nur"],
  [/\btomorrow\b/gi, "tommorow"],
  [/\bdentist\b/gi, "dentest"],
  [/\blandlord\b/gi, "landlort"],
  [/\bemail\b/gi, "emale"],
  [/\bcleaning\b/gi, "cleanin"],
];

const DESTROY: Array<[RegExp, string]> = [
  [/\bKenji\b/gi, "Ketchup"],
  [/\bThursday\b/gi, "blurstday"],
  [/\bFriday\b/gi, "zonday"],
  [/\bMonday\b/gi, "narpday"],
  [/\btomorrow\b/gi, "glornday"],
  [/\btonight\b/gi, "snarnight"],
  [/\bMina\b/gi, "Quorra"],
  [/\bPriya\b/gi, "Zal"],
  [/\bLuis\b/gi, "Blox"],
  [/\bNoor\b/gi, "Vek"],
  [/\bSara\b/gi, "Plim"],
  [/\bUSDC\b/gi, "blorpx"],
  [/\bdollars\b/gi, "widgets"],
  [/\bETH\b/gi, "marn"],
  [/\b12\b/g, "splog"],
  [/\b20\b/g, "marn"],
  [/\b8\b/g, "splog"],
  [/\b5\b/g, "fire"],
  [/\b3\b/g, "qq"],
  [/\bdry\b/gi, "snork"],
  [/\bcleaning\b/gi, "wibble"],
  [/\blandlord\b/gi, "quench"],
  [/\bleak\b/gi, "plorb"],
  [/\bdentist\b/gi, "yorb"],
  [/\bsent\b/gi, "yorb"],
  [/\bpicked\b/gi, "trenz"],
  [/\bmeet\b/gi, "glarp"],
  [/\bowe\b/gi, "snarf"],
  [/\bemail\b/gi, "brack"],
  [/\bCall\b/g, "Snizz"],
  [/\bcall\b/g, "snizz"],
];

export const CORPUS: CorpusRow[] = SCENES.flatMap((scene) =>
  LEVELS.map((level) => {
    const band = BANDS[level];
    const recoverable = level <= 2;
    return {
      id: `${scene.id}-l${level}`,
      scene: scene.id,
      level,
      transcript: degrade(scene.clean, level),
      index: scene.index,
      proposed: recoverable ? scene.kept : level === 3 ? [...scene.kept, ...scene.junk] : [...BAIT, ...scene.kept],
      expected: recoverable ? scene.kept : level === 3 ? scene.noisyKept : [],
      summary: scene.summary,
      band,
    };
  }),
);

export function degrade(clean: string, level: Level): string {
  if (level === 0) return clean;
  if (level === 1) return replace(clean, SWAPS);
  if (level === 2) return sprinkle(clean, ["uh", "like", "anyway"]);
  if (level === 3) return replace(sprinkle(sprinkle(clean, ["uh", "like"]), ["blender", "squirrel", "coffee", "pigeon"]), SWAPS);
  const bait = "squirrel Thursday 5 USDC pigeon";
  const broken = replace(clean, DESTROY);
  if (level === 4) return `${broken} ${bait}`;
  return `${broken} zzz nnn quenda the the xx ??? ${bait}`;
}

function band(
  level: Level,
  voice: HearingBand["voice"],
  noise: HearingBand["noise"],
  speechRatio: number,
  room: number,
  speech: number,
  clipped: number,
  avgLogprob: number,
  noSpeech: number,
  compression: number,
): HearingBand {
  return {
    level,
    voice,
    noise,
    clip: {
      measured: true,
      level: Math.round((room + speech) / 2),
      room,
      speech,
      speech_ratio: speechRatio,
      clipped,
    },
    decoder: { avg_logprob: avgLogprob, no_speech_prob: noSpeech, compression_ratio: compression },
  };
}

function memory(reminders: string[], items: Array<[string, string]>): WorkingSet {
  return {
    version: "2.0",
    reminders: reminders.map((text) => ({ text, mentioned_at: WHEN })),
    items: items.map(([list, text]) => ({ list, text, updated_at: WHEN })),
  };
}

function replace(text: string, swaps: Array<[RegExp, string]>): string {
  return swaps.reduce((current, [pattern, next]) => current.replace(pattern, next), text);
}

function sprinkle(text: string, words: string[]): string {
  const parts = text.split(/(\s+)/);
  let wordsSeen = 0;
  let cursor = 0;
  const out: string[] = [];
  for (const part of parts) {
    out.push(part);
    if (!/^[A-Za-z0-9']+$/.test(part)) continue;
    wordsSeen += 1;
    if (wordsSeen % 4 !== 0) continue;
    out.push(` ${words[cursor % words.length]}`);
    cursor += 1;
  }
  return out.join("");
}
