import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

export type AudioRecorderState = "idle" | "recording" | "uploading" | "error"

export interface AudioRecorderResult {
  blob: Blob
  mime: string
  durationMs: number
}

/**
 * MediaRecorder-based audio capture for mobile browsers that lack
 * reliable SpeechRecognition support.
 *
 * Flow: start() → MediaRecorder captures chunks → stop() → produces
 * a single audio Blob that can be uploaded for server-side transcription.
 */
export function createAudioRecorder() {
  const [store, setStore] = createStore({
    state: "idle" as AudioRecorderState,
    error: "",
    durationMs: 0,
  })

  let recorder: MediaRecorder | undefined
  let audioStream: MediaStream | undefined
  let chunks: BlobPart[] = []
  let startTime = 0
  let durationTimer: ReturnType<typeof setInterval> | undefined
  let resolveStop: ((result: AudioRecorderResult) => void) | undefined
  let rejectStop: ((err: Error) => void) | undefined

  const isSupported = () => {
    if (typeof navigator === "undefined") return false
    if (!navigator.mediaDevices?.getUserMedia) return false
    if (typeof MediaRecorder === "undefined") return false
    return true
  }

  const clearTimer = () => {
    if (durationTimer !== undefined) {
      clearInterval(durationTimer)
      durationTimer = undefined
    }
  }

  const cleanup = () => {
    clearTimer()
    if (audioStream) {
      for (const track of audioStream.getTracks()) track.stop()
      audioStream = undefined
    }
    recorder = undefined
    chunks = []
  }

  const preferredMime = (): string => {
    // Prefer webm/opus (wide support), fall back to mp4/aac (iOS Safari)
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ]
    for (const mime of candidates) {
      if (MediaRecorder.isTypeSupported(mime)) return mime
    }
    return "" // let browser pick default
  }

  const start = async (): Promise<void> => {
    if (!isSupported()) {
      setStore({ state: "error", error: "MediaRecorder not supported" })
      return
    }
    if (store.state === "recording") return

    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Microphone permission denied"
      console.warn("[audio-recorder] getUserMedia failed:", msg)
      setStore({ state: "error", error: msg })
      return
    }

    chunks = []
    const mime = preferredMime()
    try {
      recorder = new MediaRecorder(audioStream, mime ? { mimeType: mime } : undefined)
    } catch (err) {
      console.warn("[audio-recorder] MediaRecorder init failed:", err)
      cleanup()
      setStore({ state: "error", error: "MediaRecorder init failed" })
      return
    }

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }

    recorder.onstop = () => {
      clearTimer()
      const elapsed = Date.now() - startTime
      const actualMime = recorder?.mimeType || mime || "audio/webm"
      const blob = new Blob(chunks, { type: actualMime })
      cleanup()
      setStore({ state: "idle", durationMs: elapsed })
      if (resolveStop) {
        resolveStop({ blob, mime: actualMime, durationMs: elapsed })
        resolveStop = undefined
        rejectStop = undefined
      }
    }

    recorder.onerror = () => {
      console.warn("[audio-recorder] recording error")
      cleanup()
      setStore({ state: "error", error: "Recording failed" })
      if (rejectStop) {
        rejectStop(new Error("Recording failed"))
        resolveStop = undefined
        rejectStop = undefined
      }
    }

    startTime = Date.now()
    setStore({ state: "recording", error: "", durationMs: 0 })
    recorder.start(1000) // collect data every 1s for progress

    durationTimer = setInterval(() => {
      setStore("durationMs", Date.now() - startTime)
    }, 500)
  }

  /**
   * Stop recording and return the audio blob.
   * Returns a promise that resolves when the recorder has flushed all data.
   */
  const stop = (): Promise<AudioRecorderResult> => {
    return new Promise((resolve, reject) => {
      if (!recorder || store.state !== "recording") {
        reject(new Error("Not recording"))
        return
      }
      resolveStop = resolve
      rejectStop = reject
      recorder.stop()
    })
  }

  const cancel = () => {
    resolveStop = undefined
    rejectStop = undefined
    if (recorder && store.state === "recording") {
      try {
        recorder.stop()
      } catch {}
    }
    cleanup()
    setStore({ state: "idle", error: "", durationMs: 0 })
  }

  onCleanup(() => {
    cancel()
  })

  return {
    isSupported,
    state: () => store.state,
    error: () => store.error,
    durationMs: () => store.durationMs,
    start,
    stop,
    cancel,
  }
}
