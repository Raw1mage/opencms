import z from "zod"
import { Tool } from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

const SCHEMA_HINT = [
  "[schema-miss:question] Retry with exactly this shape:",
  "```json",
  "{",
  '  "questions": [',
  "    {",
  '      "question": "<full question text>",',
  '      "header": "<short label, ≤30 chars>",',
  '      "options": [',
  '        { "label": "<1-5 word display>", "description": "<explanation>" }',
  "      ],",
  '      "multiple": false',
  "    }",
  "  ]",
  "}",
  "```",
  "Common mistakes we auto-normalize (so these should now work): single flat question without the outer `questions` array; `options` as plain `string[]`; missing `header`. If you still hit this message, check: (1) `questions` must be an array even for one question; (2) each option must be an OBJECT with `label`+`description`, not a bare string (we try to coerce, but only if the shape is recognizable).",
].join("\n")

export const QuestionTool = Tool.define("question", {
  description: DESCRIPTION,
  parameters: z.preprocess(
    Question.normalize,
    z.object({
      questions: z.array(Question.Info.omit({ custom: true })).describe("Questions to ask"),
    }),
  ),
  formatValidationError: () => SCHEMA_HINT,
  async execute(params, ctx) {
    // Pause the stream-idle watchdog while we await a human answer.
    // Without this, the 90s STREAM_IDLE_TIMEOUT_MS in llm.ts fires
    // because no token chunks flow during the wait, aborts the
    // composedAbortSignal, and retracts the question mid-typing
    // (issues/bug_20260530_question_tool_retracted_treated_as_answered.md,
    //  plans/question-tool_idle-watchdog-false-kill DD-1).
    //
    // try/finally is MANDATORY (design.md R1): if Question.ask throws
    // without resume(), the watchdog stays disarmed for the rest of
    // the stream and wedge detection is silently disabled for the turn.
    // Genuine input.abort (killswitch / manual-stop / session-switch)
    // still rejects normally — pause only suspends the idle branch.
    const resume = ctx.pauseIdleWatchdog?.()
    try {
      const answers = await Question.ask({
        sessionID: ctx.sessionID,
        questions: params.questions,
        tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
        abort: ctx.abort,
      })

      function format(answer: Question.Answer | undefined) {
        if (!answer?.length) return "Unanswered"
        return answer.join(", ")
      }

      const formatted = params.questions.map((q, i) => `"${q.question}"="${format(answers[i])}"`).join(", ")

      return {
        title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
        output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
        metadata: {
          answers,
        },
      }
    } finally {
      resume?.()
    }
  },
})
