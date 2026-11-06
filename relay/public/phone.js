import { reasonText, renderGlass } from "./screen.js";
import {
  createSpeechGate,
  encodeWav,
  floatToInt16,
  phoneIsBadge,
  resampleLinear,
} from "./phone-mic.js";

const STEP = {
  transcribe: "Transcription",
  reason: "Reasoning",
};

const ICONS = {
  edit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L18 10l-4-4L4 16v4z"/><path d="M13 7l4 4"/></svg>',
  dismiss: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  save: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
  cancel: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
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

function iconButton(name, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon ${name}`;
  button.setAttribute("aria-label", label);
  button.innerHTML = ICONS[name];
  return button;
}

function fillList(list, empty, rows, paint) {
  list.replaceChildren();
  empty.hidden = rows.length > 0;
  for (const row of rows) list.append(paint(row));
}

function setCount(root, id, count) {
  const badge = root.querySelector(id);
  if (!badge) return;
  badge.hidden = count === 0;
  badge.textContent = String(count);
}

function badgeLabel(index) {
  const name = typeof index?.badge_name === "string" ? index.badge_name.trim() : "";
  return name || "seer";
}

function paintBadgeName(root, index) {
  const input = root.querySelector("#badge-name-input");
  const spoken = root.querySelector("#badge-name-spoken");
  if (!input && !spoken) return;
  const label = badgeLabel(index);
  const editing = root.ownerDocument?.activeElement === input;
  if (input && !editing) input.value = label;
  if (spoken && !editing) spoken.textContent = label;
}

export async function submitBadgeName(root, fetchImpl = fetch) {
  const input = root.querySelector("#badge-name-input");
  const note = root.querySelector("#badge-name-note");
  if (!input) return;
  if (note) {
    note.hidden = true;
    note.textContent = "";
  }
  try {
    const response = await fetchImpl("/companion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rename_badge", name: input.value.trim() }),
    });
    if (!response.ok) {
      if (note) {
        note.hidden = false;
        note.textContent = "Use letters and numbers, up to 24 characters.";
      }
      return;
    }
    renderCompanion(root, await response.json());
  } catch {
    if (note) {
      note.hidden = false;
      note.textContent = "Could not save.";
    }
  }
}

export function renderCompanion(root, index) {
  paintBadgeName(root, index);
  const reminders = root.querySelector("#reminders");
  const remindersEmpty = root.querySelector("#reminders-empty");
  const items = root.querySelector("#items");
  const itemsEmpty = root.querySelector("#items-empty");
  const reminderRows = index?.reminders ?? [];
  const itemRows = index?.items ?? [];
  setCount(root, "#reminders-count", reminderRows.length);
  setCount(root, "#items-count", itemRows.length);
  fillList(reminders, remindersEmpty, reminderRows, (row) => {
    const item = document.createElement("li");
    item.dataset.kind = "reminder";
    item.dataset.text = row.text;
    const body = document.createElement("div");
    body.className = "row-body";
    const text = document.createElement("p");
    text.className = "reminder-text";
    text.textContent = row.text;
    body.append(text, timeStamp(row.mentioned_at));
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(iconButton("edit", "Edit reminder"), iconButton("dismiss", "Dismiss reminder"));
    const rowEl = document.createElement("div");
    rowEl.className = "row";
    rowEl.append(body, actions);
    item.append(rowEl);
    return item;
  });
  fillList(items, itemsEmpty, itemRows, (row) => {
    const item = document.createElement("li");
    item.dataset.kind = "item";
    item.dataset.text = row.text;
    item.dataset.list = row.list;
    const body = document.createElement("div");
    body.className = "row-body";
    const label = listLabel(row.list);
    if (label) {
      const list = document.createElement("span");
      list.className = "item-list";
      list.textContent = label;
      body.append(list);
    }
    const text = document.createElement("p");
    text.className = "item-text";
    text.textContent = row.text;
    body.append(text, timeStamp(row.updated_at));
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(iconButton("edit", "Edit item"), iconButton("dismiss", "Dismiss item"));
    const rowEl = document.createElement("div");
    rowEl.className = "row";
    rowEl.append(body, actions);
    item.append(rowEl);
    return item;
  });
  const summaryEmpty = root.querySelector("#summary-empty");
  const summaryText = root.querySelector("#summary-text");
  const summaryPoints = root.querySelector("#summary-points");
  if (!summaryEmpty || !summaryText || !summaryPoints) return;
  const summary = index?.summary;
  const text = typeof summary?.text === "string" ? summary.text.trim() : "";
  const points = Array.isArray(summary?.points) ? summary.points.filter((point) => typeof point === "string" && point.trim()) : [];
  const has = text.length > 0 || points.length > 0;
  summaryEmpty.hidden = has;
  summaryText.hidden = text.length === 0;
  summaryText.textContent = text;
  const panel = root.querySelector("#summary-panel");
  if (panel) panel.hidden = !has;
  summaryPoints.replaceChildren();
  for (const point of points) {
    const item = document.createElement("li");
    item.className = "point";
    item.textContent = point.trim();
    summaryPoints.append(item);
  }
}

function listLabel(name) {
  if (!name || name === "open") return "";
  if (name === "todo") return "To-do";
  if (name === "important") return "Important";
  return name;
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
    item.append(transcript);
    if (row.translation) {
      const translation = document.createElement("p");
      translation.className = "translation";
      translation.textContent = row.translation;
      item.append(translation);
    }
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

function startEdit(li) {
  if (li.querySelector(".edit-text")) return;
  const textEl = li.querySelector(".reminder-text, .item-text");
  if (!textEl) return;
  const input = document.createElement("input");
  input.className = "edit-text";
  input.type = "text";
  input.maxLength = 240;
  input.value = li.dataset.text ?? "";
  input.setAttribute("aria-label", "Wording");
  textEl.replaceWith(input);
  const actions = li.querySelector(".row-actions");
  const kind = li.dataset.kind === "item" ? "item" : "reminder";
  actions.replaceChildren(iconButton("save", `Save ${kind}`), iconButton("cancel", "Cancel"));
  input.focus();
}

function cancelEdit(li) {
  const text = li.dataset.text ?? "";
  const input = li.querySelector(".edit-text");
  if (!input) return;
  const paragraph = document.createElement("p");
  paragraph.className = li.dataset.kind === "item" ? "item-text" : "reminder-text";
  paragraph.textContent = text;
  input.replaceWith(paragraph);
  const actions = li.querySelector(".row-actions");
  const kind = li.dataset.kind === "item" ? "item" : "reminder";
  actions.replaceChildren(
    iconButton("edit", `Edit ${kind}`),
    iconButton("dismiss", `Dismiss ${kind}`),
  );
  li.querySelector(".revise-note")?.remove();
}

function showNote(li, message) {
  let note = li.querySelector(".revise-note");
  if (!note) {
    note = document.createElement("p");
    note.className = "revise-note";
    note.setAttribute("role", "status");
    li.querySelector(".row-body")?.append(note);
  }
  note.textContent = message;
}

async function postRevision(root, li, body) {
  li.dataset.saving = "true";
  try {
    const response = await fetch("/companion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      showNote(li, "Already open.");
      return;
    }
    renderCompanion(root, await response.json());
  } catch {
    showNote(li, "Could not save.");
  } finally {
    delete li.dataset.saving;
  }
}

function commitEdit(root, li) {
  if (li.dataset.saving === "true") return;
  const input = li.querySelector(".edit-text");
  if (!input) return;
  const next = input.value.trim();
  const text = li.dataset.text ?? "";
  if (!next || next === text) {
    cancelEdit(li);
    return;
  }
  const body = li.dataset.kind === "item"
    ? { action: "edit_item", list: li.dataset.list ?? "", text, next }
    : { action: "edit_reminder", text, next };
  void postRevision(root, li, body);
}

function dismissRow(root, li) {
  if (li.dataset.saving === "true") return;
  const text = li.dataset.text ?? "";
  const body = li.dataset.kind === "item"
    ? { action: "close_item", list: li.dataset.list ?? "", text }
    : { action: "close_reminder", text };
  void postRevision(root, li, body);
}

const root = typeof document === "undefined" ? null : document.querySelector("main.phone");
if (root) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}/phone`);
  let companionRefresh = 0;
  function refreshCompanion() {
    const token = ++companionRefresh;
    for (const delay of [0, 800, 2500, 8000]) {
      setTimeout(() => {
        if (token === companionRefresh) void loadCompanion(root);
      }, delay);
    }
  }
  socket.addEventListener("open", () => {
    refreshCompanion();
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data);
    if (message.type !== "phone") return;
    renderPhone(root, message);
    refreshCompanion();
    const note = root.querySelector("#note");
    if (note && (message.live_lines?.length ?? 0) > 0 && note.textContent === "The relay has this clip.") {
      note.textContent = "";
    }
  });
  socket.addEventListener("close", () => renderPhone(root, null));
  wireBadge(root, proto);
  root.querySelector("#badge-name")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitBadgeName(root);
  });
  root.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (!button || !root.contains(button)) return;
    const li = button.closest("li");
    if (!li) return;
    if (button.classList.contains("edit")) startEdit(li);
    else if (button.classList.contains("cancel")) cancelEdit(li);
    else if (button.classList.contains("save")) commitEdit(root, li);
    else if (button.classList.contains("dismiss")) dismissRow(root, li);
  });
  root.addEventListener("keydown", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.classList.contains("edit-text")) return;
    const li = input.closest("li");
    if (!li) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitEdit(root, li);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit(li);
    }
  });
}

function wireBadge(root, proto) {
  const toggle = root.querySelector("#badge-toggle");
  const badge = root.querySelector("#badge");
  const glass = root.querySelector("#glass");
  const mode = root.querySelector("#mode");
  const micArm = root.querySelector("#mic-arm");
  const micLine = root.querySelector("#mic");
  const note = root.querySelector("#note");
  if (!toggle || !badge || !glass || !mode || !micArm || !micLine || !note) return;

  let badgeSocket = null;
  let micPower = false;
  let busy = false;
  let holdNote = false;
  let pending = null;
  let audio = null;
  let stream = null;
  let gate = null;
  let processor = null;

  function paint(state) {
    renderGlass(glass, state);
    micPower = Boolean(state?.mic_power);
    micLine.textContent = micPower ? "Mic power on" : "Mic power cut";
    if (!micPower) pending = null;
  }

  function sendWav(wav) {
    if (!badgeSocket || badgeSocket.readyState !== WebSocket.OPEN || !micPower) return;
    if (busy) {
      pending = wav;
      return;
    }
    busy = true;
    holdNote = false;
    note.textContent = "The relay has this clip.";
    const copy = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    badgeSocket.send(copy);
  }

  function stopMic() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    processor?.disconnect();
    processor = null;
    if (audio) void audio.close();
    audio = null;
    gate = null;
    pending = null;
    micArm.hidden = false;
  }

  function attachMic(pendingStream) {
    pendingStream
      .then(async (opened) => {
        if (!toggle.checked) {
          opened.getTracks().forEach((track) => track.stop());
          return;
        }
        stopMic();
        stream = opened;
        audio = new AudioContext();
        await audio.resume();
        if (!toggle.checked) {
          stopMic();
          return;
        }
        const source = audio.createMediaStreamSource(stream);
        const node = audio.createScriptProcessor(2048, 1, 1);
        processor = node;
        gate = createSpeechGate();
        const mute = audio.createGain();
        mute.gain.value = 0;
        node.onaudioprocess = (event) => {
          if (!micPower || !gate || !audio) return;
          const floats = event.inputBuffer.getChannelData(0);
          const pcm = floatToInt16(resampleLinear(floats, audio.sampleRate, 16000));
          const speech = gate.push(pcm);
          if (speech) sendWav(encodeWav(speech));
        };
        source.connect(node);
        node.connect(mute);
        mute.connect(audio.destination);
        micArm.hidden = true;
        note.textContent = "";
      })
      .catch(() => {
        note.textContent = window.isSecureContext
          ? "The microphone stayed closed."
          : "Open this page at localhost to use the microphone.";
      });
  }

  function connectBadge() {
    if (badgeSocket && badgeSocket.readyState <= WebSocket.OPEN) return;
    paint({ type: "screen", face: "not_linked", mic_power: false });
    mode.disabled = true;
    const socket = new WebSocket(`${proto}//${location.host}/ws`);
    badgeSocket = socket;
    socket.addEventListener("open", () => {
      if (badgeSocket !== socket) return;
      mode.disabled = false;
    });
    socket.addEventListener("message", (event) => {
      if (badgeSocket !== socket || typeof event.data !== "string") return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "screen") {
        holdNote = false;
        note.textContent = window.isSecureContext ? "" : "Open this page at localhost to use the microphone.";
        paint(message);
        return;
      }
      if (message.type === "clip") {
        busy = Boolean(message.busy);
        if (!busy) {
          if (!holdNote) note.textContent = window.isSecureContext ? "" : "Open this page at localhost to use the microphone.";
          const wav = pending;
          pending = null;
          if (wav) sendWav(wav);
        }
        return;
      }
      if (message.type === "reject") {
        holdNote = true;
        note.textContent = reasonText(message.reason);
        if (message.reason === "locked" || message.reason === "one_chunk" || message.reason === "empty_chunk" || message.reason === "chunk_too_large" || message.reason === "not_linked") {
          busy = false;
          pending = null;
        }
      }
    });
    socket.addEventListener("close", () => {
      if (badgeSocket !== socket) return;
      mode.disabled = true;
      busy = false;
      paint({ type: "screen", face: "not_linked", mic_power: false });
      if (toggle.checked) note.textContent = "Relay disconnected.";
    });
  }

  function closeBadge() {
    mode.disabled = true;
    const socket = badgeSocket;
    badgeSocket = null;
    socket?.close();
    stopMic();
    busy = false;
    pending = null;
  }

  toggle.addEventListener("change", () => {
    try {
      localStorage.setItem("livesub.phoneBadge", toggle.checked ? "1" : "0");
    } catch {
      // Private browsing can refuse the write. The checkbox still switches this visit.
    }
    if (toggle.checked) {
      badge.hidden = false;
      connectBadge();
      if (!window.isSecureContext) note.textContent = "Open this page at localhost to use the microphone.";
      return;
    }
    badge.hidden = true;
    closeBadge();
    note.textContent = "";
  });

  micArm.addEventListener("click", () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      note.textContent = "Open this page at localhost to use the microphone.";
      return;
    }
    attachMic(
      navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      }),
    );
  });

  mode.addEventListener("click", () => {
    if (!badgeSocket || badgeSocket.readyState !== WebSocket.OPEN) return;
    badgeSocket.send(JSON.stringify({ type: "press" }));
  });

  let stored = null;
  try {
    stored = localStorage.getItem("livesub.phoneBadge");
  } catch {
    stored = null;
  }
  if (phoneIsBadge(location.search, stored)) {
    toggle.checked = true;
    badge.hidden = false;
    connectBadge();
    if (!window.isSecureContext) note.textContent = "Open this page at localhost to use the microphone.";
  }
}
