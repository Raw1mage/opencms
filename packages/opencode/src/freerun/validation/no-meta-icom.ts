import type { PlanningOutcome } from "../types"

export namespace NoMetaIcom {
  export interface Violation {
    childId: string
    reason: string
  }

  const META_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\b(generate|create|produce|write|emit|update|maintain|prepare)\s+(an?\s+)?icom\b/i, reason: "ICOM is the commit protocol, not a child task" },
    { pattern: /\b(context\s*node|contextnode)\b/i, reason: "ContextNode is runtime state, not a domain child task" },
    { pattern: /\b(planningoutcome|executionoutcome)\b/i, reason: "Outcome objects are protocol outputs, not domain child tasks" },
    { pattern: /\b(json\s+schema|schema\s+validation|response\s+schema)\b/i, reason: "Schema handling belongs to runtime validation" },
    { pattern: /\b(freerun\s+state|state\s+update|update\s+state|persist\s+state)\b/i, reason: "State persistence belongs to the runtime" },
    { pattern: /\b(update|check\s+off|tick|mark)\s+tasks\.md\b/i, reason: "tasks.md completion is a plan sync side effect, not a child task" },
    { pattern: /\b(plan(ning)?\s+(the\s+)?plan|decompose\s+(the\s+)?decomposition)\b/i, reason: "Planning the plan is a meta-task loop" },
    { pattern: /\b(handover|runloop|runtime\s+protocol|commit\s+protocol)\b/i, reason: "Runtime protocol work must stay outside the domain task tree" },
  ]

  export function validate(outcome: PlanningOutcome): Violation[] {
    const violations: Violation[] = []
    for (const child of outcome.children) {
      const text = `${child.title}\n${child.body}`
      const hit = META_PATTERNS.find((entry) => entry.pattern.test(text))
      if (hit) violations.push({ childId: child.id, reason: hit.reason })
    }
    return violations
  }

  export function assertValid(outcome: PlanningOutcome): void {
    const violations = validate(outcome)
    if (violations.length === 0) return
    const details = violations.map((v) => `${v.childId}: ${v.reason}`).join("; ")
    throw new Error(`planning outcome violates No Meta-ICOM invariant — ${details}`)
  }
}
