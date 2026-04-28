import { Storage } from "@/storage/storage"
import { Config } from "@/config/config"
import { Token } from "@/util/token"
import { Log } from "@/util/log"
import { debugCheckpoint } from "@/util/debug"
import type { MessageV2 } from "./message-v2"

// ── SharedContext ─────────────────────────────────────────────────────────────
// Primary per-session knowledge store. Automatically collects structured
// work state (Goal, Files, Discoveries, Actions, CurrentState) from tool calls
// and assistant text each turn. Used as the compaction summary source.
export namespace SharedContext {
  const log = Log.create({ service: "session.shared-context" })

  // ── Data Model ──────────────────────────────────────────────

  export interface Space {
    sessionID: string
    version: number
    updatedAt: number
    budget: number
    goal: string
    files: FileEntry[]
    discoveries: string[]
    actions: ActionEntry[]
    currentState: string
  }

  export interface FileEntry {
    path: string
    lines?: number
    summary?: string
    operation: "read" | "edit" | "write" | "grep_match" | "glob_match"
    updatedAt: number
  }

  export interface ActionEntry {
    tool: string
    summary: string
    turn: number
    addedAt: number
  }

  // ── Storage ─────────────────────────────────────────────────

  function storageKey(sessionID: string): string[] {
    return ["shared_context", sessionID]
  }

  export async function get(sessionID: string): Promise<Space | undefined> {
    try {
      return await Storage.read<Space>(storageKey(sessionID))
    } catch {
      return undefined
    }
  }

  async function save(space: Space): Promise<void> {
    await Storage.write(storageKey(sessionID(space)), space)
  }

  function sessionID(space: Space): string {
    return space.sessionID
  }

  function createEmpty(sid: string, budget: number): Space {
    return {
      sessionID: sid,
      version: 0,
      updatedAt: Date.now(),
      budget,
      goal: "",
      files: [],
      discoveries: [],
      actions: [],
      currentState: "",
    }
  }

  // ── Update From Turn ────────────────────────────────────────

  export async function updateFromTurn(input: {
    sessionID: string
    parts: MessageV2.Part[]
    assistantText: string
    turnNumber: number
  }): Promise<void> {
    const config = await Config.get()
    if (config.compaction?.sharedContext === false) return

    const budget = config.compaction?.sharedContextBudget ?? 8192
    let space = (await get(input.sessionID)) ?? createEmpty(input.sessionID, budget)

    // 1. Tool parts → files[] / actions[]
    for (const part of input.parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      processToolPart(space, part, input.turnNumber)
    }

    // 2. assistantText → goal / discoveries / currentState
    updateFromAssistantText(space, input.assistantText)

    // 3. Dedup files
    space.files = deduplicateFiles(space.files)

    // 4. Budget check & consolidate
    const estimated = Token.estimate(serialize(space))
    if (estimated > budget) {
      space = consolidate(space, budget)
    }

    space.version++
    space.updatedAt = Date.now()
    await save(space)

    debugCheckpoint("shared-context", "updateFromTurn", {
      sessionID: input.sessionID,
      version: space.version,
      files: space.files.length,
      actions: space.actions.length,
      discoveries: space.discoveries.length,
      tokens: Token.estimate(serialize(space)),
    })
  }

  // ── Process Tool Part ───────────────────────────────────────

  function processToolPart(space: Space, part: MessageV2.ToolPart, turnNumber: number): void {
    const now = Date.now()
    const input = part.state.status === "completed" ? part.state.input : {}
    const output = part.state.status === "completed" ? part.state.output : ""

    switch (part.tool) {
      case "read": {
        const filePath = input.file_path as string | undefined
        if (filePath) {
          const lines = output ? output.split("\n").length : undefined
          space.files.push({
            path: filePath,
            lines,
            operation: "read",
            updatedAt: now,
          })
        }
        break
      }
      case "glob": {
        const pattern = input.pattern as string | undefined
        if (output) {
          const paths = output
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
          for (const p of paths.slice(0, 20)) {
            space.files.push({
              path: p,
              operation: "glob_match",
              updatedAt: now,
            })
          }
          if (pattern) {
            space.actions.push({
              tool: "glob",
              summary: `Glob: ${pattern} → ${paths.length} files`,
              turn: turnNumber,
              addedAt: now,
            })
          }
        }
        break
      }
      case "grep": {
        const pattern = input.pattern as string | undefined
        if (output) {
          const lines = output.split("\n").filter(Boolean)
          const filePaths = new Set<string>()
          for (const line of lines) {
            const match = line.match(/^([^:]+):/)
            if (match) filePaths.add(match[1])
          }
          for (const p of Array.from(filePaths).slice(0, 20)) {
            space.files.push({
              path: p,
              operation: "grep_match",
              updatedAt: now,
            })
          }
          if (pattern) {
            space.actions.push({
              tool: "grep",
              summary: `Grep: ${pattern} → ${filePaths.size} matches`,
              turn: turnNumber,
              addedAt: now,
            })
          }
        }
        break
      }
      case "edit": {
        const filePath = input.file_path as string | undefined
        if (filePath) {
          space.files.push({
            path: filePath,
            operation: "edit",
            updatedAt: now,
          })
          space.actions.push({
            tool: "edit",
            summary: `Edit: ${filePath}`,
            turn: turnNumber,
            addedAt: now,
          })
        }
        break
      }
      case "write": {
        const filePath = input.file_path as string | undefined
        if (filePath) {
          space.files.push({
            path: filePath,
            operation: "write",
            updatedAt: now,
          })
          space.actions.push({
            tool: "write",
            summary: `Write: ${filePath}`,
            turn: turnNumber,
            addedAt: now,
          })
        }
        break
      }
      case "apply_patch": {
        // Extract file paths from patch output/input
        const patchContent = (input.patch as string) || output
        if (patchContent) {
          const affectedFiles = new Set<string>()
          for (const line of patchContent.split("\n")) {
            const match = line.match(/^[+-]{3}\s+[ab]\/(.+)/)
            if (match) affectedFiles.add(match[1])
          }
          for (const p of affectedFiles) {
            space.files.push({
              path: p,
              operation: "edit",
              updatedAt: now,
            })
          }
          space.actions.push({
            tool: "apply_patch",
            summary: `Patch: ${affectedFiles.size} files`,
            turn: turnNumber,
            addedAt: now,
          })
        }
        break
      }
      case "bash": {
        const cmd = input.command as string | undefined
        if (cmd) {
          const shortCmd = cmd.length > 20 ? cmd.slice(0, 20) + "..." : cmd
          space.actions.push({
            tool: "bash",
            summary: `Bash: ${shortCmd}`,
            turn: turnNumber,
            addedAt: now,
          })
        }
        break
      }
      case "webfetch": {
        const url = input.url as string | undefined
        space.actions.push({
          tool: "webfetch",
          summary: `WebFetch: ${url ?? "unknown"}`,
          turn: turnNumber,
          addedAt: now,
        })
        break
      }
      case "task": {
        const desc = input.description as string | undefined
        const agentType = input.subagent_type as string | undefined
        space.actions.push({
          tool: "task",
          summary: `Task(${agentType ?? "unknown"}): ${desc ?? ""}`,
          turn: turnNumber,
          addedAt: now,
        })
        break
      }
      case "skill": {
        const name = input.skill as string | undefined
        space.actions.push({
          tool: "skill",
          summary: `Skill: ${name ?? "unknown"}`,
          turn: turnNumber,
          addedAt: now,
        })
        break
      }
      default: {
        space.actions.push({
          tool: part.tool,
          summary: `${part.tool}: completed`,
          turn: turnNumber,
          addedAt: now,
        })
        break
      }
    }
  }

  // ── Assistant Text Extraction ───────────────────────────────

  function updateFromAssistantText(space: Space, text: string): void {
    if (!text) return

    // Goal: only set if not yet populated
    if (!space.goal && text.length > 0) {
      space.goal = extractFirstSentence(text, 200)
    }

    // Discoveries: sentences matching specific patterns
    const discoveryPatterns = [
      /發現|原因是|因為|root cause|注意|important|key finding|需要注意/i,
      /the reason|it turns out|notably|crucially|discovered that/i,
    ]
    for (const sentence of splitSentences(text)) {
      if (discoveryPatterns.some((p) => p.test(sentence))) {
        const trimmed = sentence.trim()
        if (trimmed.length > 10 && trimmed.length < 300 && !space.discoveries.includes(trimmed)) {
          space.discoveries.push(trimmed)
        }
      }
    }

    // Current State: last paragraph (usually next steps)
    const paragraphs = text.split(/\n\n+/).filter(Boolean)
    if (paragraphs.length > 0) {
      const last = paragraphs[paragraphs.length - 1].trim()
      if (last.length > 10 && last.length < 500) {
        space.currentState = last
      }
    }
  }

  function extractFirstSentence(text: string, maxLen: number): string {
    const truncated = text.slice(0, maxLen)
    const sentenceEnd = truncated.search(/[.!?。！？]\s/)
    if (sentenceEnd > 0) return truncated.slice(0, sentenceEnd + 1).trim()
    return truncated.trim()
  }

  function splitSentences(text: string): string[] {
    return text.split(/(?<=[.!?。！？])\s+/).filter((s) => s.length > 5)
  }

  // ── Deduplication ───────────────────────────────────────────

  const OP_RANK: Record<string, number> = {
    glob_match: 1,
    grep_match: 2,
    read: 3,
    edit: 4,
    write: 5,
  }

  function higherOp(a: FileEntry["operation"], b: FileEntry["operation"]): FileEntry["operation"] {
    return (OP_RANK[b] ?? 0) >= (OP_RANK[a] ?? 0) ? b : a
  }

  function deduplicateFiles(files: FileEntry[]): FileEntry[] {
    const map = new Map<string, FileEntry>()
    for (const f of files) {
      const existing = map.get(f.path)
      if (!existing || f.updatedAt > existing.updatedAt) {
        map.set(f.path, {
          ...f,
          operation: existing ? higherOp(existing.operation, f.operation) : f.operation,
          summary: f.summary || existing?.summary,
        })
      }
    }
    return Array.from(map.values())
  }

  // ── Consolidation ───────────────────────────────────────────

  function consolidate(space: Space, budget: number): Space {
    // 1. Actions: keep most recent 20
    if (space.actions.length > 20) {
      space.actions = space.actions.slice(-20)
    }

    // 2. Files: collapse directories with >5 entries
    const byDir = new Map<string, FileEntry[]>()
    for (const f of space.files) {
      const dir = f.path.split("/").slice(0, -1).join("/") || "."
      const arr = byDir.get(dir) ?? []
      arr.push(f)
      byDir.set(dir, arr)
    }
    const collapsed: FileEntry[] = []
    for (const [dir, entries] of byDir) {
      if (entries.length > 5) {
        const ops = new Set(entries.map((e) => e.operation))
        collapsed.push({
          path: `${dir}/ (${entries.length} files)`,
          operation: ops.has("write") ? "write" : ops.has("edit") ? "edit" : "read",
          updatedAt: Math.max(...entries.map((e) => e.updatedAt)),
        })
      } else {
        collapsed.push(...entries)
      }
    }
    space.files = collapsed

    // 3. Discoveries: keep most recent 10
    if (space.discoveries.length > 10) {
      space.discoveries = space.discoveries.slice(-10)
    }

    // 4. If still over budget, trim oldest entries
    while (Token.estimate(serialize(space)) > budget && space.actions.length > 5) {
      space.actions.shift()
    }
    while (Token.estimate(serialize(space)) > budget && space.files.length > 3) {
      space.files.shift()
    }
    while (Token.estimate(serialize(space)) > budget && space.discoveries.length > 2) {
      space.discoveries.shift()
    }

    return space
  }

  // Phase 13.3-full: regex-extracted snapshot surface (snapshot,
  // persistSnapshot, snapshotDiff, formatForInjection, formatSnapshot)
  // removed. Compaction now reads from message-stream anchors and the
  // Memory journal — single source of truth. SharedContext.Space remains
  // as the file/action workspace used by subagents (updateFromTurn,
  // mergeFrom, get).

  // ── Merge From Child Session ─────────────────────────────────

  /**
   * Called when a subagent completes: merges child's files/actions into
   * the parent's SharedContext so the parent accumulates child's knowledge.
   * Non-fatal: errors are logged and ignored.
   */
  export async function mergeFrom(input: {
    targetSessionID: string
    sourceSessionID: string
  }): Promise<void> {
    try {
      const child = await get(input.sourceSessionID)
      if (!child || (child.files.length === 0 && child.actions.length === 0)) return

      const config = await Config.get()
      if (config.compaction?.sharedContext === false) return

      const budget = config.compaction?.sharedContextBudget ?? 8192
      const parent = (await get(input.targetSessionID)) ?? createEmpty(input.targetSessionID, budget)

      // Merge files: child entries take precedence (more recent work)
      parent.files = deduplicateFiles([...parent.files, ...child.files])

      // Merge actions: append child actions (tagged with source)
      for (const action of child.actions) {
        parent.actions.push({
          ...action,
          summary: `[subagent] ${action.summary}`,
        })
      }

      // Merge discoveries
      for (const d of child.discoveries) {
        if (!parent.discoveries.includes(d)) {
          parent.discoveries.push(`[subagent] ${d}`)
        }
      }

      // Update current state to reflect subagent completion
      if (child.currentState) {
        parent.currentState = `Subagent completed. Last state: ${child.currentState.slice(0, 200)}`
      }

      // Budget check
      const estimated = Token.estimate(serialize(parent))
      const consolidated = estimated > budget ? consolidate(parent, budget) : parent

      consolidated.version++
      consolidated.updatedAt = Date.now()
      await save(consolidated)

      debugCheckpoint("shared-context", "mergeFrom", {
        targetSessionID: input.targetSessionID,
        sourceSessionID: input.sourceSessionID,
        mergedFiles: child.files.length,
        mergedActions: child.actions.length,
      })
    } catch (err) {
      log.warn("SharedContext.mergeFrom failed (non-fatal)", {
        targetSessionID: input.targetSessionID,
        sourceSessionID: input.sourceSessionID,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  // Phase 13.3 leftover: `serialize` is used internally by updateFromTurn /
  // truncateSpaceToFit / mergeFrom for token-budget estimation. The original
  // `formatSnapshot` (deleted in c84ecb309) was the public formatter; this
  // private inline version replaces only the internal-estimation use.
  function serialize(space: Space): string {
    const lines: string[] = []
    if (space.goal) lines.push(`Goal: ${space.goal}`)
    if (space.files.length > 0) {
      for (const f of space.files) {
        const meta = [f.lines ? `${f.lines}L` : null, f.operation].filter(Boolean).join(",")
        const suffix = f.summary ? ` — ${f.summary}` : ""
        lines.push(`- ${f.path} (${meta})${suffix}`)
      }
    }
    if (space.discoveries.length > 0) lines.push(...space.discoveries.map((d) => `- ${d}`))
    if (space.actions.length > 0) lines.push(...space.actions.map((a) => `- ${a.summary}`))
    if (space.currentState) lines.push(`State: ${space.currentState}`)
    return lines.join("\n")
  }
}
