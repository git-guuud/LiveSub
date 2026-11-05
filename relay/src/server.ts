import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { clipDurationSec } from "./episode.ts";
import { parseClientEvent } from "./protocol.ts";
import { createChatModelMemory, reasonUtterance, type ChatModelMemory } from "./reason.ts";
import { Session } from "./session.ts";
import type { BackgroundLog } from "./storage.ts";
import { transcribeClip } from "./transcribe.ts";

const PUBLIC_FILES = new Map<string, string>([
  ["/", "stand-in.html"],
  ["/stand-in.html", "stand-in.html"],
  ["/stand-in.css", "stand-in.css"],
  ["/stand-in.js", "stand-in.js"],
  ["/screen.js", "screen.js"],
  ["/phone", "phone.html"],
  ["/phone.html", "phone.html"],
  ["/phone.css", "phone.css"],
  ["/phone.js", "phone.js"],
]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

export interface Relay {
  server: http.Server;
  session: Session;
  /** Private chat model recorded after the first successful reason call. */
  chatModel(): string | null;
  close(): Promise<void>;
}

export interface RelayOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Test override. Production picks from the live catalog. */
  chatModel?: string;
  /** 0G log and KV. Unset until the storage key and stream are configured. */
  log?: BackgroundLog;
}

export function createRelay(publicDir = defaultPublicDir(), options: RelayOptions = {}): Relay {
  const session = new Session();
  if (options.log) session.setStore(options.log);
  const apiKey = options.apiKey;
  const chatMemory: ChatModelMemory = createChatModelMemory();
  const clients = new Set<WebSocket>();
  const phones = new Set<WebSocket>();

  function send(ws: WebSocket, message: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function broadcastScreen(): void {
    const payload = JSON.stringify(session.screen());
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  function broadcastPhone(): void {
    const payload = JSON.stringify(session.phone());
    for (const ws of phones) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  session.setScreenListener(broadcastScreen);
  session.setPhoneListener(broadcastPhone);

  const server = http.createServer(async (req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    if (url === "/companion") {
      const view = await session.readCompanion();
      const body = JSON.stringify({ reminders: view.reminders, items: view.items });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(body);
      return;
    }
    const name = PUBLIC_FILES.get(url);
    if (!name) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const filePath = path.join(publicDir, name);
    const body = fs.readFileSync(filePath);
    res.writeHead(200, { "content-type": MIME[path.extname(name)] ?? "application/octet-stream" });
    res.end(body);
  });

  const wss = new WebSocketServer({ noServer: true });
  const phoneWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url?.split("?")[0] ?? "";
    const target = url === "/ws" ? wss : url === "/phone" ? phoneWss : null;
    if (!target) {
      socket.destroy();
      return;
    }
    target.handleUpgrade(req, socket, head, (ws) => {
      target.emit("connection", ws, req);
    });
  });

  phoneWss.on("connection", (ws) => {
    phones.add(ws);
    const already = session.phoneLinked();
    session.setPhoneLinked(true);
    if (already) send(ws, session.phone());
    ws.on("close", () => {
      phones.delete(ws);
      session.setPhoneLinked(phones.size > 0);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    const already = session.relayLinked();
    session.setRelayLinked(true);
    if (already) send(ws, session.screen());

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const result = session.acceptChunk(toBytes(data));
        if (!result.ok) {
          send(ws, { type: "reject", reason: result.reason });
          return;
        }
        if (!apiKey) return;
        const clip = session.takeClip();
        if (clip) void processClip(clip);
        return;
      }
      const parsed = parseClientEvent(toText(data));
      if ("error" in parsed) {
        send(ws, { type: "reject", reason: parsed.error });
        return;
      }
      const result = session.handle(parsed);
      if (!result.ok) send(ws, { type: "reject", reason: result.reason });
    });

    ws.on("close", () => {
      clients.delete(ws);
      session.setRelayLinked(clients.size > 0);
    });
  });

  async function processClip(clip: Uint8Array): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000);
    const mode = session.capturedMode();
    const audioDurationSec = clipDurationSec(clip);
    const index = session.workingSet();
    const transcribed = await transcribeClip(clip, { apiKey, fetchImpl: options.fetchImpl });
    session.acceptTranscribe(transcribed);
    if (!transcribed.ok || session.screen().face === "locked") return;
    const reasoned = await reasonUtterance(transcribed.text, {
      apiKey,
      fetchImpl: options.fetchImpl,
      model: options.chatModel,
      record: chatMemory,
      timestamp,
      mode,
      index,
    });
    session.acceptReason(reasoned, timestamp, { mode, audioDurationSec });
  }

  return {
    server,
    session,
    chatModel: () => chatMemory.model?.id ?? null,
    close() {
      for (const ws of clients) ws.close();
      for (const ws of phones) ws.close();
      wss.close();
      phoneWss.close();
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function toBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data);
}

function toText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function defaultPublicDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");
}
