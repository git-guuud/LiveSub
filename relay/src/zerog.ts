// 0G Storage log (immutable episode blob, Merkle root, download with proof)
// and KV (mutable encrypted index). Galileo testnet. The AES key never goes up.

import { Indexer, Batcher, KvClient, MemData, getFlowContract } from "@0gfoundation/0g-storage-ts-sdk";
import { JsonRpcProvider, Wallet, decodeBase64 } from "ethers";
import { merkleRootOf, type OgNetwork } from "./storage.ts";

export const GALILEO_RPC = "https://evmrpc-testnet.0g.ai";
export const GALILEO_INDEXER = "https://indexer-storage-testnet-turbo.0g.ai";
export const GALILEO_FLOW = "0x22E03a6A89B950F1c82ec5e74F8eCa321a105296";
export const INDEX_KEY = "livesub.index";

export interface ZeroGConfig {
  privateKey: string;
  streamId: string;
  kvNodeUrl: string;
  rpcUrl?: string;
  indexerUrl?: string;
  flowAddress?: string;
}

/** Upload and proof-checked download. A proof error returns null and no bytes. */
export interface LogTransport {
  upload(bytes: Uint8Array): Promise<string>;
  download(root: string): Promise<Uint8Array | null>;
  putIndex(bytes: Uint8Array): Promise<void>;
  getIndex(): Promise<Uint8Array | null>;
}

export class ZeroGNetwork implements OgNetwork {
  readonly #transport: LogTransport;

  constructor(transport: LogTransport) {
    this.#transport = transport;
  }

  merkleRoot(bytes: Uint8Array): Promise<string> {
    return merkleRootOf(bytes);
  }

  async putBlob(root: string, bytes: Uint8Array): Promise<void> {
    const uploaded = await this.#transport.upload(bytes);
    if (uploaded.toLowerCase() !== root.toLowerCase()) throw new Error("root_mismatch");
  }

  getBlob(root: string): Promise<Uint8Array | null> {
    return this.#transport.download(root);
  }

  putIndex(bytes: Uint8Array): Promise<void> {
    return this.#transport.putIndex(bytes);
  }

  getIndex(): Promise<Uint8Array | null> {
    return this.#transport.getIndex();
  }
}

export function galileoTransport(config: ZeroGConfig): LogTransport {
  const rpcUrl = config.rpcUrl ?? GALILEO_RPC;
  const indexer = new Indexer(config.indexerUrl ?? GALILEO_INDEXER);
  const signer = new Wallet(config.privateKey, new JsonRpcProvider(rpcUrl));
  const flowAddress = config.flowAddress ?? GALILEO_FLOW;
  const kv = new KvClient(config.kvNodeUrl);
  const keyBytes = new TextEncoder().encode(INDEX_KEY);

  return {
    async upload(bytes) {
      const file = new MemData(bytes);
      const [tree, treeErr] = await file.merkleTree();
      if (treeErr || !tree?.rootHash()) throw treeErr ?? new Error("merkle");
      const [tx, err] = await indexer.upload(file, rpcUrl, signer);
      if (err || !tx || !("rootHash" in tx)) throw err ?? new Error("upload");
      return tx.rootHash;
    },
    download(root) {
      return downloadWithProof(indexer, root);
    },
    async putIndex(bytes) {
      const [nodes, err] = await indexer.selectNodes(1);
      if (err || !nodes || nodes.length === 0) throw err ?? new Error("no_node");
      const flow = getFlowContract(flowAddress, signer);
      const batcher = new Batcher(1, nodes, flow, rpcUrl);
      batcher.streamDataBuilder.set(config.streamId, keyBytes, bytes);
      const [, batchErr] = await batcher.exec();
      if (batchErr) throw batchErr;
    },
    async getIndex() {
      const value = await kv.getValue(config.streamId, keyBytes);
      if (!value?.data) return null;
      return decodeBase64(value.data);
    },
  };
}

export async function downloadWithProof(
  indexer: {
    downloadToBlob(root: string, opts: { proof: true }): Promise<[Blob | null, Error | null]>;
  },
  root: string,
): Promise<Uint8Array | null> {
  const [blob, err] = await indexer.downloadToBlob(root, { proof: true });
  if (err || !blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}
