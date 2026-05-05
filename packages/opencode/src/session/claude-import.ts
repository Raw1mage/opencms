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
    userMessageCount: z.number().int().nonnegative(),
    assistantMessageCount: z.number().int().nonnegative(),
    firstUserPreview: z.string().optional(),
    lastUserPreview: z.string().optional(),
    looksEmpty: z.boolean(),
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

  // Reverse marker keyed on the OpenCode session id. Written when import
  // first creates the takeover session; checked by existingImportedSession
  // to confirm the metadata pointer truly belongs to a Claude import target
  // (and not to an unrelated user session whose id collided / got reused).
  function importTargetKey(sessionID: string) {
    return ["claude_import_target", Instance.project.id, sessionID]
  }

  function deriveTitleFromLines(lines: ClaudeLine[], sourceSessionID: string): string {
    const fallback = `Claude ${sourceSessionID}`
    let aiTitle: string | undefined
    let summary: string | undefined
    let lastPrompt: string | undefined
    let firstUserText: string | undefined
    for (const line of lines) {
      const l = line as ClaudeLine & {
        type?: string
        aiTitle?: string
        summary?: string
        lastPrompt?: string
      }
      if (!aiTitle && l.type === "ai-title" && typeof l.aiTitle === "string" && l.aiTitle.trim()) {
        aiTitle = l.aiTitle.trim()
        break
      }
      if (!summary && l.type === "summary" && typeof l.summary === "string" && l.summary.trim()) {
        summary = l.summary.trim()
      }
      if (!lastPrompt && l.type === "last-prompt" && typeof l.lastPrompt === "string" && l.lastPrompt.trim()) {
        lastPrompt = l.lastPrompt.trim()
      }
      if (!firstUserText && (l.message?.role ?? l.role) === "user" && l.type !== "attachment") {
        try {
          const normalized = normalizeContent(l, 0)
          if (normalized.text) firstUserText = normalized.text
        } catch {
          // ignore unsupported blocks for title derivation
        }
      }
    }
    const titleSource = aiTitle ?? summary ?? lastPrompt ?? firstUserText ?? fallback
    return (titleSource.split("\n")[0] ?? fallback).slice(0, 80) || fallback
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

  // Claude evolves block types over time (image, server_tool_use,
  // web_search_tool_result, etc.). Unknown blocks used to throw, killing the
  // entire import for one ignorable line. We now degrade them to evidence
  // entries — caller can still tell something was there but the rest of
  // the transcript imports cleanly.
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
      if (!block || typeof block !== "object") {
        evidence.push(`unsupported block (line ${lineNumber}): non-object`)
        continue
      }
      if (!("type" in block)) {
        evidence.push(`unsupported block (line ${lineNumber}): no type`)
        continue
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
      evidence.push(`unsupported block (line ${lineNumber}): type=${(block as { type?: string }).type}`)
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

  // Cap how many bytes we'll scan per transcript when building the listing
  // summary. The largest field-observed transcript is ~100 MB; reading them
  // all on every list request blocks the daemon for seconds. 5 MB covers
  // roughly the first ~5k lines of a typical Claude session, enough for
  // ai-title, first user preview, and an approximate count.
  const SUMMARY_SCAN_CAP_BYTES = 5_000_000

  async function readCapped(transcriptPath: string, cap: number): Promise<{ raw: string; truncated: boolean }> {
    const fd = await fs.open(transcriptPath, "r")
    try {
      const stat = await fd.stat()
      if (stat.size <= cap) {
        const raw = await fd.readFile({ encoding: "utf8" })
        return { raw, truncated: false }
      }
      const buffer = Buffer.alloc(cap)
      await fd.read(buffer, 0, cap, 0)
      return { raw: buffer.toString("utf8"), truncated: true }
    } finally {
      await fd.close()
    }
  }

  async function readTranscriptSummary(
    transcriptPath: string,
    sourceSessionID: string,
    directory = Instance.directory,
  ) {
    const stat = await fs.stat(transcriptPath)
    const { raw, truncated } = await readCapped(transcriptPath, SUMMARY_SCAN_CAP_BYTES)
    // When truncated mid-line the trailing partial line is unparseable; drop it
    // so the rest of the loop's try/catch isn't swallowing a guaranteed error.
    const splitLines = raw.split(/\r?\n/)
    if (truncated && splitLines.length > 0) splitLines.pop()
    const lines = splitLines.filter((line) => line.trim().length > 0)
    const fallback = `Claude ${sourceSessionID}`
    let aiTitle: string | undefined
    let lastPrompt: string | undefined
    let summary: string | undefined
    let firstUserText: string | undefined
    let lastUserText: string | undefined
    let userMessageCount = 0
    let assistantMessageCount = 0
    let created = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs
    let createdSet = false
    for (let index = 0; index < lines.length; index++) {
      try {
        const line = JSON.parse(lines[index]) as ClaudeLine & {
          type?: string
          aiTitle?: string
          lastPrompt?: string
          summary?: string
        }
        if (!createdSet && line.timestamp) {
          created = timestampMs(line.timestamp, created)
          createdSet = true
        }
        if (!aiTitle && line.type === "ai-title" && typeof line.aiTitle === "string" && line.aiTitle.trim()) {
          aiTitle = line.aiTitle.trim()
          continue
        }
        if (!lastPrompt && line.type === "last-prompt" && typeof line.lastPrompt === "string" && line.lastPrompt.trim()) {
          lastPrompt = line.lastPrompt.trim()
          continue
        }
        if (!summary && line.type === "summary" && typeof line.summary === "string" && line.summary.trim()) {
          summary = line.summary.trim()
          continue
        }
        const role = line.message?.role ?? line.role
        if (line.type === "attachment") continue
        if (role === "user" || role === "assistant") {
          let text: string | undefined
          try {
            const normalized = normalizeContent(line, index + 1)
            if (normalized.text) text = normalized.text
          } catch {
            // unsupported block — still counts toward message tally
          }
          if (role === "user") {
            // Only count substantive user prompts (not empty / pure-preface
            // / pure tool-result evidence) so noise transcripts surface as
            // empty in the UI.
            if (text) {
              userMessageCount++
              if (!firstUserText) firstUserText = text
              lastUserText = text
            }
          } else {
            if (text) assistantMessageCount++
          }
        }
      } catch {
        continue
      }
    }
    const titleSource = aiTitle ?? summary ?? lastPrompt ?? firstUserText ?? fallback
    const title = (titleSource.split("\n")[0] ?? fallback).slice(0, 80) || fallback
    const previewLimit = 120
    const firstUserPreview = firstUserText ? firstUserText.replace(/\s+/g, " ").trim().slice(0, previewLimit) : undefined
    const lastUserPreview =
      lastUserText && lastUserText !== firstUserText
        ? lastUserText.replace(/\s+/g, " ").trim().slice(0, previewLimit)
        : undefined
    // Only call a transcript "empty" when we scanned it in full and found
    // zero substantive user messages. If the scan was capped we can't prove
    // emptiness — default to non-empty so the UI never grays out a session
    // that may have content past the cap.
    const looksEmpty = !truncated && userMessageCount === 0
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
      userMessageCount,
      assistantMessageCount,
      firstUserPreview,
      lastUserPreview,
      looksEmpty,
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
    const session = await Session.get(metadata.sessionID).catch(() => undefined)
    if (!session) return undefined
    // Safety check: never append to a session that wasn't created by Claude
    // import. Stale or corrupt metadata pointing at a real user session
    // would otherwise inject transcript messages into the user's own work.
    // Primary signal: the reverse marker stamped at create time. Fallback:
    // legacy "Claude takeover" title prefix for sessions imported before
    // the marker was introduced.
    const marker = await Storage.read(importTargetKey(metadata.sessionID)).catch(() => undefined)
    if (marker) return session
    if (session.title?.startsWith("Claude takeover")) return session
    return undefined
  }

  async function writeSourceMetadata(sessionID: string, metadata: SourceMetadata, directory = Instance.directory) {
    await Storage.write(metadataKey(metadata.sourceSessionID, directory), { ...metadata, sessionID })
  }

  async function writeImportTargetMarker(sessionID: string) {
    await Storage.write(importTargetKey(sessionID), { createdAt: Date.now() })
  }

  export async function importTranscript(input: Input): Promise<Result> {
    const parsed = await readTranscript(input)
    const directory = input.directory ?? Instance.directory
    const existing = await existingImportedSession(input.sourceSessionID, directory)
    const previous = await Storage.read<SourceMetadata & { sessionID?: string }>(
      metadataKey(input.sourceSessionID, directory),
    ).catch(() => undefined)
    const claudeTitle = deriveTitleFromLines(parsed.lines, input.sourceSessionID)
    const session = existing ?? (await Session.createNext({ directory, title: claudeTitle }))
    if (!existing) await writeImportTargetMarker(session.id)
    let appended = 0
    let parentID: string | undefined
    const start = previous?.sessionID === session.id ? previous.lineCount : 0
    const importedEntries: ImportedEntry[] = []

    for (let index = start; index < parsed.lines.length; index++) {
      const line = parsed.lines[index]
      const role = line.message?.role ?? line.role
      if (role !== "user" && role !== "assistant") continue
      const normalized = normalizeContent(line, index + 1)
      // Drop runtime evidence (tool_use / tool_result summaries). User-facing
      // value is the turn-by-turn dialog; tool noise just clutters the
      // imported transcript without aiding post-hoc understanding. As a side
      // effect, user-role tool_result lines (text-empty by construction) are
      // skipped entirely now, which collapses the duplicated "回覆" rows the
      // UI previously emitted between every assistant reply.
      const text = normalized.text.trim()
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
      // Backfill: legacy imports created before deriveTitleFromLines existed
      // still have the raw "Claude takeover" placeholder. Upgrade them to the
      // derived AI title on next import. User-edited titles (anything else)
      // are preserved.
      if (draft.title === "Claude takeover") draft.title = claudeTitle
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
