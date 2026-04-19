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
  },
})
