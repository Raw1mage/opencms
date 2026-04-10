# Webapp Voice Input

Origin: `plans/20260408_webapp/`
Landed: 2026-04-10

## Overview

Webapp session prompt input 支援語音輸入，採 capability-based 雙路方案：

1. **Desktop path** — Browser SpeechRecognition 即時辨識（live transcription + smart punctuation）
2. **Mobile path** — MediaRecorder 錄音 → server-side 轉寫（audio-capable model auto-discovery）

兩條路徑共用同一 prompt ownership contract（`prompt.set()`），不建立第二文字權威。

## Architecture

```
                     ┌──────────────────────────────────────┐
                     │       prompt-input.tsx                │
                     │  voicePath(): speech│recording│unsup  │
                     └────────┬─────────────┬───────────────┘
                              │             │
                    ┌─────────▼──────┐  ┌───▼──────────────────┐
                    │ speech.ts      │  │ audio-recorder.ts    │
                    │ SpeechRecog.   │  │ MediaRecorder         │
                    │ live interim   │  │ blob capture          │
                    │ + punctuation  │  └───┬──────────────────┘
                    └────────┬───────┘      │ upload (FormData)
                             │              ▼
                             │  ┌──────────────────────────────┐
                             │  │ POST /session/:id/transcribe │
                             │  │ → auto-find audio model      │
                             │  │ → generateText(audio + prompt)│
                             │  │ → { text }                   │
                             │  └──────────┬───────────────────┘
                             │             │
                     ┌───────▼─────────────▼───────┐
                     │   applyVoiceTranscript()     │
                     │   → prompt.set()             │
                     │   → setCursorPosition()      │
                     └─────────────────────────────┘
```

## Route Selection Policy

`voicePath()` is a deterministic `createMemo` that evaluates once at component mount:

| Condition | Path | Behavior |
|---|---|---|
| `SpeechRecognition` / `webkitSpeechRecognition` available | `"speech"` | Live transcription with smart punctuation |
| `MediaRecorder` + `getUserMedia` available | `"recording"` | Record → upload → server transcribe |
| Neither available | `"unsupported"` | Mic button disabled, tooltip shows reason |

Route selection is **final** — once determined, it does not silently switch during the session.

## Files

| File | Role |
|---|---|
| `packages/app/src/components/prompt-input.tsx` | UI integration, route selection, state coordination |
| `packages/app/src/utils/speech.ts` | Desktop: SpeechRecognition wrapper with smart punctuation |
| `packages/app/src/utils/audio-recorder.ts` | Mobile: MediaRecorder capture hook |
| `packages/app/src/utils/transcribe.ts` | Client: upload audio blob for server-side transcription |
| `packages/opencode/src/server/routes/session.ts` | Server: `POST /:sessionID/transcribe` endpoint |
| `packages/app/src/utils/runtime-adapters.ts` | `getSpeechRecognitionCtor()` capability detection |
| `packages/app/src/i18n/en.ts`, `zht.ts` | Voice input UI strings |

## Server Endpoint

### `POST /api/v2/session/:sessionID/transcribe`

- **Input**: `multipart/form-data` with `audio` field (audio/* MIME)
- **Output**: `{ text: string }`
- **Model resolution**:
  1. Session's active model if audio-capable
  2. Form hints (`provider`, `model` fields)
  3. Auto-scan all providers for first audio-capable model
  4. 400 if none found
- **Error codes**: `MISSING_AUDIO`, `INVALID_MIME`, `NO_AUDIO_MODEL`, `TRANSCRIPTION_FAILED`

## Desktop Speech Details

- `continuous = true`: keeps listening until explicit stop
- Smart punctuation:
  - Short pause then continue → comma (，/, )
  - 3s silence → period (。/. ) or question mark (？) for 嗎/呢 particles
  - Explicit stop → period immediately
- `onTranscript` callback pushes full assembled text (with punctuation) on every change
- Prompt snapshot taken before recording starts; each transcript update rebuilds from snapshot

## Mobile Recording Details

- MediaRecorder captures audio chunks (1s interval)
- Preferred MIME: `audio/webm;codecs=opus` > `audio/webm` > `audio/mp4` > `audio/ogg;codecs=opus`
- On stop: chunks assembled into single Blob → uploaded via FormData → transcribed
- During transcription: spinner icon + "Transcribing..." status bar
- On failure: error toast with message from server

## UI States

| State | Mic button | Status bar | Path |
|---|---|---|---|
| Idle (supported) | Microphone icon | — | Both |
| Recording (desktop) | Red dot | "Listening..." | Speech |
| Recording (mobile) | Red dot | "Recording..." | Recording |
| Transcribing | Spinner | "Transcribing..." | Recording |
| Unsupported | Disabled | — | — |

## Auto-stop Rules

- Mode switches away from `"normal"` → cancel
- `working()` becomes true (AI responding) → cancel
- Component cleanup → cancel

## Constraints

- No silent fallback: unsupported state is always explicit
- No second text authority: both paths write through `prompt.set()`
- Desktop path does not cross to server
- Mobile path requires an audio-capable model on the server
- STT provider selection is implicit (first audio-capable model found)
