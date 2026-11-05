import { reasonText, renderGlass } from "./screen.js";

const glass = document.querySelector("#glass");
const mic = document.querySelector("#mic");
const note = document.querySelector("#note");
const buttons = [...document.querySelectorAll("button")];
const mode = document.querySelector("button.mode");
const clip = document.querySelector("button.clip");

const proto = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(`${proto}//${location.host}/ws`);

function showUnlinked() {
  renderGlass(glass, { type: "screen", face: "not_linked", mic_power: false });
  mic.textContent = "Mic power cut";
}

function setConnected(on) {
  for (const button of buttons) button.disabled = !on;
  if (!on) {
    showUnlinked();
    note.textContent = "Relay disconnected.";
  }
}

socket.addEventListener("open", () => setConnected(true));
socket.addEventListener("close", () => setConnected(false));

socket.addEventListener("message", (event) => {
  if (typeof event.data !== "string") return;
  const message = JSON.parse(event.data);
  if (message.type === "reject") {
    note.textContent = reasonText(message.reason);
    return;
  }
  if (message.type !== "screen") return;
  note.textContent = "";
  renderGlass(glass, message);
  mic.textContent = message.mic_power ? "Mic power on" : "Mic power cut";
});

mode.addEventListener("click", () => {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "press" }));
});

// STAND_IN bench control. The laptop has no microphone. This is not painted on the glass.
clip.addEventListener("click", () => {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(new Uint8Array([1, 2, 3, 4]));
});

window.addEventListener("keydown", (event) => {
  if (event.repeat || event.target instanceof HTMLButtonElement) return;
  if (event.code === "KeyM") mode.click();
});
