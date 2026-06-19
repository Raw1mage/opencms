import path from "path"
import fs from "fs/promises"
import { Instance } from "../project/instance"
import type { PreloadParts } from "./context-preface-types"

/**
 * Phase B B.2.1 (DD-1): structured preload output. Producer for the T1
 * segment of the context preface (cwd listing + README summary). Pure data —
 * no XML wrapping; the consumer (context-preface.ts buildPreface) chooses
 * the wire format. Old skill_context payload removed: skills now flow
 * through SkillLayerRegistry into preface T2 segment, not preload.
 */
export async function getPreloadParts(_sessionID?: string): Promise<PreloadParts> {
  const root = Instance.worktree
  // RC-2 (bug_20260619_coding_subagent_cwd_root_pathloss): the absolute repo
  // root must lead the cwd listing. The `<env>` block (system.ts) carries
  // `Working directory:` only into the MAIN agent prompt — for subagents it
  // rides inside `agentsMd`, which prompt.ts gates to "" (session.parentID).
  // Preload, by contrast, reaches BOTH main and subagent prefaces ungated, so
  // anchoring the workspace root here is the single load-bearing fact a
  // file-editing worker needs to resolve relative paths instead of guessing.
  const workingDirectory = Instance.directory
  let cwdListing = ""
  try {
    const files = await fs.readdir(root)
    const listing = files.slice(0, 50).join("\n")
    cwdListing = files.length > 50 ? `${listing}\n... (truncated)` : listing
  } catch (e) {
    cwdListing = String(e)
  }
  // Prepend the absolute workspace root + a one-line directive so the listing
  // is interpreted as repo-relative, not as bare names under some inherited cwd.
  cwdListing =
    `Working directory (workspace root): ${workingDirectory}\n` +
    `All relative file paths resolve against this root. Use absolute paths or paths relative to it.\n\n` +
    cwdListing

  let readmeSummary = ""
  try {
    const candidates = ["README.md", "readme.md", "README.txt", "README"]
    for (const candidate of candidates) {
      const p = path.join(root, candidate)
      const exists = await fs
        .stat(p)
        .then(() => true)
        .catch(() => false)
      if (exists) {
        readmeSummary = await fs.readFile(p, "utf-8")
        readmeSummary = readmeSummary.slice(0, 1000)
        break
      }
    }
  } catch {
    readmeSummary = "Error reading README"
  }

  return { readmeSummary, cwdListing }
}

/**
 * Backwards-compatible string form of preloaded context. Wraps {@link
 * getPreloadParts} in the legacy `<preloaded_context>` XML envelope. Kept
 * for any caller still asking for the pre-Phase-B single-string output. New
 * code should call {@link getPreloadParts} and route through buildPreface.
 */
export async function getPreloadedContext(sessionID?: string): Promise<string> {
  const parts = await getPreloadParts(sessionID)
  return `
<preloaded_context>
<env_context>
<cwd_listing>
${parts.cwdListing}
</cwd_listing>
<readme_summary>
${parts.readmeSummary}
</readme_summary>
</env_context>
<skill_context>
</skill_context>
</preloaded_context>

Current directory, README, and core skills are already provided in <preloaded_context>. DO NOT run ls, read README, or load core skills.
`
}
