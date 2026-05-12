import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const LOG_PREFIX = "[plan-builder-snapshot]"

function log(msg: string): void {
  console.error(`${LOG_PREFIX} ${msg}`)
}

function gitRootOf(p: string): string | null {
  try {
    return execFileSync("git", ["-C", p, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

function dateTag(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Files always preserved in the current root during refactor snapshot.
 * proposal.md is kept because its Why typically survives a refactor.
 * .state.json is kept so we can append history + reset state.
 * .archive/ is never moved.
 */
const REFACTOR_KEEP = new Set([".state.json", "proposal.md", ".archive"])

export interface SnapshotResult {
  snapshotPath: string
  relativeFromRoot: string
  movedFiles: string[]
}

/**
 * Snapshot current artifact set (except proposal.md, .state.json, .archive/) to .history/refactor-YYYY-MM-DD/.
 * Uses `git mv` so history is preserved.
 */
export function snapshotForRefactor(specRoot: string): SnapshotResult {
  const gitRoot = gitRootOf(specRoot)
  if (!gitRoot) {
    throw new Error(`snapshotForRefactor: ${specRoot} is not in a git working tree`)
  }

  const historyDir = path.join(specRoot, ".history")
  const tag = dateTag()
  let snapshotDir = path.join(historyDir, `refactor-${tag}`)

  // If today's snapshot already exists (e.g. two refactors in one day), append -N
  let n = 1
  while (existsSync(snapshotDir)) {
    n += 1
    snapshotDir = path.join(historyDir, `refactor-${tag}-${n}`)
  }

  mkdirSync(snapshotDir, { recursive: true })
  log(`Creating snapshot at ${path.relative(gitRoot, snapshotDir)}`)

  const entries = readdirSync(specRoot)
  const movedFiles: string[] = []

  for (const entry of entries) {
    if (REFACTOR_KEEP.has(entry)) continue
    if (entry === path.basename(historyDir)) continue // extra safety
    const from = path.join(specRoot, entry)
    const to = path.join(snapshotDir, entry)
    const fromRel = path.relative(gitRoot, from)
    const toRel = path.relative(gitRoot, to)

    // Only move tracked files/dirs via git mv. Untracked files get a plain rename (mkdirSync handled).
    try {
      execFileSync("git", ["-C", gitRoot, "mv", fromRel, toRel], {
        stdio: ["ignore", "pipe", "inherit"],
      })
      log(`git mv ${fromRel} → ${toRel}`)
      movedFiles.push(entry)
    } catch {
      // Fall back to plain rename for untracked artifacts (common when just drafted)
      try {
        const stat = statSync(from)
        if (stat.isDirectory()) {
          execFileSync("mv", [from, to])
        } else {
          execFileSync("mv", [from, to])
        }
        log(`mv (untracked) ${fromRel} → ${toRel}`)
        movedFiles.push(entry)
      } catch (e) {
        throw new Error(
          `Failed to move ${fromRel} to ${toRel}: ${(e as Error).message}`,
        )
      }
    }
  }

  return {
    snapshotPath: snapshotDir,
    relativeFromRoot: path.relative(specRoot, snapshotDir),
    movedFiles,
  }
}

export function findLatestRefactorSnapshot(specRoot: string): string | null {
  const historyDir = path.join(specRoot, ".history")
  if (!existsSync(historyDir)) return null
  const entries = readdirSync(historyDir)
    .filter((e) => e.startsWith("refactor-"))
    .sort()
  if (entries.length === 0) return null
  return path.join(historyDir, entries[entries.length - 1]!)
}
