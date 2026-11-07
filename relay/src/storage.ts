// Encrypted utterance log and the open-item index. The AES key stays on the relay.
// The live line does not await the network write.
// The index blob is what the companion view reads back. A version 1.0 payload is empty.

import fs from "node:fs";
import path from "node:path";
import { MemData, Proof } from "@0gfoundation/0g-storage-ts-sdk";
import { parseUtterance, utteranceBytes, type Utterance } from "./episode.ts";
import { createStorageKey, open, seal } from "./seal.ts";
import { emptyWorkingSet, workingSetFromStored, type WorkingSet } from "./working-set.ts";

export interface PreparedUtterance {
  root: string;
  cipher: Uint8Array;
}

export interface BackgroundLog {
  /** Local Merkle root of the sealed utterance. Does not upload. */
  prepareUtterance(utterance: Utterance): Promise<PreparedUtterance>;
  /**
   * Upload the sealed utterance, then the open-item index.
   * `openItems` is read when the write runs, so a newer utterance is not overwritten by an older snapshot.
   */
  writeUtterance(root: string, cipher: Uint8Array, openItems: () => WorkingSet): Promise<void>;
  /** Null when the blob is missing, the proof fails, or the payload is not version 2.0. */
  readUtterance(root: string): Promise<Utterance | null>;
  /** Seal the open items and store them behind a proof-checked blob. */
  writeCompanion(index: WorkingSet): Promise<void>;
  /** Decrypt the open items. An absent index, a version 1.0 payload, or a failed proof is empty. */
  readCompanion(): Promise<WorkingSet>;
}

/** Log blob plus the mutable index. Implementations talk to 0G, or to an in-process stand-in of that network. */
export interface OgNetwork {
  merkleRoot(bytes: Uint8Array): Promise<string>;
  putBlob(root: string, bytes: Uint8Array): Promise<void>;
  /** Null when proof verification fails or the root is unknown. */
  getBlob(root: string): Promise<Uint8Array | null>;
  putIndex(bytes: Uint8Array): Promise<void>;
  getIndex(): Promise<Uint8Array | null>;
}

const KEY_FILE = "aes.key";

export class CipherLog implements BackgroundLog {
  readonly #key: Uint8Array;
  readonly #network: OgNetwork;
  #tail: Promise<void> = Promise.resolve();

  constructor(key: Uint8Array, network: OgNetwork) {
    this.#key = key;
    this.#network = network;
  }

  async prepareUtterance(utterance: Utterance): Promise<PreparedUtterance> {
    const cipher = seal(this.#key, utteranceBytes(utterance));
    const root = await this.#network.merkleRoot(cipher);
    return { root, cipher };
  }

  writeUtterance(root: string, cipher: Uint8Array, openItems: () => WorkingSet): Promise<void> {
    return this.#enqueue(async () => {
      await this.#network.putBlob(root, cipher);
      await this.#putOpenItems(openItems());
    });
  }

  async readUtterance(root: string): Promise<Utterance | null> {
    try {
      const bytes = await this.#network.getBlob(root);
      if (!bytes) return null;
      return parseUtterance(open(this.#key, bytes));
    } catch {
      return null;
    }
  }

  writeCompanion(index: WorkingSet): Promise<void> {
    const snapshot = workingSetFromStored(index);
    return this.#enqueue(() => this.#putOpenItems(snapshot));
  }

  async readCompanion(): Promise<WorkingSet> {
    const pointerBytes = await this.#network.getIndex();
    if (!pointerBytes) return emptyWorkingSet();
    let pointer: unknown;
    try {
      pointer = JSON.parse(new TextDecoder().decode(open(this.#key, pointerBytes)));
    } catch {
      return emptyWorkingSet();
    }
    if (pointer === null || typeof pointer !== "object" || Array.isArray(pointer)) return emptyWorkingSet();
    const record = pointer as { version?: unknown; root?: unknown };
    if (record.version !== "2.0" || typeof record.root !== "string") return emptyWorkingSet();
    const cipher = await this.#network.getBlob(record.root);
    if (!cipher) return emptyWorkingSet();
    try {
      return workingSetFromStored(JSON.parse(new TextDecoder().decode(open(this.#key, cipher))));
    } catch {
      return emptyWorkingSet();
    }
  }

  async #putOpenItems(index: WorkingSet): Promise<void> {
    const cipher = seal(this.#key, new TextEncoder().encode(JSON.stringify(indexDocument(index))));
    const root = await this.#network.merkleRoot(cipher);
    await this.#network.putBlob(root, cipher);
    const pointer = seal(
      this.#key,
      new TextEncoder().encode(JSON.stringify({ version: "2.0", root })),
    );
    await this.#network.putIndex(pointer);
  }

  #enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(job, job);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

interface StoredBlob {
  bytes: Uint8Array;
  leafHash: string;
  leafCount: number;
  proof: Proof;
}

/**
 * In-process log and KV for tests. The root and the proof check are the 0G SDK's.
 * A damaged proof is refused and the ciphertext is not returned.
 */
export class InMemoryOg implements OgNetwork {
  readonly #blobs = new Map<string, StoredBlob>();
  #index: Uint8Array | null = null;
  #damageProof = false;

  damageProof(): void {
    this.#damageProof = true;
  }

  /** Drop the KV value. Log blobs stay. The next load sees an absent index. */
  forgetIndex(): void {
    this.#index = null;
  }

  async merkleRoot(bytes: Uint8Array): Promise<string> {
    return (await treeFor(bytes)).root;
  }

  async putBlob(root: string, bytes: Uint8Array): Promise<void> {
    const tree = await treeFor(bytes);
    if (tree.root !== root) throw new Error("root_mismatch");
    this.#blobs.set(root, {
      bytes,
      leafHash: tree.leafHash,
      leafCount: tree.leafCount,
      proof: tree.proof,
    });
  }

  async getBlob(root: string): Promise<Uint8Array | null> {
    const stored = this.#blobs.get(root);
    if (!stored) return null;
    const proof = new Proof([...stored.proof.lemma], [...stored.proof.path]);
    if (this.#damageProof && proof.lemma.length > 0) {
      proof.lemma[0] = `0x${"00".repeat(32)}`;
    }
    const error = proof.validateHash(root, stored.leafHash, 0, stored.leafCount);
    if (error) return null;
    const again = await this.merkleRoot(stored.bytes);
    if (again !== root) return null;
    return stored.bytes;
  }

  async putIndex(bytes: Uint8Array): Promise<void> {
    this.#index = bytes;
  }

  async getIndex(): Promise<Uint8Array | null> {
    return this.#index ? new Uint8Array(this.#index) : null;
  }
}

export async function merkleRootOf(bytes: Uint8Array): Promise<string> {
  return (await treeFor(bytes)).root;
}

async function treeFor(bytes: Uint8Array): Promise<{
  root: string;
  leafHash: string;
  leafCount: number;
  proof: Proof;
}> {
  const file = new MemData(bytes);
  const [tree, err] = await file.merkleTree();
  if (err || !tree) throw err ?? new Error("merkle");
  const root = tree.rootHash();
  const leaf = tree.leaves[0];
  if (!root || !leaf) throw new Error("merkle");
  return { root, leafHash: leaf.hash, leafCount: tree.leaves.length, proof: tree.proofAt(0) };
}

/** Key file lives on the relay. It is not uploaded. */
export function loadOrCreateKey(keyPath: string): Uint8Array {
  if (fs.existsSync(keyPath)) {
    const existing = fs.readFileSync(keyPath);
    if (existing.byteLength !== 32) throw new Error("bad_key");
    return new Uint8Array(existing);
  }
  const key = createStorageKey();
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

export function aesKeyPath(dataDir: string): string {
  return path.join(dataDir, KEY_FILE);
}

function indexDocument(index: WorkingSet): {
  version: "2.0";
  reminders: Array<{ text: string; mentioned_at: number; episode_root?: string }>;
  lists: Array<{ list: string; text: string; updated_at: number; episode_root?: string }>;
  summary?: { text: string; points: string[]; mentioned_at: number; episode_root?: string };
  badge_name?: string;
} {
  const summary = index.summary;
  return {
    version: "2.0",
    reminders: index.reminders.map((row) => withRoot({ text: row.text, mentioned_at: row.mentioned_at }, row.episode_root)),
    lists: index.items.map((row) =>
      withRoot({ list: row.list, text: row.text, updated_at: row.updated_at }, row.episode_root),
    ),
    ...(summary
      ? {
          summary: withRoot(
            { text: summary.text, points: [...summary.points], mentioned_at: summary.mentioned_at },
            summary.episode_root,
          ),
        }
      : {}),
    ...(index.badge_name ? { badge_name: index.badge_name } : {}),
  };
}

function withRoot<T extends object>(row: T, root: string | undefined): T & { episode_root?: string } {
  if (!root) return row;
  return { ...row, episode_root: root };
}
