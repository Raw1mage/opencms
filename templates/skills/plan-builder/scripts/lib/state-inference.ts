import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { State } from "./state"
import { hasStateFile, readState } from "./state"

export class StateInferenceError extends Error {
  constructor(
    public readonly specPath: string,
    public readonly observed: Record<string, boolean>,
    message: string,
  ) {
    super(message)
    this.name = "StateInferenceError"
  }
}

interface ArtifactPresence {
  proposal: boolean
  spec: boolean
  design: boolean
  tasks: boolean
  handoff: boolean
  idef0: boolean
  c4: boolean
  sequence: boolean
  dataSchema: boolean
  tasksAnyChecked: boolean
  tasksAllChecked: boolean
  tasksHasItems: boolean
  validationEvidence: boolean
}

function inspectArtifacts(specPath: string): ArtifactPresence {
  const proposal = existsSync(path.join(specPath, "proposal.md"))
  const spec = existsSync(path.join(specPath, "spec.md"))
  const design = existsSync(path.join(specPath, "design.md"))
  const tasksPath = path.join(specPath, "tasks.md")
  const tasks = existsSync(tasksPath)
  const handoffPath = path.join(specPath, "handoff.md")
  const handoff = existsSync(handoffPath)
  const idef0 = existsSync(path.join(specPath, "idef0.json"))
  const c4 = existsSync(path.join(specPath, "c4.json"))
  const sequence = existsSync(path.join(specPath, "sequence.json"))
  const dataSchema = existsSync(path.join(specPath, "data-schema.json"))

  let tasksAnyChecked = false
  let tasksAllChecked = false
  let tasksHasItems = false
  if (tasks) {
    const body = readFileSync(tasksPath, "utf8")
    const uncheckedRe = /^-\s*\[\s\]\s+/m
    const checkedRe = /^-\s*\[x\]\s+/im
    tasksAnyChecked = checkedRe.test(body)
    const hasUnchecked = uncheckedRe.test(body)
    tasksHasItems = tasksAnyChecked || hasUnchecked
    tasksAllChecked = tasksHasItems && !hasUnchecked
  }

  let validationEvidence = false
  if (handoff) {
    const body = readFileSync(handoffPath, "utf8").toLowerCase()
    validationEvidence =
      /all tests?\s*pass/.test(body) ||
      /validation evidence/.test(body) ||
      /acceptance checks?\s*(pass|complete)/.test(body)
  }

  return {
    proposal,
    spec,
    design,
    tasks,
    handoff,
    idef0,
    c4,
    sequence,
    dataSchema,
    tasksAnyChecked,
    tasksAllChecked,
    tasksHasItems,
    validationEvidence,
  }
}

/**
 * Deterministic state inference for legacy (pre-.state.json) plan folders.
 * Returns the inferred state, or throws StateInferenceError if no rule matches.
 */
export function inferState(specPath: string): State {
  // Rule 1: archive folder
  if (/\/archive\//.test(specPath) || /\\archive\\/.test(specPath)) {
    return "archived"
  }

  // Rule 2: already has .state.json → trust it
  if (hasStateFile(specPath)) {
    return readState(specPath).state
  }

  const a = inspectArtifacts(specPath)

  // Rule 7: tasks.md all checked + validation evidence → verified
  if (a.tasks && a.tasksAllChecked && a.validationEvidence) {
    return "verified"
  }

  // Rule 5/6: tasks.md state
  if (a.tasks && a.tasksHasItems) {
    if (a.tasksAnyChecked) {
      // some checked, not all with evidence
      if (a.tasksAllChecked) return "verified"
      return "implementing"
    }
    return "planned"
  }

  // Rule 4: design / c4 / IDEF0 exist but no tasks → designed
  if (a.proposal && (a.design || a.c4 || a.idef0 || a.sequence || a.dataSchema || a.spec)) {
    return "designed"
  }

  // Rule 3: only proposal → proposed
  if (a.proposal && !a.spec && !a.design && !a.tasks) {
    return "proposed"
  }

  // Rule 8: specs/<slug>/ path but no .state.json → living (formalized legacy)
  // Match only when parent directory is exactly "specs" (not plans)
  const parent = path.basename(path.dirname(specPath))
  if (parent === "specs" && a.proposal) {
    return "living"
  }

  throw new StateInferenceError(
    specPath,
    a as unknown as Record<string, boolean>,
    `State inference failed for ${specPath}. ` +
      `Observed: ${JSON.stringify(a)}. ` +
      `No rule matches. AGENTS.md rule 1 forbids silent defaults — ` +
      `please inspect the folder and either normalize the artifact set or manually create .state.json with an explicit state.`,
  )
}
