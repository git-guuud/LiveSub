AMBIENT COMPANION

1. EXECUTIVE SUMMARY
A collar badge that listens while the phone is away, and a phone page that shows what that listening changed. The badge screen has one job: the mode, and whether it is linked. It does not show a transcript, a translation, or a reminder.

Two modes. Companion is the one you leave on. Speech is transcribed and folded into memory as it happens, with a timestamp, whether or not the phone page is open. Live is the one you turn on while a phone is linked. The same speech also appears on the phone as words and a translation while you talk. Closing the phone leaves Live and does not wipe the reminders or the lists.

0G Private Computer is the brain. Transcription and reasoning run in a private TEE with zero retention. Each utterance is client-encrypted onto the 0G Storage log. A small KV index holds what is still open: reminders and list items. The phone reads that index from storage when it opens. It does not transcribe. It can dismiss an open reminder or list item, or change that row's wording. It cannot add one. A new feature is a new kind of item in that index, or a new way to read it. It is not a new path from the microphone.

The badge can be away from the phone. It cannot save a new utterance while the relay is unreachable. Audio of a day does not fit on the board. Text only exists after transcription, and the relay holds the API key and the storage key. A lost relay pauses the mic and shows Not linked. It does not queue a day of audio, and it does not invent a reminder.

iAI staking is the economic story for self-funded compute. It is not part of this prototype. At the published whisper-large-v3 rate, about two hours of speech is on the order of $1 for the transcription leg alone. Every chunk also pays a chat completion. Treat $1/day as a sketch of the speech leg, not a measured budget, and do not claim the stake already covers it.

2. THE RICHNESS TEST
With the phone page closed, say a sentence that mentions a meeting and an unpaid amount. Open the phone. It shows a reminder for the meeting and an open list item for the amount, each carrying the time that sentence was said.

Say that the amount was paid. The list item is gone. The reminder stays. Restart the relay, say a later sentence that mentions neither, and the reminder is still there because it is still open, not because it belonged to that day.

Dismiss on the phone closes a reminder or a list item. Edit changes that row's wording and keeps its time. Unplug the index and Live can still translate onto the phone. The reminders and the lists are empty. A write-only log the phone never reads fails the test.

3. WHAT THE WEARER DOES
Companion. The phone can be in a bag. A local energy gate keeps silence off the relay. Speech becomes one short chunk, then the board drops it. The badge keeps showing Companion. When the utterance is verified, memory updates immediately and the index is written. The phone learns about it by reading that index. Nothing on the phone socket carries the reminders or the lists.

Live. A short press moves to Live only while the phone page is connected. The phone shows the transcript and a translation for that chunk as soon as reasoning returns. The badge still shows only Live and that the phone is linked. If the page disconnects, the badge returns to Companion, live lines stop, and open reminders and list items stay.

The glass never shows Listening, Thinking, a subtitle, or a cue. Those belonged to the previous badge.

There is no day bucket. A reminder from last week stays because nobody closed it. Lists grow and shrink one item at a time. The prompt for a new utterance sees the new transcript plus the open items. It does not see the week of raw speech. Full transcripts stay in the log.

4. HARDWARE
LilyGO T-Display v1.1. ESP32 dual-core, Wi-Fi, 1.14-inch ST7789 at 135×240, two buttons (GPIO0 and GPIO35), USB-C, and a 1S LiPo connector. No PSRAM and no microphone. Flash is 4 MB. The partition table leaves an 896 KB file area. The firmware does not use it for audio or for the memory index. No PSRAM means the device keeps one short chunk, sends it, and drops it. A typical day of speech is on the order of 100 KB of text and fits in that file area, but the text lives in the encrypted log, not on the badge.

INMP441 on free header GPIOs for BCLK, LRCLK, and data. Power it at 3.3V. Do not use the display bus (GPIO 18, 19, 5, 16, 23, 4), and do not use GPIO34 or GPIO35 for clocks or power: those pins are input-only. GPIO0 is the BOOT strap, so it stays a button. Gate the mic's VDD with a free output GPIO (or a small FET driven by one) so a lock removes power. A software mute is weaker than the track's physical lock.

Buttons:
- GPIO0, short press: toggle Companion / Live. Live is refused when no phone page is connected, and the glass stays on Companion. Do not hold GPIO0 through reset.
- GPIO35: not a capture button. Companion and Live both listen without a hold.

The laptop relay is the client. WebSocket for chunks, the mode button, and screen state. It encodes audio, calls 0G, encrypts, and writes storage. The ESP32 does not hold the storage key or run the storage SDK. The phone is a local page on that relay. Reminders and lists are a proof-checked read of the index, decrypted on the relay. The AES key is not sent to the phone. Live lines and traces use the phone socket. The phone is not a second model.

The WebSocket protocol can be proven with a laptop stand-in of the mode screen. The LilyGO is the body that then speaks that protocol. The stand-in may offer a bench control that injects one clip, because the laptop has no microphone. That control is not a product button and it is not on the glass.

5. DATA FLOW
Memory updates when reasoning returns. Storage consensus does not block that update. The phone being closed does not block it either.

Per captured chunk, two private calls, both to https://router-api.0g.ai/v1 with header X-0G-Provider-Trust-Mode: private:

1. Transcribe. POST /v1/audio/transcriptions?verify_tee=true, model whisper-large-v3. One encoded clip per speech chunk. Discard the audio when the request ends. It is never stored.
2. Reason. POST /v1/chat/completions with verify_tee: true and JSON output. Input is the transcript, the timestamp, the mode, and the open reminders and open list items. Output is memory operations and, in Live, the transcript line and the translation. Companion does not display those lines.

Parse tee_verified from the JSON field x_0g_trace on each response. It is response metadata, not a header. Apply memory operations, or paint a live line, only when that field is true for the call that produced it. The model's prose is not the memory. The operations are.

On session start, load and decrypt the KV index into RAM. A version 1.0 index from the previous badge is not this working set. Treat it as empty. Update RAM as soon as reasoning returns. In Live, send the lines then. Encrypt the utterance onto the log layer and write the index back to KV in the background. A phone that opens afterward reads that index. Companion does not wait on a socket. It does wait until the write can be read. Across a restart the relay does too.

6. STORAGE
Log layer: one immutable ciphertext per utterance, addressed by Merkle root, downloaded with proof verification.

KV layer: the mutable index the brain reads. Open reminders and open list items stay until an operation closes them. Age does not close them. Full transcripts stay in the log blobs.

Encrypt on the relay before upload. The key never goes to 0G.

Utterance (plaintext only inside the relay, then encrypted):
{
  "version": "2.0",
  "timestamp": 1729864200,
  "mode": "companion",
  "audio_duration_sec": 3.5,
  "transcript": "I'll meet Kenji on Thursday. I still owe him 5 USDC.",
  "translation": "",
  "memory_ops": [
    {"op": "add_reminder", "text": "Meet Kenji Thursday"},
    {"op": "add_item", "list": "open", "text": "Send Kenji 5 USDC"}
  ],
  "traces": [
    {
      "step": "transcribe",
      "model": "whisper-large-v3",
      "request_id": "0852f405-6c56-40c2-a800-e6fd70785065",
      "provider": "0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C",
      "tee_verified": true
    },
    {
      "step": "reason",
      "model": "<private chat model>",
      "request_id": "…",
      "provider": "0x…",
      "tee_verified": true
    }
  ]
}

No audio field. No direction field. No pin field. A missing trace, or tee_verified other than true, is a failed inference. It does not become an utterance and it does not change the index. In Live it does not paint a line.

Index (also encrypted):
{
  "version": "2.0",
  "reminders": [
    {"text": "Meet Kenji Thursday", "mentioned_at": 1729864200, "episode_root": "0x…"}
  ],
  "lists": [
    {"list": "open", "text": "Send Kenji 5 USDC", "updated_at": 1729864200, "episode_root": "0x…"}
  ]
}

Closed items are removed from the index. They remain in the log as the utterance that closed them. The index is not a diary of the week.

7. FAIL-CLOSED
Three different states:

- Phone page closed. Normal. Companion keeps listening and keeps updating memory. Live is unavailable. Open items stay.
- Relay link down. The badge shows Not linked, cuts mic power, and uploads nothing. Memory already stored stays. This is not the enclave lock. When the socket returns, Companion resumes. Do not replay a cached live line.
- Enclave failure. HTTP 503, including no private provider for the trust mode, or no healthy provider. HTTP 502 after provider failover. verify_tee was requested and tee_verified is not true. The relay tells the badge to cut mic VDD, turn the border red, and show MIC LOCKED: ENCLAVE OFFLINE. Stay locked until a successful private heartbeat. Do not drop to trust mode standard. Do not apply memory operations. Do not show a cached live line.

8. THREAT MODEL
Claim: private trust mode, so prompts stay inside the TEE, and the router retains billing metadata rather than audio or text. Audio dies with the transcription request. Storage holds ciphertext.

Do not claim the laptop is untrusted. The relay holds the API key, the AES key, and the plaintext working set. The badge renders what the relay sends. Live lines are pushed to the phone. Companion items are decrypted from storage on the relay and then shown. Moving the key off the laptop, and reproducing the TEE signature beyond the router's tee_verified boolean, are later. This prototype stores the trace and refuses to display or remember a result that failed the check.

9. DEMO
1. Phone page closed. Companion. Say "I'll meet Kenji on Thursday. I still owe him 5 USDC." The badge stays on Companion. It does not show the sentence.
2. Open the phone. It reads the stored index and shows the Thursday reminder and an open item for the 5 USDC, with the time of that sentence. The phone socket was closed for that read.
3. Say that the money was sent. The money leaves the list. The Thursday reminder stays.
4. Kill and restart the relay. Say a sentence that mentions neither Kenji's meeting nor the money. The reminder is still open. Its time is still the original one.
5. Switch to Live with the phone linked. A new sentence appears on the phone as words and a translation while you speak. Close the phone. Live ends, the badge returns to Companion, and the reminder is still there.
6. Force private routing to fail, or fail the TEE check. The mic power drops, the glass locks, and no reminder or live line is added.

10. OUT OF THIS PROTOTYPE
An animated face, iAI staking, on-device storage SDK, a transcript diary stored on the badge, continuous raw-audio streaming, a separate sentiment model, speaker diarization, fine-tuning, and Agentic ID. Direction ("I speak" / "They speak") and pinning an episode are the previous badge. They are not this one.

More list kinds and more reminder kinds can be added later. They use the same utterance, the same operations, and the same phone page.
