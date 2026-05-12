#!/usr/bin/env bun
/**
 * plan-gaps.ts — Analyze a spec for code-independence gaps.
 *
 * The goal: report what a build agent would have to guess at if it tried to
 * implement from the spec alone. A higher score means the spec is closer to
 * "80% of the effort upfront, 20% mechanical codegen."
 *
 * Usage: bun run scripts/plan-gaps.ts <path> [--json]
 *
 * Exit codes:
 *   0 — analysis complete (regardless of score)
 *   1 — spec not found or unreadable
 *   2 — usage error
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { ensureNewFormat } from "./lib/ensure-new-format"

function usage(exitCode = 2): never {
  console.error(`Usage: bun run plan-gaps.ts <path> [--json]`)
  process.exit(exitCode)
}

interface Gap {
  severity: "blocker" | "warning" | "info"
  artifact: string
  message: string
}

function main(): void {
  const args = process.argv.slice(2)
  const asJson = args.includes("--json")
  const positional = args.filter((a) => !a.startsWith("--"))
  if (positional.length !== 1) usage()
  const inputPath = positional[0]!

  if (!existsSync(inputPath)) {
    console.error(`plan-gaps: path does not exist: ${inputPath}`)
    process.exit(1)
  }

  const { finalPath } = ensureNewFormat(inputPath)
  const gaps: Gap[] = []

  // --- data-schema.json ---
  const dataSchemaPath = path.join(finalPath, "data-schema.json")
  if (!existsSync(dataSchemaPath)) {
    gaps.push({
      severity: "blocker",
      artifact: "data-schema.json",
      message: "missing — without a typed data schema, codegen cannot produce types deterministically",
    })
  } else {
    try {
      const schema = JSON.parse(readFileSync(dataSchemaPath, "utf8"))
      const props = collectProps(schema)
      if (props.size === 0) {
        gaps.push({
          severity: "blocker",
          artifact: "data-schema.json",
          message: "has no properties declared",
        })
      }
      const untyped = [...props.entries()].filter(([, info]) => !info.hasType)
      if (untyped.length > 0) {
        gaps.push({
          severity: "warning",
          artifact: "data-schema.json",
          message: `${untyped.length} field(s) missing explicit type: ${untyped.slice(0, 5).map(([k]) => k).join(", ")}${untyped.length > 5 ? "..." : ""}`,
        })
      }
    } catch {
      gaps.push({
        severity: "blocker",
        artifact: "data-schema.json",
        message: "not valid JSON",
      })
    }
  }

  // --- test-vectors.json ---
  const tvPath = path.join(finalPath, "test-vectors.json")
  const spec = readIfExists(path.join(finalPath, "spec.md"))
  let requirementCount = 0
  if (spec) {
    requirementCount = (spec.match(/^###\s+Requirement:/gm) ?? []).length
  }
  if (!existsSync(tvPath)) {
    gaps.push({
      severity: requirementCount > 0 ? "warning" : "info",
      artifact: "test-vectors.json",
      message: `missing — ${requirementCount} Requirement(s) in spec.md cannot generate executable tests without vectors`,
    })
  } else {
    try {
      const vectors = JSON.parse(readFileSync(tvPath, "utf8"))
      if (!Array.isArray(vectors) || vectors.length === 0) {
        gaps.push({
          severity: "warning",
          artifact: "test-vectors.json",
          message: "empty or not an array",
        })
      } else if (requirementCount > 0 && vectors.length < requirementCount) {
        gaps.push({
          severity: "warning",
          artifact: "test-vectors.json",
          message: `${vectors.length} vector(s) for ${requirementCount} requirement(s) — coverage below 1:1`,
        })
      }
    } catch {
      gaps.push({
        severity: "blocker",
        artifact: "test-vectors.json",
        message: "not valid JSON",
      })
    }
  }

  // --- errors.md ---
  const errorsPath = path.join(finalPath, "errors.md")
  if (!existsSync(errorsPath)) {
    gaps.push({
      severity: "warning",
      artifact: "errors.md",
      message: "missing — error types will be invented ad-hoc during implementation",
    })
  } else {
    const body = readFileSync(errorsPath, "utf8")
    const codeLines = body.split("\n").filter((l) => /^[-*]\s+[A-Z0-9_]{3,}\b/.test(l))
    if (codeLines.length === 0) {
      gaps.push({
        severity: "warning",
        artifact: "errors.md",
        message: "no recognizable error codes (expected bullet items starting with uppercase tokens like `- AUTH_EXPIRED`)",
      })
    }
  }

  // --- observability.md ---
  const obsPath = path.join(finalPath, "observability.md")
  if (!existsSync(obsPath)) {
    gaps.push({
      severity: "info",
      artifact: "observability.md",
      message: "missing — events/metrics/logs will be invented during implementation",
    })
  }

  // --- invariants.md ---
  const invPath = path.join(finalPath, "invariants.md")
  if (!existsSync(invPath)) {
    gaps.push({
      severity: "info",
      artifact: "invariants.md",
      message: "missing — cross-cut guarantees (e.g. 'token follows account') may not survive codegen",
    })
  }

  // --- spec.md GIVEN/WHEN/THEN abstractness ---
  if (spec) {
    const scenarios = spec.match(/####\s+Scenario:[\s\S]*?(?=####\s+Scenario:|###\s+|##\s+|$)/g) ?? []
    const abstract = scenarios.filter((s) => {
      return !/`[^`]+`/.test(s) && !/\[A-Z0-9_]{3,}/.test(s)
    }).length
    if (scenarios.length > 0 && abstract === scenarios.length) {
      gaps.push({
        severity: "info",
        artifact: "spec.md",
        message: `${scenarios.length} scenario(s) all abstract (no literal values / codes in GIVEN/WHEN/THEN) — concrete examples would increase codegen readiness`,
      })
    }
  }

  // Score
  const weight = { blocker: 25, warning: 10, info: 3 } as const
  const lost = gaps.reduce((acc, g) => acc + weight[g.severity], 0)
  const score = Math.max(0, 100 - lost)

  let readiness: "HIGH" | "MEDIUM" | "LOW"
  if (score >= 85) readiness = "HIGH"
  else if (score >= 60) readiness = "MEDIUM"
  else readiness = "LOW"

  if (asJson) {
    console.log(JSON.stringify({ path: finalPath, score, readiness, gaps }, null, 2))
    return
  }

  console.log(`Code-Independence Score: ${score}% (${readiness})\n`)
  if (gaps.length === 0) {
    console.log(`No gaps detected. Spec looks ready for mechanical codegen.`)
    return
  }
  const bySeverity = { blocker: [] as Gap[], warning: [] as Gap[], info: [] as Gap[] }
  for (const g of gaps) bySeverity[g.severity].push(g)
  for (const sev of ["blocker", "warning", "info"] as const) {
    const bucket = bySeverity[sev]
    if (bucket.length === 0) continue
    console.log(`${sev.toUpperCase()}:`)
    for (const g of bucket) console.log(`  • [${g.artifact}] ${g.message}`)
    console.log()
  }
}

interface PropInfo {
  hasType: boolean
}

function collectProps(schema: unknown, out = new Map<string, PropInfo>()): Map<string, PropInfo> {
  if (!schema || typeof schema !== "object") return out
  if (Array.isArray(schema)) {
    for (const item of schema) collectProps(item, out)
    return out
  }
  const obj = schema as Record<string, unknown>
  if (obj.properties && typeof obj.properties === "object") {
    for (const [field, def] of Object.entries(obj.properties as Record<string, unknown>)) {
      const defObj = (def ?? {}) as Record<string, unknown>
      const hasType =
        typeof defObj.type === "string" ||
        Array.isArray(defObj.type) ||
        "$ref" in defObj ||
        "oneOf" in defObj ||
        "anyOf" in defObj ||
        "allOf" in defObj ||
        "const" in defObj ||
        "enum" in defObj
      out.set(field, { hasType })
      collectProps(def, out)
    }
  }
  for (const v of Object.values(obj)) collectProps(v, out)
  return out
}

function readIfExists(p: string): string | null {
  if (!existsSync(p)) return null
  return readFileSync(p, "utf8")
}

main()
