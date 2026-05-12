import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync } from "node:fs"
import path from "node:path"
import { inferState } from "./state-inference"
import {
  currentUser,
  nowIso,
  hasStateFile,
  writeState,
  type HistoryEntry,
  type StateFile,
} from "./state"

const LOG_PREFIX = "[plan-builder-migrate]"

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

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  })
}

function timestampTag(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

interface EnsureResult {
  changed: boolean
  finalPath: string
  inferredState?: string
}

/**
 * Idempotent migration wrapper.
 * - If `path` is already a new-format spec (has .state.json): no-op.
 * - If `path` is a legacy plans/<slug>/: infer state, snapshot, git mv to specs/<slug>/, write .state.json.
 * Returns the final canonical specs/<slug>/ path.
 */
export function ensureNewFormat(inputPath: string): EnsureResult {
  const abs = path.resolve(inputPath)

  // Already new format
  if (hasStateFile(abs)) {
    return { changed: false, finalPath: abs }
  }

  // Determine if this looks like a legacy plans/<slug>/ path
  const parent = path.basename(path.dirname(abs))
  const slug = path.basename(abs)

  if (parent !== "plans") {
    // Not under plans/ and no .state.json → either a raw specs/<slug>/ without state,
    // or something unexpected. Try to infer + write .state.json in place.
    if (parent === "specs") {
      const inferred = inferState(abs)
      log(`Pre-existing specs/${slug}/ without .state.json; inferring state=${inferred} and writing .state.json in place`)
      const stateFile: StateFile = {
        schema_version: 1,
        state: inferred,
        profile: [],
        history: [
          {
            from: null,
            to: inferred,
            at: nowIso(),
            by: currentUser(),
            mode: "migration",
            reason: "inferred state for formalized legacy spec without .state.json",
          } satisfies HistoryEntry,
        ],
      }
      writeState(abs, stateFile)
      return { changed: true, finalPath: abs, inferredState: inferred }
    }

    throw new Error(
      `ensureNewFormat: ${abs} is not a recognizable legacy plans/ or specs/ path; parent is "${parent}". Refuse to migrate.`,
    )
  }

  // Full legacy migration path: plans/<slug>/ → specs/<slug>/
  const gitRoot = gitRootOf(abs)
  const mainRoot = gitRoot ?? path.dirname(path.dirname(abs))

  const specsDir = path.join(mainRoot, "specs")
  const destination = path.join(specsDir, slug)
  const archiveDir = path.join(destination, ".archive")
  const tag = timestampTag()
  const snapshotDir = path.join(archiveDir, `pre-migration-${tag}`)

  log(`Legacy plan detected: ${path.relative(mainRoot, abs)}`)

  const inferred = inferState(abs)
  log(`Inferred state: ${inferred}`)

  // Conflict: both plans/<slug>/ and specs/<slug>/ exist
  if (existsSync(destination)) {
    const formalizedSnapshotDir = path.join(
      destination,
      ".archive",
      `pre-migration-formalized-${tag}`,
    )
    log(`Conflict: specs/${slug}/ already exists — moving existing contents to ${path.relative(mainRoot, formalizedSnapshotDir)}`)
    mkdirSync(formalizedSnapshotDir, { recursive: true })
    for (const entry of readdirSync(destination)) {
      if (entry === ".archive") continue
      const from = path.join(destination, entry)
      const to = path.join(formalizedSnapshotDir, entry)
      renameSync(from, to)
    }
  }

  // Ensure destination parent exists for git mv
  mkdirSync(specsDir, { recursive: true })

  // Snapshot the legacy directory to the destination's .archive/ BEFORE moving the original.
  // Use cp so the snapshot exists as a detached copy even after git mv.
  // Stage directory must be under destination; create it under a temp-ish location, then move in.
  // Simpler: snapshot to a temporary sibling, then re-parent after git mv.
  const tempSnapshotParent = path.join(specsDir, `.plan-builder-tmp-${slug}-${tag}`)
  mkdirSync(tempSnapshotParent, { recursive: true })
  cpSync(abs, path.join(tempSnapshotParent, "content"), { recursive: true, dereference: false })
  log(`Snapshotted legacy content to staging area`)

  // Move plans/<slug>/ → specs/<slug>/
  // If any file under plans/<slug>/ is tracked in git → git mv (preserves history per file).
  // If entire directory is untracked (never committed) → plain mv is correct; nothing to preserve.
  // Never silently fall back between these cases; both branches log their rationale.
  const srcRel = path.relative(mainRoot, abs)
  const dstRel = path.relative(mainRoot, destination)
  let trackedFiles: string[] = []
  try {
    const out = execFileSync("git", ["-C", mainRoot, "ls-files", "--", srcRel], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    trackedFiles = out.split("\n").map((l) => l.trim()).filter(Boolean)
  } catch {
    trackedFiles = []
  }

  if (trackedFiles.length > 0) {
    try {
      runGit(mainRoot, ["mv", srcRel, dstRel])
      log(`git mv ${srcRel} → ${dstRel} (${trackedFiles.length} tracked file(s); git history preserved)`)
    } catch (e) {
      throw new Error(
        `git mv failed even though ${trackedFiles.length} file(s) are tracked; refuse to fall back to plain mv without user approval. Underlying error: ${(e as Error).message}`,
      )
    }
  } else {
    log(`${srcRel} has no tracked files; using plain mv (nothing to preserve in git history)`)
    try {
      renameSync(abs, destination)
      log(`mv ${srcRel} → ${dstRel}`)
    } catch (e) {
      throw new Error(`plain mv failed: ${(e as Error).message}`)
    }
  }

  // Install the snapshot into the new destination's .archive/
  mkdirSync(archiveDir, { recursive: true })
  renameSync(path.join(tempSnapshotParent, "content"), snapshotDir)
  // Remove the temp parent (should be empty now)
  try {
    execFileSync("rmdir", [tempSnapshotParent])
  } catch {
    /* ignore */
  }
  log(`Installed pre-migration snapshot at ${path.relative(mainRoot, snapshotDir)}`)

  // Write .state.json
  const stateFile: StateFile = {
    schema_version: 1,
    state: inferred,
    profile: [],
    history: [
      {
        from: null,
        to: inferred,
        at: nowIso(),
        by: currentUser(),
        mode: "migration",
        reason: `peaceful on-touch migration from plans/${slug}/`,
        snapshot: path.relative(destination, snapshotDir),
      } satisfies HistoryEntry,
    ],
  }
  writeState(destination, stateFile)
  log(`Wrote .state.json {state: "${inferred}", history: [migration]}`)

  return { changed: true, finalPath: destination, inferredState: inferred }
}
