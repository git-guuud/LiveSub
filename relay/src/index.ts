import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay } from "./server.ts";
import { aesKeyPath, CipherLog, loadOrCreateKey } from "./storage.ts";
import { galileoTransport, storageEndpoints, ZeroGNetwork } from "./zerog.ts";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const dataDir =
  process.env.LIVESUB_DATA ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../data");
const privateKey = process.env.OG_STORAGE_PRIVATE_KEY;
const streamId = process.env.OG_KV_STREAM_ID;
const kvNodeUrl = process.env.OG_KV_NODE;
const log =
  privateKey && streamId && kvNodeUrl
    ? new CipherLog(
        loadOrCreateKey(aesKeyPath(dataDir)),
        new ZeroGNetwork(galileoTransport({ privateKey, streamId, kvNodeUrl, ...storageEndpoints(process.env.OG_STORAGE_NETWORK) })),
      )
    : undefined;
const relay = createRelay(undefined, {
  apiKey: process.env.OG_API_KEY,
  log,
  badgeName: process.env.LIVESUB_BADGE_NAME,
});
await relay.session.loadMemory();

relay.server.listen(port, host, () => {
  console.log(`LiveSub relay http://${host}:${port}`);
});
