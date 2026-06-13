/**
 * harness/freerun-mode — per-node markdown file storage.
 *
 * Disk layout (under Global.Path.data):
 *
 *   storage/freerun/<sessionId>/
 *     meta.json                         FreerunSessionMeta
 *     tree/<nodeId>.md                  one file per ContextNode
 *     tree/.archive/<ts>/<nodeId>.md    archived children after consolidation
 *
 * File format per node:
 *
 *   ---
 *   id: "root"
 *   parent_id: null
 *   children_ids: ["c1","c2"]
 *   title: "..."
 *   mode: "pending-exec"
 *   created_at: "<iso>"
 *   updated_at: "<iso>"
 *   iteration_count: 3
 *   relevant_tools: ["bash","read"]
 *   relevant_skills: []
 *   ---
 *
 *   <body text — free-form description of the node's intent/scope>
 *
 *   ```json freerun-state
 *   { "observations": [...], "decisions": [...], ... }
 *   ```
 *
 * The frontmatter is a deliberate intersection of YAML 1.2 and JSON: every
 * value is JSON.parseable, every key is a bare identifier. This lets us
 * serialize/parse without pulling in a YAML library while keeping the file
 * human-editable and editor-friendly (YAML highlighting works).
 *
 * Atomic write: temp-file-then-rename in the same directory (POSIX atomic
 * rename guarantee). Bun.write flushes data; rename publishes it. On crash
 * mid-write the temp file is orphaned and the canonical file is intact.
 */

import * as fs from "fs/promises"
import * as path from "path"
import { ContextNode, nodeFilePath, sessionStorageDir } from "../types"
import type { ContextNode as ContextNodeT } from "../types"

export namespace NodeFS {
  // ============================================================================
  // Public API
  // ============================================================================

  /** Write a node atomically to <sessionDir>/tree/<id>.md. */
  export async function write(sessionId: string, node: ContextNodeT, dataHome: string): Promise<void> {
    const target = nodeFilePath(sessionId, node.id, dataHome)
    await fs.mkdir(path.dirname(target), { recursive: true })
    const text = serialize(node)
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
    try {
      await Bun.write(tmp, text)
      await fs.rename(tmp, target)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  /** Read a node by id. Throws ENOENT if missing. */
  export async function read(sessionId: string, nodeId: string, dataHome: string): Promise<ContextNodeT> {
    const target = nodeFilePath(sessionId, nodeId, dataHome)
    const text = await fs.readFile(target, "utf-8")
    return deserialize(text)
  }

  /** List all node ids present in the session's tree directory (non-recursive into .archive). */
  export async function list(sessionId: string, dataHome: string): Promise<string[]> {
    const treeDir = path.join(sessionStorageDir(sessionId, dataHome), "tree")
    let entries: string[]
    try {
      entries = await fs.readdir(treeDir)
    } catch (err: any) {
      if (err?.code === "ENOENT") return []
      throw err
    }
    return entries.filter((e) => e.endsWith(".md")).map((e) => e.slice(0, -3))
  }

  /** Does a node file exist? */
  export async function exists(sessionId: string, nodeId: string, dataHome: string): Promise<boolean> {
    try {
      await fs.access(nodeFilePath(sessionId, nodeId, dataHome))
      return true
    } catch {
      return false
    }
  }

  /** Move a node file into the archive directory (used by consolidation, DD-3c). */
  export async function archive(
    sessionId: string,
    nodeId: string,
    archiveStamp: string,
    dataHome: string,
  ): Promise<void> {
    const src = nodeFilePath(sessionId, nodeId, dataHome)
    const archiveDir = path.join(sessionStorageDir(sessionId, dataHome), "tree", ".archive", archiveStamp)
    await fs.mkdir(archiveDir, { recursive: true })
    const dst = path.join(archiveDir, `${nodeId}.md`)
    await fs.rename(src, dst)
  }

  // ============================================================================
  // Serialize / deserialize (exported for tests)
  // ============================================================================

  /** Field order for the frontmatter — keep stable for human-readable diffs. */
  const FRONTMATTER_KEYS: Array<keyof ContextNodeT> = [
    "id",
    "parent_id",
    "children_ids",
    "title",
    "mode",
    "created_at",
    "updated_at",
    "iteration_count",
    "goal_binding",
    "relevant_tools",
    "relevant_skills",
  ]

  /** Keys that carry state payload (live inside the JSON code-fence block). */
  const STATE_KEYS: Array<keyof ContextNodeT> = [
    "observations",
    "decisions",
    "blockers",
    "results",
    "next_intent",
    "consolidated_summary",
  ]

  const STATE_FENCE_OPEN = "```json freerun-state"
  const STATE_FENCE_CLOSE = "```"

  export function serialize(node: ContextNodeT): string {
    // Validate before writing — never persist a malformed node.
    const parsed = ContextNode.parse(node)
    const fmLines: string[] = ["---"]
    for (const k of FRONTMATTER_KEYS) {
      const v = (parsed as Record<string, unknown>)[k]
      if (v === undefined) continue
      // JSON.stringify yields JSON-compatible YAML 1.2 scalars/flow values.
      fmLines.push(`${k}: ${JSON.stringify(v)}`)
    }
    fmLines.push("---", "")
    // Body (free-form). Trailing newline so the fence block sits on its own line.
    const body = parsed.body.length > 0 ? parsed.body + "\n\n" : ""
    const state: Record<string, unknown> = {}
    for (const k of STATE_KEYS) state[k] = (parsed as Record<string, unknown>)[k]
    const stateBlock = `${STATE_FENCE_OPEN}\n${JSON.stringify(state, null, 2)}\n${STATE_FENCE_CLOSE}\n`
    return fmLines.join("\n") + body + stateBlock
  }

  export function deserialize(text: string): ContextNodeT {
    const { frontmatter, body, stateBlock } = splitSections(text)
    const fm = parseFrontmatter(frontmatter)
    const state = parseStateBlock(stateBlock)
    const merged = { ...fm, ...state, body }
    // ContextNode.parse fills defaults for missing optional state fields and
    // validates everything in one go.
    return ContextNode.parse(merged)
  }

  // ============================================================================
  // Internal helpers
  // ============================================================================

  function splitSections(text: string): { frontmatter: string; body: string; stateBlock: string } {
    // Expect: ^---\n<fm>\n---\n<body>\n```json freerun-state\n<state>\n```\n?
    if (!text.startsWith("---\n")) {
      throw new Error("freerun node file: missing opening '---' fence")
    }
    const closeIdx = text.indexOf("\n---\n", 4)
    if (closeIdx === -1) {
      throw new Error("freerun node file: missing closing '---' fence after frontmatter")
    }
    const frontmatter = text.slice(4, closeIdx)
    const afterFm = text.slice(closeIdx + 5) // skip "\n---\n"

    const fenceStart = afterFm.indexOf(STATE_FENCE_OPEN)
    if (fenceStart === -1) {
      throw new Error(`freerun node file: missing state fence '${STATE_FENCE_OPEN}'`)
    }
    const body = afterFm.slice(0, fenceStart).trimEnd()
    const afterFenceOpen = afterFm.slice(fenceStart + STATE_FENCE_OPEN.length).replace(/^\n/, "")
    const fenceEnd = afterFenceOpen.indexOf("\n" + STATE_FENCE_CLOSE)
    if (fenceEnd === -1) {
      throw new Error("freerun node file: state fence not closed")
    }
    const stateBlock = afterFenceOpen.slice(0, fenceEnd)
    return { frontmatter, body, stateBlock }
  }

  function parseFrontmatter(fm: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const rawLine of fm.split("\n")) {
      const line = rawLine.trimEnd()
      if (line === "") continue
      const colon = line.indexOf(":")
      if (colon === -1) throw new Error(`freerun frontmatter: malformed line: ${line}`)
      const key = line.slice(0, colon).trim()
      const valueText = line.slice(colon + 1).trim()
      try {
        out[key] = JSON.parse(valueText)
      } catch {
        throw new Error(`freerun frontmatter: cannot JSON.parse value for key '${key}': ${valueText}`)
      }
    }
    return out
  }

  function parseStateBlock(block: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(block)
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("state block must be a JSON object")
      }
      return parsed as Record<string, unknown>
    } catch (err: any) {
      throw new Error(`freerun state block: invalid JSON — ${err?.message ?? err}`)
    }
  }
}
