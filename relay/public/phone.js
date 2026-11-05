const STEP = {
  transcribe: "Transcription",
  reason: "Reasoning",
};

export function formatWhen(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function timeStamp(unixSeconds) {
  const time = document.createElement("time");
  time.className = "when";
  const date = new Date(unixSeconds * 1000);
  if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString();
  time.textContent = formatWhen(unixSeconds);
  return time;
}

function fillList(list, empty, rows, paint) {
  list.replaceChildren();
  empty.hidden = rows.length > 0;
  for (const row of rows) list.append(paint(row));
}

export function renderCompanion(root, index) {
  const reminders = root.querySelector("#reminders");
  const remindersEmpty = root.querySelector("#reminders-empty");
  const items = root.querySelector("#items");
  const itemsEmpty = root.querySelector("#items-empty");
  fillList(reminders, remindersEmpty, index?.reminders ?? [], (row) => {
    const item = document.createElement("li");
    const text = document.createElement("p");
    text.className = "reminder-text";
    text.textContent = row.text;
    item.append(text, timeStamp(row.mentioned_at));
    return item;
  });
  fillList(items, itemsEmpty, index?.items ?? [], (row) => {
    const item = document.createElement("li");
    const text = document.createElement("p");
    text.className = "item-text";
    text.textContent = row.text;
    item.append(text, timeStamp(row.updated_at));
    if (row.list && row.list !== "open") {
      const list = document.createElement("span");
      list.className = "item-list";
      list.textContent = row.list;
      item.append(list);
    }
    return item;
  });
}

export async function loadCompanion(root, fetchImpl = fetch) {
  try {
    const response = await fetchImpl("/companion");
    if (!response.ok) {
      renderCompanion(root, { reminders: [], items: [] });
      return;
    }
    renderCompanion(root, await response.json());
  } catch {
    renderCompanion(root, { reminders: [], items: [] });
  }
}

export function renderPhone(root, state) {
  const liveSection = root.querySelector("#live-section");
  const liveList = root.querySelector("#live");
  const liveEmpty = root.querySelector("#live-empty");
  const traces = root.querySelector("#traces");
  const tracesEmpty = root.querySelector("#traces-empty");
  const status = root.querySelector("#link-status");

  if (!state) {
    liveList.replaceChildren();
    traces.replaceChildren();
    tracesEmpty.hidden = true;
    liveSection.hidden = true;
    status.textContent = "";
    status.replaceChildren();
    const note = document.createElement("p");
    note.className = "offline";
    note.textContent = "The phone page is disconnected.";
    status.append(note);
    return;
  }

  status.replaceChildren();
  const lines = Array.isArray(state.live_lines) ? state.live_lines : [];
  const showLive = state.mode === "live";
  liveSection.hidden = !showLive;
  fillList(liveList, liveEmpty, lines, (row) => {
    const item = document.createElement("li");
    const transcript = document.createElement("p");
    transcript.className = "transcript";
    transcript.textContent = row.transcript;
    const translation = document.createElement("p");
    translation.className = "translation";
    translation.textContent = row.translation;
    item.append(transcript, translation);
    return item;
  });
  if (!showLive) liveEmpty.hidden = true;

  const verified = (Array.isArray(state.traces) ? state.traces : []).filter((row) => row.tee_verified === true);
  fillList(traces, tracesEmpty, verified, (trace) => {
    const item = document.createElement("li");
    item.className = "trace";
    const head = document.createElement("p");
    head.className = "trace-head";
    const step = document.createElement("span");
    step.className = "step";
    step.textContent = STEP[trace.step] ?? trace.step;
    const verdict = document.createElement("span");
    verdict.className = "status";
    verdict.dataset.verified = "true";
    verdict.textContent = "Verified";
    head.append(step, verdict);
    const model = document.createElement("p");
    model.className = "model";
    model.textContent = trace.model;
    const request = document.createElement("p");
    request.className = "request";
    request.textContent = trace.request_id;
    const provider = document.createElement("p");
    provider.className = "provider";
    provider.textContent = trace.provider;
    item.append(head, model, request, provider);
    return item;
  });
}

const root = typeof document === "undefined" ? null : document.querySelector("main.phone");
if (root) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}/phone`);
  socket.addEventListener("open", () => {
    void loadCompanion(root);
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data);
    if (message.type !== "phone") return;
    renderPhone(root, message);
  });
  socket.addEventListener("close", () => renderPhone(root, null));
}
