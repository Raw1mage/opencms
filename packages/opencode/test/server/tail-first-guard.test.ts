// mobile-tail-first-simplification DD-9 / Phase 8.1:
// ensure the removed continuity symbols never re-appear in the source tree.
// spec/docs dirs are exempt because they legitimately document the removal.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const repoRoot = new URL("../../../../", import.meta.url).pathname
const FORBIDDEN = [
  "Last-Event-ID",
  "last-event-id",
  "beforeMessageID",
  "forceRefetch",
  "use-session-resume-sync",
  "SseBufferEntry",
  "sseReplay",
  "sse_reconnect_replay",
  "sseGetBoundedSince",
  "clipReplayWindow",
  "buildHandshakeReplayPlan",
]

const SCAN_DIRS = ["packages/opencode/src", "packages/app/src", "packages/ui/src"]
const EXCLUDE = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "__tests__",
  "test",
  "specs",
  "docs",
])

function* walk(dir: string): Generator<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (EXCLUDE.has(name)) continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) yield* walk(p)
    else if (st.isFile() && /\.(ts|tsx|js|jsx)$/.test(name) && !/\.test\.(ts|tsx|js|jsx)$/.test(name)) {
      yield p
    }
  }
}

describe("tail-first-guard: forbidden continuity symbols", () => {
  it("source tree does not contain removed continuity symbols", () => {
    const violations: string[] = []
    for (const rel of SCAN_DIRS) {
      const abs = join(repoRoot, rel)
      for (const file of walk(abs)) {
        const body = readFileSync(file, "utf8")
        for (const symbol of FORBIDDEN) {
          if (body.includes(symbol)) {
            violations.push(`${relative(repoRoot, file)}: contains "${symbol}"`)
          }
        }
      }
    }
    if (violations.length > 0) {
      console.error("Forbidden-symbol violations:\n" + violations.join("\n"))
    }
    expect(violations).toEqual([])
  })
})
