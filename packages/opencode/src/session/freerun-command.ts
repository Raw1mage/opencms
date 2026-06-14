export type FreerunCommand = { verb: "on" | "off" | "clear" } | { verb: "arm"; goal?: string } | { verb: "disarm" }

export type FreerunNaturalEntry =
  | { kind: "activate"; command: Extract<FreerunCommand, { verb: "arm" }> }
  | { kind: "ready"; suggestion: "可進入 freerun 拆解執行" }
  | { kind: "clarify" }
  | { kind: "none" }

const STRONG_ARM_PATTERNS = [/^(?:開始執行|開始跑|照這樣做|你自己拆細完成|run|execute)(?:[：:\s]+([\s\S]+))$/i]

const WEAK_ARM_PATTERNS = [/^(?:接著跑|go|run|execute|開始執行|開始跑|照這樣做|你自己拆細完成)\s*$/i]

const READY_GOAL_PATTERNS = [/目標\s*[：:]/i, /goal\s*[：:]/i]
const READY_SCOPE_PATTERNS = [/範圍\s*[：:]/i, /scope\s*[：:]/i]
const READY_DONE_PATTERNS = [/完成標準\s*[：:]/i, /done criteria\s*[：:]/i, /驗收\s*[：:]/i]

export function parseFreerunCommand(text: string): FreerunCommand | undefined {
  const match = /^\/freerun\s+(on|off|clear|arm|disarm)(?:\s+([\s\S]+))?\s*$/i.exec(text.trim())
  if (!match) return undefined
  const verb = match[1].toLowerCase() as FreerunCommand["verb"]
  if (verb === "arm") {
    const goal = match[2]?.trim()
    return goal ? { verb, goal } : { verb }
  }
  return { verb }
}

export function parseFreerunActivation(text: string): FreerunCommand | undefined {
  const command = parseFreerunCommand(text)
  if (command) return command
  const entry = classifyFreerunNaturalEntry(text)
  return entry.kind === "activate" ? entry.command : undefined
}

export function classifyFreerunNaturalEntry(text: string): FreerunNaturalEntry {
  const trimmed = text.trim()
  for (const pattern of STRONG_ARM_PATTERNS) {
    const match = pattern.exec(trimmed)
    if (!match) continue
    const goal = match[1]?.trim()
    if (goal) return { kind: "activate", command: { verb: "arm", goal } }
  }
  if (WEAK_ARM_PATTERNS.some((pattern) => pattern.test(trimmed))) return { kind: "clarify" }
  if (hasReadinessShape(trimmed)) return { kind: "ready", suggestion: "可進入 freerun 拆解執行" }
  return { kind: "none" }
}

function hasReadinessShape(text: string) {
  return (
    READY_GOAL_PATTERNS.some((pattern) => pattern.test(text)) &&
    READY_SCOPE_PATTERNS.some((pattern) => pattern.test(text)) &&
    READY_DONE_PATTERNS.some((pattern) => pattern.test(text))
  )
}
