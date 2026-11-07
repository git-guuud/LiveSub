# LiveSub

A collar badge that listens while the phone is away. The glass shows only the mode. Reminders, lists, and live translation show up on the phone, and only after 0G has verified the call.

0G Private Computer is the brain. The LilyGO badge is the body: it gates silence, paints the screen, and cuts the microphone when the brain is gone. It does not transcribe, translate, or invent a reminder.

## The loop

Companion is the mode you leave on. Speech is one short clip. The relay sends it to 0G, then drops the audio. A verified reason may add a reminder or a list item, stamped with the time that sentence was said. The phone can be closed. It learns what changed by reading the encrypted index, not from a push by the badge.

Live is the mode you turn on while the phone page is open. The same speech also appears there as words and a translation. Closing the page leaves Live. Open reminders stay.

The glass has four faces and nothing else:

- **Companion**
- **Live**
- **Not linked** — the relay socket is down. Mic power is cut. Nothing is uploaded.
- **MIC LOCKED: ENCLAVE OFFLINE** — red border. HTTP 503, HTTP 502, or `tee_verified` other than true. No memory write, no live line, no fallback to trust mode `standard`.

## 0G

Both calls go to `https://router-api.0g.ai/v1` with `X-0G-Provider-Trust-Mode: private`.

1. **Transcribe.** `POST /v1/audio/transcriptions?verify_tee=true`, model `whisper-large-v3`. The clip buffer is wiped when the request ends. Audio is never stored.
2. **Reason.** `POST /v1/chat/completions` with `verify_tee: true` and JSON output. Input is the transcript, the time, the mode, and the open reminders and list items. Output is memory operations and, in Live, the line and the translation.

`tee_verified` is read from `x_0g_trace` on the response. The model's prose is not the memory. The operations are, and only after that check passes. Each stored utterance keeps both `request_id`s.

Storage is client-side AES-256-GCM, then the 0G log. One ciphertext per utterance, addressed by the SDK Merkle root, downloaded with the proof check. A KV value points at the open-item blob. The key stays on the relay, in `relay/data/aes.key`, and is not in the ciphertext and not sent to the phone. This prototype uses the Galileo Flow contract `0x22E03a6A89B950F1c82ec5e74F8eCa321a105296`. No application contract is deployed.

If 0G is removed, the badge has nothing to decide with. It locks or shows Not linked. It does not answer locally.

## Try the spoken demo

Needs Node.js 22 or newer, and a 0G router key with private inference funded.

```bash
cp .env.example .env
# fill OG_API_KEY, and the three Galileo storage values if you want the index to persist
cd relay
npm install
npm start
```

Open http://localhost:8787/phone?badge=1 on the laptop (a phone on plain HTTP cannot open its microphone). Check **This phone is the badge**, tap **Use the microphone**, and leave the glass on Companion.

Say: "I'll meet Kenji on Thursday. I still owe him 5 USDC."

The glass stays on Companion. It does not show the sentence. The Thursday reminder and the 5 USDC item appear under Remembered, with the time of that sentence, once the index can be read back. **Verified** shows the two request ids.

On the board, close the phone page first and speak to the badge. Then open http://localhost:8787/phone. The list is that same storage read. The page does not need to have been open while you spoke.

Say that the money was sent. The item leaves. The reminder stays.

Press **Mode** while that page is open. The glass says Live. A new sentence shows up as words and a translation. Close the page. The glass returns to Companion. The reminder is still there.

`?badge=0` gives the badge socket back to the board.

Without storage env vars the relay still runs. Lists stay empty across a restart, because there is no index to read. `npm test` in `relay/` covers the same six steps with the router mocked and the encrypt-and-log path in process (`relay/test/pitch.test.ts`).

## The board

LilyGO T-Display v1.1. GPIO0 short press toggles Companion and Live. Live is refused while the phone page is closed. A press already down at boot, or held past a tap, sends nothing. GPIO35 does not start a capture.

INMP441: BCLK GPIO26, LRCLK GPIO25, data GPIO33, L/R tied to ground. GPIO27 powers the mic and goes low to cut it. Silence is dropped on the board. One short WAV is sent, then the buffer is reused.

```bash
cp firmware/include/secrets.example.h firmware/include/secrets.h
# Wi-Fi and the relay host. secrets.h is not committed.
cd firmware
pio run -e lilygo-t-display
pio test -e native
```

The laptop page labeled `STAND_IN` is the same glass protocol, for a demo with no board: http://localhost:8787/

## Spec

[IDEA.md](IDEA.md) is the product spec this repo implements. An animated face, iAI staking, on-device storage, and a transcript on the glass are out of this prototype.

## AI tools

Cursor was used to implement the relay, the firmware, and the tests from that spec. The product decisions, the hardware, and the wiring are the team's. The spec file is in this repository so the direction is visible next to the code.
