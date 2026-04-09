import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSpeechRecognition } from "./speech"

type FakeRecognitionInstance = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult:
    | ((e: { results: Array<{ 0: { transcript: string }; isFinal: boolean }>; resultIndex: number }) => void)
    | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

const installFakeSpeech = () => {
  const instances: FakeRecognitionInstance[] = []
  let startCalls = 0
  let stopCalls = 0

  class FakeRecognition implements FakeRecognitionInstance {
    continuous = false
    interimResults = false
    lang = "en-US"
    onresult: FakeRecognitionInstance["onresult"] = null
    onerror: FakeRecognitionInstance["onerror"] = null
    onend: FakeRecognitionInstance["onend"] = null
    onstart: FakeRecognitionInstance["onstart"] = null

    constructor() {
      instances.push(this)
    }

    start() {
      startCalls += 1
      this.onstart?.()
    }

    stop() {
      stopCalls += 1
      this.onend?.()
    }
  }

  const previous = (window as typeof window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
  ;(window as typeof window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition

  return {
    instances,
    getStartCalls: () => startCalls,
    getStopCalls: () => stopCalls,
    restore: () => {
      ;(window as typeof window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = previous
    },
  }
}

describe("speech recognition", () => {
  test("commits pending interim when recognition ends naturally", () => {
    const fake = installFakeSpeech()
    const finals: string[] = []

    try {
      createRoot((dispose) => {
        const speech = createSpeechRecognition({
          onFinal: (text) => finals.push(text),
        })

        speech.start()

        const instance = fake.instances[0]
        expect(instance).toBeDefined()
        instance.onresult?.({
          resultIndex: 0,
          results: [{ 0: { transcript: "hello world" }, isFinal: false }],
        })
        instance.onend?.()

        expect(finals).toEqual(["hello world"])
        expect(speech.isRecording()).toBe(false)
        expect(fake.getStartCalls()).toBe(1)

        dispose()
      })
    } finally {
      fake.restore()
    }
  })

  test("does not restart after no-speech error", async () => {
    const fake = installFakeSpeech()
    let isRecording = true

    try {
      createRoot((dispose) => {
        const speech = createSpeechRecognition()

        speech.start()

        const instance = fake.instances[0]
        expect(instance).toBeDefined()
        instance.onerror?.({ error: "no-speech" })
        instance.onend?.()
        isRecording = speech.isRecording()

        dispose()
      })

      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(fake.getStartCalls()).toBe(1)
      expect(isRecording).toBe(false)
    } finally {
      fake.restore()
    }
  })
})
