import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Instance } from "@/project/instance"
import { Bus } from "@/bus"
import { Question } from "./index"
import { tmpdir } from "../../test/fixture/fixture"

type Captured = {
  asked: Array<{ id: string; sessionID: string }>
  replied: Array<{ requestID: string; sessionID: string }>
  rejected: Array<{ requestID: string; sessionID: string }>
}

function captureEvents(): { events: Captured; dispose: () => void } {
  const events: Captured = { asked: [], replied: [], rejected: [] }
  const unsubscribers = [
    Bus.subscribe(Question.Event.Asked, (e) => {
      events.asked.push({ id: e.properties.id, sessionID: e.properties.sessionID })
    }),
    Bus.subscribe(Question.Event.Replied, (e) => {
      events.replied.push({ requestID: e.properties.requestID, sessionID: e.properties.sessionID })
    }),
    Bus.subscribe(Question.Event.Rejected, (e) => {
      events.rejected.push({ requestID: e.properties.requestID, sessionID: e.properties.sessionID })
    }),
  ]
  return {
    events,
    dispose: () => unsubscribers.forEach((u) => u()),
  }
}

async function drainMicrotasks(times = 3) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe("Question.ask with AbortSignal (Requirement A)", () => {
  const sessionID = "ses_test_abort_flow"
  const questions = [
    {
      question: "Pick one?",
      header: "Pick",
      options: [
        { label: "A", description: "first" },
        { label: "B", description: "second" },
      ],
    },
  ]

  it("TV1: stream abort during pending question auto-rejects and publishes question.rejected", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const capture = captureEvents()
        const controller = new AbortController()
        const ask = Question.ask({ sessionID, questions, abort: controller.signal })

        await drainMicrotasks()
        expect(capture.events.asked.length).toBe(1)

        controller.abort("rate-limit-fallback")
        await expect(ask).rejects.toBeInstanceOf(Question.RejectedError)

        expect(capture.events.rejected.length).toBe(1)
        expect(capture.events.rejected[0]!.requestID).toBe(capture.events.asked[0]!.id)
        expect(await Question.list()).toHaveLength(0)
        capture.dispose()
      },
    })
  })

  it("TV2: late abort after reply is a no-op (reply wins; abort handler idempotent)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const capture = captureEvents()
        const controller = new AbortController()
        const ask = Question.ask({ sessionID, questions, abort: controller.signal })

        await drainMicrotasks()
        const askedID = capture.events.asked[0]!.id

        await Question.reply({ requestID: askedID, answers: [["A"]] })
        await expect(ask).resolves.toEqual([["A"]])

        // Late abort fires after reply — must not double-publish rejected.
        controller.abort("rate-limit-fallback")
        await drainMicrotasks()

        expect(capture.events.replied.length).toBe(1)
        expect(capture.events.rejected.length).toBe(0)
        expect(await Question.list()).toHaveLength(0)
        capture.dispose()
      },
    })
  })

  it("TV3: pre-aborted signal short-circuits without publishing question.asked", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const capture = captureEvents()
        const controller = new AbortController()
        controller.abort("manual-stop")

        await expect(
          Question.ask({ sessionID, questions, abort: controller.signal }),
        ).rejects.toBeInstanceOf(Question.RejectedError)

        await drainMicrotasks()
        expect(capture.events.asked.length).toBe(0)
        expect(capture.events.rejected.length).toBe(1)
        expect(await Question.list()).toHaveLength(0)
        capture.dispose()
      },
    })
  })

  it("abort dispatched twice from same controller does not duplicate question.rejected", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const capture = captureEvents()
        const controller = new AbortController()
        const ask = Question.ask({ sessionID, questions, abort: controller.signal })

        await drainMicrotasks()
        controller.abort("rate-limit-fallback")
        await expect(ask).rejects.toBeInstanceOf(Question.RejectedError)

        // Re-dispatching abort on an already-aborted controller is a no-op in
        // the DOM spec, but we also want defense-in-depth: our listener is
        // { once: true } and pending[id] is already gone.
        controller.signal.dispatchEvent(new Event("abort"))
        await drainMicrotasks()

        expect(capture.events.rejected.length).toBe(1)
        capture.dispose()
      },
    })
  })

  it("works without AbortSignal (backward compatible)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const capture = captureEvents()
        const ask = Question.ask({ sessionID, questions })

        await drainMicrotasks()
        const askedID = capture.events.asked[0]!.id

        await Question.reply({ requestID: askedID, answers: [["A"]] })
        await expect(ask).resolves.toEqual([["A"]])
        capture.dispose()
      },
    })
  })

  it("manual Question.reject still works when AbortSignal was provided but not triggered", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const capture = captureEvents()
        const controller = new AbortController()
        const ask = Question.ask({ sessionID, questions, abort: controller.signal })

        await drainMicrotasks()
        const askedID = capture.events.asked[0]!.id

        await Question.reject(askedID)
        await expect(ask).rejects.toBeInstanceOf(Question.RejectedError)

        // Now late abort — should be a no-op.
        controller.abort("rate-limit-fallback")
        await drainMicrotasks()

        expect(capture.events.rejected.length).toBe(1)
        capture.dispose()
      },
    })
  })
})
