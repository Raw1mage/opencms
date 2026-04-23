import { promises as fs } from "node:fs"
import { join } from "node:path"
import { Instance } from "@/project/instance"
import { Todo } from "@/session/todo"
import { Log } from "@/util/log"

const log = Log.create({ service: "autorun.refill" })

/**
 * specs/autonomous-opt-in/ Phase 6 (new Phase 3 under main-as-SSOT revision)
 * — auto-refill the todolist from the session's active spec tasks.md.
 *
 * Without binding (main's SSOT), we locate the "active" spec by convention:
 * any `specs/<slug>/` whose `.state.json.state === "implementing"` under
 * `Instance.directory`. If zero or multiple matches, refill declines.
 *
 * Task checkbox vocabulary (from plan-builder §16.2):
 *   [ ] pending   [x] completed   [~] in-progress   [!] blocked
 *   [>] delegated [?] decision    [-] cancelled
 *
 * Phase selection: lowest-numbered `## N.` block that contains at least one
 * `[ ]` item. Cancelled `[-]` items are ignored (neither pending nor done).
 */

export interface ParsedTaskItem {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed" | "blocked" | "cancelled" | "other"
}

export interface ParsedPhase {
  number: number
  title: string
  items: ParsedTaskItem[]
}

const PHASE_HEADING_RE = /^##\s+(\d+)\.\s+(.+?)\s*$/
const ITEM_LINE_RE = /^-\s*\[([ x~!>?\-])\]\s*(.+?)\s*$/

function mapCheckbox(ch: string): ParsedTaskItem["status"] {
  switch (ch) {
    case " ":
      return "pending"
    case "x":
      return "completed"
    case "~":
      return "in_progress"
    case "!":
      return "blocked"
    case "-":
      return "cancelled"
    case ">":
    case "?":
      return "other"
    default:
      return "other"
  }
}

/**
 * Pure: parse tasks.md into phase blocks with their items. Non-phase
 * headings (e.g. `## Revision`, `## What Changes`) are ignored.
 */
export function parseTasks(markdown: string): ParsedPhase[] {
  const lines = markdown.split(/\r?\n/)
  const phases: ParsedPhase[] = []
  let current: ParsedPhase | null = null

  for (const line of lines) {
    const headingMatch = PHASE_HEADING_RE.exec(line)
    if (headingMatch) {
      if (current) phases.push(current)
      current = {
        number: Number.parseInt(headingMatch[1], 10),
        title: headingMatch[2],
        items: [],
      }
      continue
    }
    if (!current) continue
    const itemMatch = ITEM_LINE_RE.exec(line)
    if (itemMatch) {
      const [, statusChar, content] = itemMatch
      current.items.push({
        id: `task_${current.number}_${current.items.length + 1}`,
        content: content.replace(/\s+$/, ""),
        status: mapCheckbox(statusChar),
      })
    }
  }
  if (current) phases.push(current)
  return phases
}

/**
 * Pure: given parsed phases, return the lowest-numbered phase that still
 * has at least one `pending` item. Phases with only cancelled/completed
 * items are skipped. Returns null if no such phase exists.
 */
export function findRefillCandidate(phases: ParsedPhase[]): ParsedPhase | null {
  const sorted = [...phases].sort((a, b) => a.number - b.number)
  for (const phase of sorted) {
    const hasPending = phase.items.some((i) => i.status === "pending")
    if (hasPending) return phase
  }
  return null
}

/**
 * Pure: convert a parsed phase into fresh TodoWrite seed items. Only
 * pending items are materialized; in_progress / blocked / etc. are not
 * re-seeded since they're conceptually already active.
 */
export function phaseToTodoSeed(phase: ParsedPhase): Todo.Info[] {
  const pending = phase.items.filter((i) => i.status === "pending")
  return pending.map((item, idx) => ({
    id: `refill_${phase.number}_${idx + 1}_${Date.now()}`,
    content: item.content,
    status: "pending" as const,
    priority: "medium" as const,
  }))
}

export interface RefillResult {
  refilled: boolean
  reason:
    | "materialized"
    | "no_spec_found"
    | "multiple_specs_found"
    | "spec_not_implementing"
    | "tasks_unparseable"
    | "no_pending_phase"
  specSlug?: string
  phase?: { number: number; title: string; itemCount: number }
}

/**
 * Impure: locate the active spec's tasks.md under Instance.directory,
 * parse it, and materialize the next phase's pending items via
 * Todo.update(mode=plan_materialization). Returns a result telling the
 * caller whether a refill occurred and why.
 */
export async function attemptRefill(sessionID: string): Promise<RefillResult> {
  let specsDir: string
  try {
    specsDir = join(Instance.directory, "specs")
  } catch {
    return { refilled: false, reason: "no_spec_found" }
  }

  let specFolders: string[]
  try {
    const entries = await fs.readdir(specsDir, { withFileTypes: true })
    specFolders = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name)
  } catch {
    return { refilled: false, reason: "no_spec_found" }
  }

  // Find spec(s) in state=implementing
  const implementingSlugs: string[] = []
  for (const slug of specFolders) {
    const statePath = join(specsDir, slug, ".state.json")
    try {
      const raw = await fs.readFile(statePath, "utf8")
      const parsed = JSON.parse(raw) as { state?: string }
      if (parsed.state === "implementing") implementingSlugs.push(slug)
    } catch {
      // skip — not every folder is a plan-builder spec
    }
  }

  if (implementingSlugs.length === 0) return { refilled: false, reason: "no_spec_found" }
  if (implementingSlugs.length > 1) {
    log.warn("refill: multiple specs in implementing state, declining", {
      sessionID,
      specs: implementingSlugs,
    })
    return { refilled: false, reason: "multiple_specs_found" }
  }
  const slug = implementingSlugs[0]
  const tasksPath = join(specsDir, slug, "tasks.md")

  let tasksContent: string
  try {
    tasksContent = await fs.readFile(tasksPath, "utf8")
  } catch {
    return { refilled: false, reason: "tasks_unparseable", specSlug: slug }
  }

  const phases = parseTasks(tasksContent)
  if (phases.length === 0) return { refilled: false, reason: "tasks_unparseable", specSlug: slug }

  const candidate = findRefillCandidate(phases)
  if (!candidate) return { refilled: false, reason: "no_pending_phase", specSlug: slug }

  const seed = phaseToTodoSeed(candidate)
  if (seed.length === 0) return { refilled: false, reason: "no_pending_phase", specSlug: slug }

  await Todo.update({
    sessionID,
    todos: seed,
    mode: "plan_materialization",
  })

  log.info("autorun refill materialized", {
    sessionID,
    specSlug: slug,
    phase: candidate.number,
    itemCount: seed.length,
  })

  return {
    refilled: true,
    reason: "materialized",
    specSlug: slug,
    phase: { number: candidate.number, title: candidate.title, itemCount: seed.length },
  }
}
