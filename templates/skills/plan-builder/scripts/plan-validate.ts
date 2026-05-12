#!/usr/bin/env bun
/**
 * plan-validate.ts — State-aware validation of a spec package.
 *
 * Reads specs/<slug>/.state.json, then only checks the artifacts required
 * for the current state (per SKILL.md §4 matrix). Missing artifacts for
 * future states are NOT blockers.
 *
 * Usage: bun run scripts/plan-validate.ts <path>
 *
 * Exit codes:
 *   0 — all required artifacts pass
 *   1 — blockers found (printed)
 *   2 — usage error
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { ensureNewFormat } from "./lib/ensure-new-format"
import { readState, STATES, type State } from "./lib/state"

function usage(exitCode = 2): never {
  console.error(`Usage: bun run plan-validate.ts <path>`)
  process.exit(exitCode)
}

interface ArtifactCheck {
  name: string
  kind: "markdown" | "json"
  requiredHeadings?: string[]
  minTasks?: boolean
  customCheck?: (body: string) => string[]
}

const PROPOSAL: ArtifactCheck = {
  name: "proposal.md",
  kind: "markdown",
  requiredHeadings: ["Why", "What Changes", "Capabilities", "Impact"],
}

const SPEC: ArtifactCheck = {
  name: "spec.md",
  kind: "markdown",
  requiredHeadings: ["Purpose", "Requirements", "Acceptance Checks"],
  customCheck: (body) => {
    const issues: string[] = []
    if (!/###\s+Requirement:/m.test(body))
      issues.push("must have at least one `### Requirement:` section")
    if (!/####\s+Scenario:/m.test(body))
      issues.push("must have at least one `#### Scenario:` section")
    return issues
  },
}

const DESIGN: ArtifactCheck = {
  name: "design.md",
  kind: "markdown",
  requiredHeadings: ["Context", "Goals / Non-Goals", "Decisions", "Risks / Trade-offs", "Critical Files"],
}

const TASKS: ArtifactCheck = {
  name: "tasks.md",
  kind: "markdown",
  customCheck: (body) => {
    const issues: string[] = []
    const hasHeading = /^#\s+Tasks/m.test(body) || /^##\s+\d/m.test(body)
    if (!hasHeading) issues.push("must have a Tasks heading")
    const unchecked = body.split(/\n+/).filter((l) => /^-\s*\[\s\]\s+/.test(l.trim()))
    if (unchecked.length === 0)
      issues.push("must have at least one unchecked `- [ ]` checklist item")
    return issues
  },
}

const HANDOFF: ArtifactCheck = {
  name: "handoff.md",
  kind: "markdown",
  requiredHeadings: ["Execution Contract", "Required Reads", "Stop Gates In Force", "Execution-Ready Checklist"],
}

const IDEF0: ArtifactCheck = {
  name: "idef0.json",
  kind: "json",
  customCheck: (body) => {
    const issues: string[] = []
    let obj: any
    try {
      obj = JSON.parse(body)
    } catch {
      return ["not valid JSON"]
    }
    if (typeof obj.diagram_title !== "string" || !obj.diagram_title)
      issues.push("missing diagram_title")
    if (!/^A\d+$/.test(obj.node_reference)) issues.push("missing or invalid node_reference")
    if (!Array.isArray(obj.activities) || obj.activities.length === 0)
      issues.push("must have at least one activity")
    return issues
  },
}

const GRAFCET: ArtifactCheck = {
  name: "grafcet.json",
  kind: "json",
  customCheck: (body) => {
    const issues: string[] = []
    let obj: any
    try {
      obj = JSON.parse(body)
    } catch {
      return ["not valid JSON"]
    }
    if (!Array.isArray(obj) || obj.length === 0)
      issues.push("must be a non-empty array of steps")
    return issues
  },
}

const C4: ArtifactCheck = {
  name: "c4.json",
  kind: "json",
  customCheck: (body) => {
    const issues: string[] = []
    let obj: any
    try {
      obj = JSON.parse(body)
    } catch {
      return ["not valid JSON"]
    }
    for (const k of ["systems", "containers", "components", "relationships"]) {
      if (!Array.isArray(obj[k]) || obj[k].length === 0)
        issues.push(`must have at least one ${k.replace(/s$/, "")}`)
    }
    return issues
  },
}

const SEQUENCE: ArtifactCheck = {
  name: "sequence.json",
  kind: "json",
  customCheck: (body) => {
    const issues: string[] = []
    let obj: any
    try {
      obj = JSON.parse(body)
    } catch {
      return ["not valid JSON"]
    }
    if (!Array.isArray(obj) || obj.length === 0)
      issues.push("must be a non-empty array of sequence diagrams")
    return issues
  },
}

const DATA_SCHEMA: ArtifactCheck = {
  name: "data-schema.json",
  kind: "json",
  customCheck: (body) => {
    try {
      JSON.parse(body)
      return []
    } catch {
      return ["not valid JSON"]
    }
  },
}

const TEST_VECTORS: ArtifactCheck = {
  name: "test-vectors.json",
  kind: "json",
  customCheck: (body) => {
    const issues: string[] = []
    let obj: any
    try {
      obj = JSON.parse(body)
    } catch {
      return ["not valid JSON"]
    }
    if (!Array.isArray(obj) || obj.length === 0)
      issues.push("must be a non-empty array of test vectors")
    return issues
  },
}

const ERRORS: ArtifactCheck = {
  name: "errors.md",
  kind: "markdown",
  requiredHeadings: ["Error Catalogue"],
}

const OBSERVABILITY: ArtifactCheck = {
  name: "observability.md",
  kind: "markdown",
  requiredHeadings: ["Events", "Metrics"],
}

// State-driven artifact requirements
const REQUIREMENTS: Record<State, ArtifactCheck[]> = {
  proposed: [PROPOSAL],
  designed: [PROPOSAL, SPEC, DESIGN, IDEF0, GRAFCET, C4, SEQUENCE, DATA_SCHEMA],
  planned: [PROPOSAL, SPEC, DESIGN, IDEF0, GRAFCET, C4, SEQUENCE, DATA_SCHEMA, TASKS, HANDOFF, TEST_VECTORS, ERRORS, OBSERVABILITY],
  implementing: [PROPOSAL, SPEC, DESIGN, IDEF0, GRAFCET, C4, SEQUENCE, DATA_SCHEMA, TASKS, HANDOFF, TEST_VECTORS, ERRORS, OBSERVABILITY],
  verified: [PROPOSAL, SPEC, DESIGN, IDEF0, GRAFCET, C4, SEQUENCE, DATA_SCHEMA, TASKS, HANDOFF, TEST_VECTORS, ERRORS, OBSERVABILITY],
  living: [PROPOSAL, SPEC, DESIGN, IDEF0, GRAFCET, C4, SEQUENCE, DATA_SCHEMA, TASKS, HANDOFF, TEST_VECTORS, ERRORS, OBSERVABILITY],
  archived: [PROPOSAL, SPEC, DESIGN, IDEF0, GRAFCET, C4, SEQUENCE, DATA_SCHEMA, TASKS, HANDOFF, TEST_VECTORS, ERRORS, OBSERVABILITY],
}

function extractSection(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`(^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i")
  const m = markdown.match(re)
  return m?.[2]?.trim() ?? ""
}

function validateArtifact(specRoot: string, check: ArtifactCheck): string[] {
  const filePath = path.join(specRoot, check.name)
  if (!existsSync(filePath)) {
    return [`${check.name} is missing`]
  }
  const body = readFileSync(filePath, "utf8")
  if (!body.trim()) return [`${check.name} is empty`]

  const issues: string[] = []
  if (check.kind === "markdown") {
    if (check.requiredHeadings) {
      const missing = check.requiredHeadings.filter((h) => !extractSection(body, h))
      if (missing.length > 0)
        issues.push(`missing headings: ${missing.join(", ")}`)
    }
  }
  if (check.customCheck) {
    issues.push(...check.customCheck(body))
  }
  return issues.map((m) => `${check.name}: ${m}`)
}

function main(): void {
  const rawArgs = process.argv.slice(2)
  let asStateOverride: State | undefined
  const positional: string[] = []
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!
    if (arg === "--as-state") asStateOverride = rawArgs[++i] as State
    else if (arg.startsWith("--as-state=")) asStateOverride = arg.slice("--as-state=".length) as State
    else if (!arg.startsWith("--")) positional.push(arg)
  }
  if (positional.length !== 1) usage()

  const input = positional[0]!
  if (!existsSync(input)) {
    console.error(`plan-validate: path does not exist: ${input}`)
    process.exit(1)
  }

  const { finalPath } = ensureNewFormat(input)
  const state = readState(finalPath)
  const checkState = asStateOverride ?? state.state

  if (!STATES.includes(checkState)) {
    console.error(`plan-validate: invalid state "${checkState}"`)
    process.exit(1)
  }

  const requirements = REQUIREMENTS[checkState]
  const noteOverride = asStateOverride ? ` (override from actual state=${state.state})` : ""
  console.error(`plan-validate: checking ${requirements.length} artifact(s) for state=${checkState}${noteOverride}`)

  const issues: string[] = []
  for (const req of requirements) {
    issues.push(...validateArtifact(finalPath, req))
  }

  if (issues.length > 0) {
    console.error(`FAIL — ${issues.length} blocker(s) for state=${checkState}:\n`)
    for (const issue of issues) console.error(`  - ${issue}`)
    process.exit(1)
  }

  console.log(`PASS — all ${requirements.length} artifact(s) required for state=${checkState} are valid.`)
}

main()
