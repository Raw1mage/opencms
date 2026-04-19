import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import {
  normalizeQuestionInput,
  normalizeSingleQuestion,
} from "@opencode-ai/sdk/v2"
import z from "zod"

export namespace Question {
  const log = Log.create({ service: "question" })

  export const Option = z
    .object({
      label: z.string().describe("Display text (1-5 words, concise)"),
      description: z.string().describe("Explanation of choice"),
    })
    .meta({
      ref: "QuestionOption",
    })
  export type Option = z.infer<typeof Option>

  export const Info = z
    .object({
      question: z.string().describe("Complete question"),
      header: z.string().describe("Very short label (max 30 chars)"),
      options: z.array(Option).describe("Available choices"),
      multiple: z.boolean().optional().describe("Allow selecting multiple choices"),
      custom: z.boolean().optional().describe("Allow typing a custom answer (default: true)"),
    })
    .meta({
      ref: "QuestionInfo",
    })
  export type Info = z.infer<typeof Info>

  export const Request = z
    .object({
      id: Identifier.schema("question"),
      sessionID: Identifier.schema("session"),
      questions: z.array(Info).describe("Questions to ask"),
      tool: z
        .object({
          messageID: z.string(),
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "QuestionRequest",
    })
  export type Request = z.infer<typeof Request>

  export const Answer = z.array(z.string()).meta({
    ref: "QuestionAnswer",
  })
  export type Answer = z.infer<typeof Answer>

  export const Reply = z.object({
    answers: z
      .array(Answer)
      .describe("User answers in order of questions (each answer is an array of selected labels)"),
  })

  // Single source of truth lives in @opencode-ai/sdk/v2 so webapp and TUI
  // can defensively normalize legacy raw state.input without duplicating
  // the coercion logic. Server-side calls re-export for ergonomic
  // Question.normalize / Question.normalizeSingle access.
  export const normalize = normalizeQuestionInput
  export const normalizeSingle = normalizeSingleQuestion
  export type Reply = z.infer<typeof Reply>

  export const Event = {
    Asked: BusEvent.define("question.asked", Request),
    Replied: BusEvent.define(
      "question.replied",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
        answers: z.array(Answer),
      }),
    ),
    Rejected: BusEvent.define(
      "question.rejected",
      z.object({
        sessionID: z.string(),
        requestID: z.string(),
      }),
    ),
  }

  async function createState() {
    const pending: Record<
      string,
      {
        info: Request
        resolve: (answers: Answer[]) => void
        reject: (e: any) => void
        dispose: () => void
      }
    > = {}

    return {
      pending,
    }
  }

  let stateGetter: (() => Promise<Awaited<ReturnType<typeof createState>>>) | undefined
  let fallbackState: Promise<Awaited<ReturnType<typeof createState>>> | undefined

  function state() {
    if (typeof Instance.state === "function") {
      stateGetter ||= Instance.state(createState)
      return stateGetter()
    }

    fallbackState ||= createState()
    return fallbackState
  }

  function abortReasonLabel(reason: unknown): string {
    if (typeof reason === "string" && reason.length > 0) return reason
    if (reason instanceof Error) return reason.message || reason.name
    if (reason === undefined) return "unknown"
    try {
      return JSON.stringify(reason)
    } catch {
      return String(reason)
    }
  }

  export async function ask(input: {
    sessionID: string
    questions: Info[]
    tool?: { messageID: string; callID: string }
    abort?: AbortSignal
  }): Promise<Answer[]> {
    const s = await state()
    const id = Identifier.ascending("question")

    // Pre-aborted signal: short-circuit without publishing question.asked.
    // Avoids a dialog flash when the stream is already torn down.
    if (input.abort?.aborted) {
      const reason = abortReasonLabel(input.abort.reason)
      log.info("aborted-pre-ask", { id, sessionID: input.sessionID, reason })
      Bus.publish(Event.Rejected, {
        sessionID: input.sessionID,
        requestID: id,
      })
      throw new RejectedError(`pre-aborted: ${reason}`)
    }

    log.info("asking", { id, questions: input.questions.length })

    return new Promise<Answer[]>((resolve, reject) => {
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }

      const abort = input.abort
      const onAbort = abort
        ? () => {
            // Only act if the pending entry is still there. `reply` / `reject`
            // delete it first, so a late abort after a successful reply is a
            // no-op — no duplicate `question.rejected` publish.
            const existing = s.pending[id]
            if (!existing) return
            delete s.pending[id]
            const reason = abortReasonLabel(abort.reason)
            log.info("aborted", { id, sessionID: info.sessionID, reason })
            Bus.publish(Event.Rejected, {
              sessionID: info.sessionID,
              requestID: id,
            })
            reject(new RejectedError(`aborted: ${reason}`))
          }
        : undefined

      const dispose = onAbort && abort
        ? () => abort.removeEventListener("abort", onAbort)
        : () => {}

      s.pending[id] = {
        info,
        resolve,
        reject,
        dispose,
      }

      if (onAbort && abort) {
        abort.addEventListener("abort", onAbort, { once: true })
      }

      Bus.publish(Event.Asked, info)
    })
  }

  export async function reply(input: { requestID: string; answers: Answer[] }): Promise<void> {
    const s = await state()
    const existing = s.pending[input.requestID]
    if (!existing) {
      log.warn("reply for unknown request", { requestID: input.requestID })
      return
    }
    delete s.pending[input.requestID]
    existing.dispose()

    log.info("replied", { requestID: input.requestID, answers: input.answers })

    Bus.publish(Event.Replied, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
      answers: input.answers,
    })

    existing.resolve(input.answers)
  }

  export async function reject(requestID: string): Promise<void> {
    const s = await state()
    const existing = s.pending[requestID]
    if (!existing) {
      log.warn("reject for unknown request", { requestID })
      return
    }
    delete s.pending[requestID]
    existing.dispose()

    log.info("rejected", { requestID })

    Bus.publish(Event.Rejected, {
      sessionID: existing.info.sessionID,
      requestID: existing.info.id,
    })

    existing.reject(new RejectedError())
  }

  export class RejectedError extends Error {
    constructor(detail?: string) {
      super(detail ? `The question was dismissed (${detail})` : "The user dismissed this question")
      this.name = "QuestionRejectedError"
    }
  }

  export async function list() {
    return state().then((x) => Object.values(x.pending).map((x) => x.info))
  }
}
