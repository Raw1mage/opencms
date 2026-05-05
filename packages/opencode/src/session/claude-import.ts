import fs from "fs/promises"
import path from "path"
import z from "zod"

import { Global } from "@/global"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Storage } from "@/storage/storage"

const SourceMetadata = z.object({
  provider: z.literal("claude-code"),
  sourceSessionID: z.string(),
  transcriptPath: z.string(),
  lineCount: z.number().int().nonnegative(),
  takeoverAnchor: z
    .object({
      messageID: z.string(),
      lineStart: z.number().int().positive(),
      lineEnd: z.number().int().nonnegative(),
    })
    .optional(),
})

type SourceMetadata = z.infer<typeof SourceMetadata>

export namespace ClaudeImport {
  const TAKEOVER_ANCHOR_LINE_THRESHOLD = 20
  const TAKEOVER_ANCHOR_TEXT_LIMIT = 1200

  export const Input = z.object({
    directory: z.string().optional(),
    sourceSessionID: z.string().min(1),
    transcriptPath: z.string().optional(),
  })
  export type Input = z.infer<typeof Input>

  export const Result = z.object({
    sessionID: z.string(),
    imported: z.boolean(),
    appended: z.number().int().nonnegative(),
    sourceSessionID: z.string(),
  })
  export type Result = z.infer<typeof Result>

  export const NativeSession = z.object({
    sourceSessionID: z.string(),
    transcriptPath: z.string(),
    title: z.string(),
    time: z.object({ created: z.number(), updated: z.number() }),
    importedSessionID: z.string().optional(),
    currentLineCount: z.number().int().nonnegative(),
    importedLineCount: z.number().int().nonnegative().optional(),
    hasNewContent: z.boolean(),
  })
  export type NativeSession = z.infer<typeof NativeSession>

  export class ImportError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly details?: Record<string, unknown>,
    ) {
      super(message)
      this.name = "ClaudeImportError"
    }
  }

  type ClaudeContentBlock =
    | string
    | { type: "text"; text?: string }
    | { type: "thinking"; thinking?: string; text?: string }
    | { type: "tool_use"; id?: string; name?: string; input?: unknown }
    | { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean }

  type ClaudeLine = {
    uuid?: string
    sessionId?: string
    session_id?: string
    type?: string
    role?: "user" | "assistant" | "system"
    timestamp?: string
    cwd?: string
    message?: {
      role?: "user" | "assistant" | "system"
      content?: ClaudeContentBlock | ClaudeContentBlock[]
      model?: string
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
      }
    }
  }

  type ImportedEntry = {
    role: "user" | "assistant"
    lineNumber: number
    text: string
    evidence: string[]
  }

  function projectKey(directory: string) {
    return directory.replace(/[^a-zA-Z0-9]/g, "-")
  }

  function defaultTranscriptPath(input: Input) {
    const directory = input.directory ?? Instance.directory
    return path.join(Global.Path.home, ".claude", "projects", projectKey(directory), `${input.sourceSessionID}.jsonl`)
  }

  function projectTranscriptDir(directory: string) {
    return path.join(Global.Path.home, ".claude", "projects", projectKey(directory))
  }

  function metadataKey(sourceSessionID: string, directory = Instance.directory) {
    return ["session_import", Instance.project.id, projectKey(directory), sourceSessionID]
  }

  function timestampMs(value: string | undefined, fallback: number) {
    if (!value) return fallback
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  function compactToolInput(input: unknown) {
    if (!input || typeof input !== "object") return "{}"
    const entries = Object.entries(input as Record<string, unknown>)
      .slice(0, 6)
      .map(([key, value]) => {
        if (typeof value === "string") return `${key}=${JSON.stringify(value.slice(0, 120))}`
        if (typeof value === "number" || typeof value === "boolean") return `${key}=${String(value)}`
        return `${key}=<${Array.isArray(value) ? "array" : "object"}>`
      })
    return entries.length ? entries.join(" ") : "{}"
  }

  function compactToolResult(content: unknown, isError: boolean | undefined) {
    if (isError) {
      const text = typeof content === "string" ? content.split("\n")[0]?.slice(0, 240) : "tool returned error"
      return `tool_result error: ${text || "tool returned error"}`
    }
    return "tool_result completed"
  }

  // Tags emitted by the live OpenCode preface / preloaded-context pipeline.
  // A pure-preface user message (header + only these tags + scaffolding)
  // collapses to "" via the cascade below and gets skipped by the appended-
  // empty guard in importTranscript; partial pollution (e.g. an actual user
  // prompt with a `<context_budget>` envelope appended) keeps the prompt and
  // drops the envelope.
  const PREFACE_TAGS = [
    "context_budget",
    "readme_summary",
    "cwd_listing",
    "pinned_skills",
    "active_skills",
    "summarized_skills",
    "deferred-tools",
    "deferred_tools",
    "attached_images",
    "attachment_ref",
    "preloaded_context",
    "env_context",
    "skill_context",
  ] as const

  function stripTaggedBlock(text: string, tag: string) {
    return text.replace(new RegExp(`\\n?\\s*<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>\\s*`, "g"), "\n")
  }

  function sanitizeImportedText(text: string) {
    let sanitized = text
    // ENABLEMENT SNAPSHOT terminates at a blank line, any opening tag, or EOF
    // — broader than the previous lookahead which only knew two siblings.
    sanitized = sanitized.replace(
      /\n?\[ENABLEMENT SNAPSHOT\][\s\S]*?(?=\n\s*\n|\n\s*<[A-Za-z_][A-Za-z0-9_-]*\b|$)/g,
      "\n",
    )
    for (const tag of PREFACE_TAGS) {
      sanitized = stripTaggedBlock(sanitized, tag)
    }
    // Structured `<skill name="..." state="...">…</skill>` blocks that escaped
    // their parent envelope (e.g. truncated preface).
    sanitized = sanitized.replace(/\n?\s*<skill\s+name="[^"]*"[^>]*>[\s\S]*?<\/skill>\s*/g, "\n")
    sanitized = sanitized
      .replace(/^## CONTEXT PREFACE — read but do not echo\s*$/gm, "")
      .replace(/^Today's date: .*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
    return sanitized
  }

  function normalizeContent(line: ClaudeLine, lineNumber: number) {
    const content = line.message?.content
    const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content]
    const text: string[] = []
    const evidence: string[] = []

    for (const block of blocks) {
      if (typeof block === "string") {
        text.push(block)
        continue
      }
      if (!block || typeof block !== "object" || !("type" in block)) {
        throw new ImportError("CLAUDE_UNSUPPORTED_BLOCK", "Claude transcript contains an unsupported content block", {
          lineNumber,
        })
      }
      if (block.type === "text") {
        if (block.text) text.push(block.text)
        continue
      }
      if (block.type === "thinking") {
        continue
      }
      if (block.type === "tool_use") {
        evidence.push(
          `tool_use ${block.name ?? "unknown"}${block.id ? ` id=${block.id}` : ""} ${compactToolInput(block.input)}`,
        )
        continue
      }
      if (block.type === "tool_result") {
        evidence.push(compactToolResult(block.content, block.is_error))
        continue
      }
      throw new ImportError("CLAUDE_UNSUPPORTED_BLOCK", "Claude transcript contains an unsupported content block", {
        lineNumber,
        type: (block as { type?: string }).type,
      })
    }

    return { text: sanitizeImportedText(text.join("\n\n")), evidence }
  }

  function excerpt(value: string, limit = TAKEOVER_ANCHOR_TEXT_LIMIT) {
    const compact = value.replace(/\s+/g, " ").trim()
    return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact
  }

  function lastText(entries: ImportedEntry[], role: "user" | "assistant") {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if (entry.role === role && entry.text.trim()) return entry
    }
    return undefined
  }

  function buildTakeoverAnchorText(input: {
    sourceSessionID: string
    transcriptPath: string
    lineStart: number
    lineEnd: number
    entries: ImportedEntry[]
  }) {
    const user = lastText(input.entries, "user")
    const assistant = lastText(input.entries, "assistant")
    const evidence = input.entries.flatMap((entry) => entry.evidence).slice(-8)
    const firstLine = input.entries.at(0)?.lineNumber ?? input.lineStart
    const lastLine = input.entries.at(-1)?.lineNumber ?? input.lineEnd

    return [
      "# Claude Takeover Anchor",
      "",
      `Source: claude-code ${input.sourceSessionID}`,
      `Transcript: ${input.transcriptPath}`,
      `Covered lines: ${input.lineStart}-${input.lineEnd}`,
      `Imported message lines: ${firstLine}-${lastLine}`,
      "",
      "## Current User Intent",
      user ? `- line ${user.lineNumber}: ${excerpt(user.text)}` : "- No user text found in imported range.",
      "",
      "## Latest Assistant State",
      assistant
        ? `- line ${assistant.lineNumber}: ${excerpt(assistant.text)}`
        : "- No assistant text found in imported range.",
      "",
      "## Runtime Evidence",
      ...(evidence.length
        ? evidence.map((item) => `- ${excerpt(item, 240)}`)
        : ["- No bounded tool evidence in imported range."]),
      "",
      "## Takeover Handoff",
      "- Continue from the latest user intent and assistant state above.",
      "- Treat raw pre-anchor transcript messages as audit trail; use this anchor as the compact LLM-visible baseline.",
    ].join("\n")
  }

  async function writeTakeoverAnchor(input: {
    sessionID: string
    directory: string
    sourceSessionID: string
    transcriptPath: string
    lineStart: number
    lineEnd: number
    entries: ImportedEntry[]
    parentID: string | undefined
  }) {
    if (input.lineEnd < TAKEOVER_ANCHOR_LINE_THRESHOLD) return undefined
    if (!input.parentID) return undefined

    const now = Date.now()
    const messageID = Identifier.ascending("message")
    await Session.updateMessage({
      id: messageID,
      sessionID: input.sessionID,
      role: "assistant",
      time: { created: now, completed: now },
      parentID: input.parentID,
      modelID: "claude-native-transcript-anchor",
      providerId: "claude-cli",
      mode: "compaction",
      agent: "claude-import",
      path: { cwd: input.directory, root: input.directory },
      summary: true,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: input.sessionID,
      messageID,
      type: "text",
      text: buildTakeoverAnchorText(input),
      metadata: {
        sourceProvider: "claude-code",
        sourceSessionID: input.sourceSessionID,
        sourceLineStart: input.lineStart,
        sourceLineEnd: input.lineEnd,
        takeoverAnchor: true,
        excludeFromModel: false,
      },
    } satisfies MessageV2.TextPart)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: input.sessionID,
      messageID,
      type: "compaction",
      auto: false,
    } satisfies MessageV2.CompactionPart)
    return { messageID, lineStart: input.lineStart, lineEnd: input.lineEnd }
  }

  async function readTranscript(input: Input) {
    const transcriptPath = path.resolve(input.transcriptPath ?? defaultTranscriptPath(input))
    let raw: string
    try {
      raw = await fs.readFile(transcriptPath, "utf8")
    } catch (error) {
      throw new ImportError("CLAUDE_TRANSCRIPT_NOT_FOUND", "Claude transcript file was not found", {
        transcriptPath,
        cause: error instanceof Error ? error.message : String(error),
      })
    }
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
    const parsed: ClaudeLine[] = []
    for (let index = 0; index < lines.length; index++) {
      try {
        parsed.push(JSON.parse(lines[index]) as ClaudeLine)
      } catch (error) {
        throw new ImportError("CLAUDE_TRANSCRIPT_INVALID_JSON", "Claude transcript contains invalid JSONL", {
          lineNumber: index + 1,
          cause: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { transcriptPath, lines: parsed }
  }

  async function readTranscriptSummary(
    transcriptPath: string,
    sourceSessionID: string,
    directory = Instance.directory,
  ) {
    const stat = await fs.stat(transcriptPath)
    const raw = await fs.readFile(transcriptPath, "utf8")
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
    let title = `Claude ${sourceSessionID}`
    let created = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs
    for (let index = 0; index < lines.length; index++) {
      try {
        const line = JSON.parse(lines[index]) as ClaudeLine
        if (index === 0) created = timestampMs(line.timestamp, created)
        const role = line.message?.role ?? line.role
        if (role === "user") {
          const normalized = normalizeContent(line, index + 1)
          if (normalized.text) title = normalized.text.split("\n")[0]?.slice(0, 80) || title
          break
        }
      } catch {
        continue
      }
    }
    const metadata = await Storage.read<SourceMetadata & { sessionID?: string }>(
      metadataKey(sourceSessionID, directory),
    ).catch(() => undefined)
    return {
      sourceSessionID,
      transcriptPath,
      title,
      time: { created, updated: stat.mtimeMs },
      importedSessionID: metadata?.sessionID,
      currentLineCount: lines.length,
      importedLineCount: metadata?.lineCount,
      hasNewContent: metadata ? lines.length > metadata.lineCount : false,
    } satisfies NativeSession
  }

  export async function listNative(input?: { directory?: string }): Promise<NativeSession[]> {
    const directory = input?.directory ?? Instance.directory
    const transcriptDir = projectTranscriptDir(directory)
    let entries: string[]
    try {
      entries = await fs.readdir(transcriptDir)
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
      if (code === "ENOENT") return []
      throw new ImportError("CLAUDE_TRANSCRIPT_LIST_FAILED", "Claude transcript directory could not be read", {
        transcriptDir,
        cause: error instanceof Error ? error.message : String(error),
      })
    }
    const rows = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".jsonl"))
        .map((entry) =>
          readTranscriptSummary(path.join(transcriptDir, entry), entry.slice(0, -".jsonl".length), directory),
        ),
    )
    return rows.sort((a, b) => b.time.updated - a.time.updated || b.sourceSessionID.localeCompare(a.sourceSessionID))
  }

  async function existingImportedSession(sourceSessionID: string, directory = Instance.directory) {
    const metadata = await Storage.read<SourceMetadata & { sessionID?: string }>(
      metadataKey(sourceSessionID, directory),
    ).catch(() => undefined)
    if (!metadata?.sessionID) return undefined
    return Session.get(metadata.sessionID).catch(() => undefined)
  }

  async function writeSourceMetadata(sessionID: string, metadata: SourceMetadata, directory = Instance.directory) {
    await Storage.write(metadataKey(metadata.sourceSessionID, directory), { ...metadata, sessionID })
  }

  export async function importTranscript(input: Input): Promise<Result> {
    const parsed = await readTranscript(input)
    const directory = input.directory ?? Instance.directory
    const existing = await existingImportedSession(input.sourceSessionID, directory)
    const previous = await Storage.read<SourceMetadata & { sessionID?: string }>(
      metadataKey(input.sourceSessionID, directory),
    ).catch(() => undefined)
    const session = existing ?? (await Session.createNext({ directory, title: "Claude takeover" }))
    let appended = 0
    let parentID: string | undefined
    const start = previous?.sessionID === session.id ? previous.lineCount : 0
    const importedEntries: ImportedEntry[] = []

    for (let index = start; index < parsed.lines.length; index++) {
      const line = parsed.lines[index]
      const role = line.message?.role ?? line.role
      if (role !== "user" && role !== "assistant") continue
      const normalized = normalizeContent(line, index + 1)
      const evidence = normalized.evidence.length ? `\n\nRuntime evidence:\n- ${normalized.evidence.join("\n- ")}` : ""
      const text = `${normalized.text}${evidence}`.trim()
      if (!text) continue
      importedEntries.push({ role, lineNumber: index + 1, text: normalized.text, evidence: normalized.evidence })
      const messageID = Identifier.ascending("message")
      const created = timestampMs(line.timestamp, Date.now() + index)
      if (role === "user") {
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created },
          agent: "build",
          model: { providerId: "claude-cli", modelID: "claude-native-transcript" },
        })
      } else {
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          time: { created, completed: created },
          parentID: parentID ?? messageID,
          modelID: line.message?.model ?? "claude-native-transcript",
          providerId: "claude-cli",
          mode: "import",
          agent: "claude",
          path: { cwd: line.cwd ?? directory, root: directory },
          cost: 0,
          tokens: {
            input: line.message?.usage?.input_tokens ?? 0,
            output: line.message?.usage?.output_tokens ?? 0,
            reasoning: 0,
            cache: {
              read: line.message?.usage?.cache_read_input_tokens ?? 0,
              write: line.message?.usage?.cache_creation_input_tokens ?? 0,
            },
          },
          finish: "stop",
        })
      }
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID,
        type: "text",
        text,
        metadata: {
          sourceProvider: "claude-code",
          sourceSessionID: input.sourceSessionID,
          sourceLine: index + 1,
          excludeFromModel: false,
        },
      } satisfies MessageV2.TextPart)
      parentID = messageID
      appended++
    }

    const previousAnchor = previous?.sessionID === session.id ? previous.takeoverAnchor : undefined
    const shouldWriteAnchor =
      parsed.lines.length >= TAKEOVER_ANCHOR_LINE_THRESHOLD && previousAnchor?.lineEnd !== parsed.lines.length
    const takeoverAnchor = shouldWriteAnchor
      ? await writeTakeoverAnchor({
          sessionID: session.id,
          directory,
          sourceSessionID: input.sourceSessionID,
          transcriptPath: parsed.transcriptPath,
          lineStart: 1,
          lineEnd: parsed.lines.length,
          entries: importedEntries.length ? importedEntries : [],
          parentID,
        })
      : previousAnchor

    await Session.update(session.id, (draft) => {
      draft.title = draft.title === "Claude takeover" ? `Claude takeover ${input.sourceSessionID}` : draft.title
      draft.execution = Session.nextExecutionIdentity({
        current: draft.execution,
        model: { providerId: "claude-cli", modelID: "claude-native-transcript" },
      })
    })
    await writeSourceMetadata(
      session.id,
      {
        provider: "claude-code",
        sourceSessionID: input.sourceSessionID,
        transcriptPath: parsed.transcriptPath,
        lineCount: parsed.lines.length,
        takeoverAnchor,
      },
      directory,
    )

    return { sessionID: session.id, imported: !existing, appended, sourceSessionID: input.sourceSessionID }
  }
}
