/**
 * Pure helpers for coercing noncompliant question-tool inputs into the
 * canonical {questions:[{question, header, options:[{label, description}],
 * multiple?, custom?}]} shape.
 *
 * Single source of truth shared by:
 *   - QuestionTool (server): consumed via Question.normalize in
 *     packages/opencode/src/question/index.ts (re-exports these helpers
 *     as Question.normalize / Question.normalizeSingle)
 *   - QuestionDock (webapp): defensive normalize on state.input before render
 *   - message-part.tsx question renderer (webapp): same
 *   - TUI session Question component: same
 *
 * Contract: pure data transforms; never throws; unrecognizable shapes pass
 * through so the caller can decide how to surface (AGENTS.md no-silent-fallback
 * rule — consumers must render explicit error UI on questions.length === 0).
 */

export function normalizeSingleQuestion(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw
  const q = { ...(raw as Record<string, unknown>) }
  if (typeof q.question === "string" && typeof q.header !== "string") {
    q.header = q.question.slice(0, 30)
  }
  if (Array.isArray(q.options)) {
    q.options = q.options.map((opt) => {
      if (typeof opt === "string") return { label: opt, description: opt }
      if (opt && typeof opt === "object") {
        const o = opt as Record<string, unknown>
        const label = typeof o.label === "string" ? o.label : typeof o.value === "string" ? o.value : undefined
        const description =
          typeof o.description === "string"
            ? o.description
            : typeof o.detail === "string"
              ? o.detail
              : typeof o.explanation === "string"
                ? o.explanation
                : typeof label === "string"
                  ? label
                  : undefined
        if (label !== undefined) return { ...o, label, description: description ?? label }
      }
      return opt
    })
  }
  return q
}

export function normalizeQuestionInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw
  const obj = { ...(raw as Record<string, unknown>) }
  if (!Array.isArray(obj.questions) && typeof obj.question === "string") {
    return { questions: [normalizeSingleQuestion(obj)] }
  }
  if (Array.isArray(obj.questions)) {
    obj.questions = obj.questions.map(normalizeSingleQuestion)
  }
  return obj
}
