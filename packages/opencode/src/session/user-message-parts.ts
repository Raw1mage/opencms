import { fileURLToPath } from "bun"
import { Identifier } from "../id/id"
import { MessageV2 } from "./message-v2"
import { debugCheckpoint } from "@/util/debug"
import { MCP } from "../mcp"
import { Log } from "../util/log"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { Provider } from "../provider/provider"
import { Tool } from "@/tool/tool"
import { Bus } from "../bus"
import { NamedError } from "@opencode-ai/util/error"
import { Session } from "."
import { ListTool } from "../tool/ls"
import { FileTime } from "../file/time"
import { PermissionNext } from "@/permission/next"
import { Tweaks } from "@/config/tweaks"
import { Router as StorageRouter } from "./storage/router"
import { emitBoundaryRoutingTelemetry } from "./compaction-telemetry"
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { IncomingPaths } from "../incoming/paths"
import { classifyOffice } from "../incoming/office-mime"
import { landOfficeUpload } from "../incoming/decompose-hook"
import { IncomingHistory } from "../incoming/history"
import { Instance } from "../project/instance"

const log = Log.create({ service: "session.user-message-parts" })

type AttachmentBlobWriter = Pick<typeof StorageRouter, "upsertAttachmentBlob">
let attachmentBlobWriter: AttachmentBlobWriter = StorageRouter

export function setAttachmentBlobWriterForTesting(writer?: AttachmentBlobWriter) {
  attachmentBlobWriter = writer ?? StorageRouter
}

type UserMessagePartInput =
  | (Omit<MessageV2.TextPart, "id" | "messageID" | "sessionID"> & { id?: string })
  | (Omit<MessageV2.FilePart, "id" | "messageID" | "sessionID"> & { id?: string })
  | (Omit<MessageV2.AgentPart, "id" | "messageID" | "sessionID"> & { id?: string })
  | (Omit<MessageV2.SubtaskPart, "id" | "messageID" | "sessionID"> & { id?: string })

function estimateTokens(byteSize: number): number {
  return Math.ceil(byteSize / 4)
}

function decodeDataUrl(url: string): Uint8Array {
  const comma = url.indexOf(",")
  if (comma < 0) throw new Error("invalid data URL attachment: missing payload separator")
  const meta = url.slice(0, comma).toLowerCase()
  const payload = url.slice(comma + 1)
  if (meta.includes(";base64")) return Uint8Array.from(Buffer.from(payload, "base64"))
  return Uint8Array.from(Buffer.from(decodeURIComponent(payload), "utf8"))
}

function previewBytes(bytes: Uint8Array, mime: string, limit: number): string | undefined {
  if (limit <= 0) return undefined
  const prefix = bytes.slice(0, Math.min(bytes.length, limit))
  if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json")) {
    return Buffer.from(prefix).toString("utf8")
  }
  return `[binary ${mime} content omitted; ${bytes.length} bytes stored by reference]`
}

/**
 * /specs/repo-incoming-attachments DD-17:
 * Try to land bytes in <repo>/incoming/<filename>. On success returns
 * { repoPath, sha256, sanitizedName }. On failure (no project context,
 * unsanitizable filename, fs error) returns null and the caller falls back
 * to the legacy attachments-table path. Logs a warning when falling back so
 * non-project sessions are visible in telemetry but not user-blocking.
 */
export async function tryLandInIncoming(input: {
  filename: string | undefined
  bytes: Uint8Array
  sessionID: string
  /**
   * Optional mime hint. When the mime classifies as an Office format
   * (per office-mime.ts), this function delegates to the upload-time
   * decompose hook (specs/docx-upload-autodecompose) which owns cache
   * lookup, paired version-rename, atomic write, AND the synchronous
   * fast-phase decompose call. For non-Office mimes (or when mime is
   * absent) the legacy dedupe + conflict-rename + atomic write path
   * runs unchanged.
   */
  mime?: string
}): Promise<{ repoPath: string; sha256: string; sanitizedName: string } | null> {
  if (!input.filename) {
    log.warn("incoming: skipping (no filename); will fall back to legacy attachments-table path")
    return null
  }
  let projectRoot: string
  try {
    projectRoot = IncomingPaths.projectRoot()
  } catch (err) {
    if (err instanceof IncomingPaths.NoProjectPathError) {
      log.warn("incoming: session has no project context, falling back to legacy attachments-table path", {
        sessionID: input.sessionID,
        instanceProjectId: Instance.project.id,
      })
      return null
    }
    throw err
  }

  // ── Office upload-time decompose hook (DD-9) ──────────────────────
  //
  // Delegates the whole flow (cache lookup, paired version-rename on
  // sha drift, atomic write, synchronous fast-phase decompose call,
  // background poll loop) to the docx-upload-autodecompose pipeline
  // when the mime is Office. Falls through to the legacy flow on any
  // non-Office mime or when sanitisation / hook setup fails.
  if (input.mime) {
    const officeKind = classifyOffice(input.mime, input.filename)
    if (officeKind !== "non-office") {
      let officeSanitized: string
      try {
        officeSanitized = IncomingPaths.sanitize(input.filename)
      } catch (err) {
        log.warn("incoming.office: filename sanitize failed, falling back to legacy path", {
          filename: input.filename,
          error: err instanceof Error ? err.message : String(err),
        })
        // Fall through; legacy code below sanitises and writes.
        // (Defining sanitizedName twice is avoided by structuring this
        // as an inline conditional rather than goto.)
        officeSanitized = ""
      }
      if (officeSanitized) {
        const { createHash } = await import("node:crypto")
        const sha256 = createHash("sha256").update(input.bytes).digest("hex")
        const result = await landOfficeUpload({
          filename: officeSanitized,
          mime: input.mime,
          bytes: input.bytes,
          sha256,
          projectRoot,
          sessionID: input.sessionID,
        }).catch((err) => {
          log.warn("incoming.office: landOfficeUpload threw, falling back to legacy storage", {
            sessionID: input.sessionID,
            filename: officeSanitized,
            error: err instanceof Error ? err.message : String(err),
          })
          return null
        })
        if (result) {
          return {
            repoPath: result.repoPath,
            sha256,
            sanitizedName: result.sanitizedName,
          }
        }
        // landOfficeUpload returned null → fall through to legacy.
      }
    }
  }

  let sanitizedName: string
  try {
    sanitizedName = IncomingPaths.sanitize(input.filename)
  } catch (err) {
    log.warn("incoming: filename sanitize failed, falling back to legacy attachments-table path", {
      sessionID: input.sessionID,
      filename: input.filename,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  // Resolve final filename — honour DD-8 conflict-rename if needed.
  const incomingDir = IncomingPaths.incomingDir(projectRoot)
  await fs.mkdir(incomingDir, { recursive: true })
  let targetName = sanitizedName
  let targetPath = path.join(incomingDir, targetName)

  // Compute incoming sha to enable dedupe / conflict detection per R5.
  const { createHash } = await import("node:crypto")
  const sha256 = createHash("sha256").update(input.bytes).digest("hex")

  if (existsSync(targetPath)) {
    // Compare with current file via cheap-stat-aware lookup.
    const currentSha = await IncomingHistory.lookupCurrentSha(sanitizedName, projectRoot).catch(() => null)
    if (currentSha === sha256) {
      // Identical — dedupe (R5-S2). No fs write; append upload-dedupe entry.
      await IncomingHistory.appendEntry(
        sanitizedName,
        IncomingHistory.makeEntry({
          source: "upload-dedupe",
          sha256,
          sizeBytes: input.bytes.byteLength,
          sessionId: input.sessionID,
        }),
        { root: projectRoot, emitBus: true },
      )
      return { repoPath: path.join(IncomingPaths.INCOMING_DIR, sanitizedName), sha256, sanitizedName }
    }
    // Different content (or unknown current) — conflict-rename (R5-S1, DD-8).
    targetName = IncomingPaths.nextConflictName(incomingDir, sanitizedName)
    targetPath = path.join(incomingDir, targetName)
    // Mark redirect on the original slot's history.
    await IncomingHistory.appendEntry(
      sanitizedName,
      IncomingHistory.makeEntry({
        source: "upload-conflict-rename",
        sha256,
        sizeBytes: input.bytes.byteLength,
        sessionId: input.sessionID,
        redirectedTo: targetName,
      }),
      { root: projectRoot, emitBus: true },
    )
  }

  // Atomic write via temp + rename.
  const tmpPath = `${targetPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await fs.writeFile(tmpPath, input.bytes)
  await fs.rename(tmpPath, targetPath)
  const stat = await fs.stat(targetPath)
  await IncomingHistory.appendEntry(
    targetName,
    IncomingHistory.makeEntry({
      source: "upload",
      sha256,
      sizeBytes: stat.size,
      mtime: Math.floor(stat.mtimeMs),
      sessionId: input.sessionID,
    }),
    { root: projectRoot, emitBus: true },
  )

  return { repoPath: path.join(IncomingPaths.INCOMING_DIR, targetName), sha256, sanitizedName: targetName }
}

async function routeOversizedAttachment(input: {
  sessionID: string
  messageID: string
  part: Omit<MessageV2.FilePart, "id" | "messageID" | "sessionID"> & { id?: string }
  bytes: Uint8Array
}): Promise<MessageV2.AttachmentRefPart | undefined> {
  const cfg = Tweaks.bigContentBoundarySync()
  const byteSize = input.bytes.byteLength
  // Rich-media attachments (images, PDFs) always route through the reader
  // subagent regardless of size — keeps behaviour consistent (small and large
  // images are read the same way) and prevents image bytes from leaking into
  // the main agent's context. Only plain text-like attachments still honour
  // the byte threshold, since main reading raw text inline is its native job.
  //
  // /specs/repo-incoming-attachments: Office binary formats (.docx / .xlsx /
  // .pptx + legacy variants) ALWAYS force-route too. Reason: small docs
  // were going inline as data-URL file parts under the old threshold, never
  // reaching tryLandInIncoming, so they never landed in <repo>/incoming/.
  // We want every non-text upload on disk with a sha256 in history so the
  // mcp dispatcher can pick them up.
  const mime = input.part.mime
  const isOfficeBinary =
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mime === "application/msword" ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.ms-powerpoint"
  const forceRefRoute = mime.startsWith("image/") || mime === "application/pdf" || isOfficeBinary
  if (!forceRefRoute && byteSize <= cfg.userAttachmentMaxBytes) {
    emitBoundaryRoutingTelemetry({
      boundary: "user_attachment",
      action: "inline",
      mime: input.part.mime,
      byteSize,
      estTokens: estimateTokens(byteSize),
      thresholdBytes: cfg.userAttachmentMaxBytes,
      hasFilename: !!input.part.filename,
      reason: "below_threshold",
    })
    return undefined
  }

  const refID = Identifier.ascending("part")

  // /specs/repo-incoming-attachments DD-17 main path: try to land bytes in
  // <repo>/incoming/. On success the AttachmentRefPart carries repo_path +
  // sha256 and we skip upsertAttachmentBlob entirely. On failure (non-project
  // session, sanitize reject, fs error) fall back to the legacy attachments-
  // table content blob path so existing flows keep working.
  const landed = await tryLandInIncoming({
    filename: input.part.filename,
    bytes: input.bytes,
    sessionID: input.sessionID,
    mime: input.part.mime,
  }).catch((err) => {
    log.warn("incoming: tryLandInIncoming threw, falling back to legacy storage", {
      sessionID: input.sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
    return null as null
  })

  let repoPath: string | undefined
  let sha256: string | undefined

  if (landed) {
    repoPath = landed.repoPath
    sha256 = landed.sha256
  } else {
    await attachmentBlobWriter.upsertAttachmentBlob({
      refID,
      sessionID: input.sessionID,
      messageID: input.messageID,
      mime: input.part.mime,
      filename: input.part.filename,
      byteSize,
      estTokens: estimateTokens(byteSize),
      createdAt: Date.now(),
      content: input.bytes,
    })
  }

  emitBoundaryRoutingTelemetry({
    boundary: "user_attachment",
    action: "attachment_ref",
    refID,
    mime: input.part.mime,
    byteSize,
    estTokens: estimateTokens(byteSize),
    thresholdBytes: cfg.userAttachmentMaxBytes,
    previewBytes: cfg.attachmentPreviewBytes,
    truncated: byteSize > cfg.attachmentPreviewBytes,
    hasFilename: !!input.part.filename,
    reason: landed ? "above_threshold:incoming" : "above_threshold:legacy",
  })

  return {
    id: Identifier.ascending("part"),
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "attachment_ref",
    ref_id: refID,
    mime: input.part.mime,
    filename: landed?.sanitizedName ?? input.part.filename,
    byte_size: byteSize,
    est_tokens: estimateTokens(byteSize),
    preview: previewBytes(input.bytes, input.part.mime, cfg.attachmentPreviewBytes),
    repo_path: repoPath,
    sha256: sha256,
  }
}

export async function buildUserMessageParts(input: {
  partsInput: UserMessagePartInput[]
  info: MessageV2.User
  sessionID: string
  agentName: string
  agentPermission: PermissionNext.Ruleset
}) {
  const parts = await Promise.all(
    input.partsInput.map(async (part): Promise<MessageV2.Part[]> => {
      if (part.type === "file") {
        const urlPrefix = part.url.includes(",") ? part.url.split(",")[0] : part.url.slice(0, 80)
        debugCheckpoint("prompt.file", "part:received", {
          mime: part.mime,
          filename: part.filename,
          sourceType: part.source?.type,
          sourcePath: part.source?.type === "file" || part.source?.type === "symbol" ? part.source.path : undefined,
          urlPrefix,
        })
        // before checking the protocol we check if this is an mcp resource because it needs special handling
        if (part.source?.type === "resource") {
          const { clientName, uri } = part.source
          debugCheckpoint("prompt.file", "mcp:resource", {
            clientName,
            uri,
            mime: part.mime,
            filename: part.filename,
          })
          log.info("mcp resource", { clientName, uri, mime: part.mime })

          const pieces: MessageV2.Part[] = [
            {
              id: Identifier.ascending("part"),
              messageID: input.info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text: `Reading MCP resource: ${part.filename} (${uri})`,
            },
          ]

          try {
            const resourceContent = await MCP.readResource(clientName, uri)
            if (!resourceContent) {
              throw new Error(`Resource not found: ${clientName}/${uri}`)
            }

            // Handle different content types
            const contents = Array.isArray(resourceContent.contents)
              ? resourceContent.contents
              : [resourceContent.contents]

            for (const content of contents) {
              if ("text" in content && content.text) {
                pieces.push({
                  id: Identifier.ascending("part"),
                  messageID: input.info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: content.text as string,
                })
              } else if ("blob" in content && content.blob) {
                // Handle binary content if needed
                const mimeType = "mimeType" in content ? content.mimeType : part.mime
                pieces.push({
                  id: Identifier.ascending("part"),
                  messageID: input.info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `[Binary content: ${mimeType}]`,
                })
              }
            }

            pieces.push({
              ...part,
              id: part.id ?? Identifier.ascending("part"),
              messageID: input.info.id,
              sessionID: input.sessionID,
            })
          } catch (error: unknown) {
            log.error("failed to read MCP resource", { error, clientName, uri })
            const message = error instanceof Error ? error.message : String(error)
            pieces.push({
              id: Identifier.ascending("part"),
              messageID: input.info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              text: `Failed to read MCP resource ${part.filename}: ${message}`,
            })
          }

          return pieces
        }
        const url = new URL(part.url)
        switch (url.protocol) {
          case "data:": {
            const dataBytes = decodeDataUrl(part.url)
            const attachmentRef = await routeOversizedAttachment({
              sessionID: input.sessionID,
              messageID: input.info.id,
              part,
              bytes: dataBytes,
            })
            if (attachmentRef) return [attachmentRef]
            if (part.mime === "text/plain") {
              debugCheckpoint("prompt.file", "data:text", {
                mime: part.mime,
                filename: part.filename,
                urlPrefix: part.url.split(",")[0],
              })
              return [
                {
                  id: Identifier.ascending("part"),
                  messageID: input.info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                },
                {
                  id: Identifier.ascending("part"),
                  messageID: input.info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: Buffer.from(part.url, "base64url").toString(),
                },
                {
                  ...part,
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: input.info.id,
                  sessionID: input.sessionID,
                },
              ]
            }
            break
          }
          case "file:": {
            log.info("file", { mime: part.mime })
            // have to normalize, symbol search returns absolute paths
            // Decode the pathname since URL constructor doesn't automatically decode it
            const filepath = fileURLToPath(part.url)
            debugCheckpoint("prompt.file", "file:resolved", {
              filepath,
              mime: part.mime,
              filename: part.filename,
            })
            const stat = await Bun.file(filepath).stat()

            if (stat.isDirectory()) {
              part.mime = "application/x-directory"
            }

            if (!stat.isDirectory()) {
              const fileBytes = await Bun.file(filepath).bytes()
              const attachmentRef = await routeOversizedAttachment({
                sessionID: input.sessionID,
                messageID: input.info.id,
                part,
                bytes: fileBytes,
              })
              if (attachmentRef) {
                FileTime.read(input.sessionID, filepath)
                return [
                  {
                    id: Identifier.ascending("part"),
                    messageID: input.info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                    synthetic: true,
                  },
                  attachmentRef,
                ]
              }
            }

            if (part.mime === "text/plain") {
              let offset: number | undefined = undefined
              let limit: number | undefined = undefined
              const range = {
                start: url.searchParams.get("start"),
                end: url.searchParams.get("end"),
              }
              if (range.start != null) {
                const filePathURI = part.url.split("?")[0]
                let start = parseInt(range.start)
                let end = range.end ? parseInt(range.end) : undefined
                // some LSP servers (eg, gopls) don't give full range in
                // workspace/symbol searches, so we'll try to find the
                // symbol in the document to get the full range
                if (start === end) {
                  const symbols = await LSP.documentSymbol(filePathURI)
                  for (const symbol of symbols) {
                    let range: LSP.Range | undefined
                    if ("range" in symbol) {
                      range = symbol.range
                    } else if ("location" in symbol) {
                      range = symbol.location.range
                    }
                    if (range?.start?.line && range?.start?.line === start) {
                      start = range.start.line
                      end = range?.end?.line ?? start
                      break
                    }
                  }
                }
                offset = Math.max(start - 1, 0)
                if (end) {
                  limit = end - offset
                }
              }
              const args = { filePath: filepath, offset, limit }
              debugCheckpoint("prompt.file", "read:call", {
                filepath,
                mime: part.mime,
                filename: part.filename,
                offset,
                limit,
              })

              const pieces: MessageV2.Part[] = [
                {
                  id: Identifier.ascending("part"),
                  messageID: input.info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                },
              ]

              await ReadTool.init()
                .then(async (t) => {
                  const model = await Provider.getModel(input.info.model.providerId, input.info.model.modelID)
                  const readCtx: Tool.Context = {
                    sessionID: input.sessionID,
                    abort: new AbortController().signal,
                    agent: input.agentName,
                    messageID: input.info.id,
                    extra: { bypassCwdCheck: true, model },
                    messages: [],
                    metadata: async () => {},
                    ask: async () => {},
                  }
                  const result = await t.execute(args, readCtx)
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: input.info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  })
                  if (result.attachments?.length) {
                    pieces.push(
                      ...result.attachments.map((attachment) => ({
                        ...attachment,
                        id: Identifier.ascending("part"),
                        synthetic: true,
                        filename: attachment.filename ?? part.filename,
                        messageID: input.info.id,
                        sessionID: input.sessionID,
                      })),
                    )
                  } else {
                    pieces.push({
                      ...part,
                      id: part.id ?? Identifier.ascending("part"),
                      messageID: input.info.id,
                      sessionID: input.sessionID,
                    })
                  }
                })
                .catch((error) => {
                  log.error("failed to read file", { error })
                  const message = error instanceof Error ? error.message : error.toString()
                  debugCheckpoint("prompt.file", "read:error", { filepath, error: message })
                  Bus.publish(Session.Event.Error, {
                    sessionID: input.sessionID,
                    error: new NamedError.Unknown({
                      message,
                    }).toObject(),
                  })
                  pieces.push({
                    id: Identifier.ascending("part"),
                    messageID: input.info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                  })
                })

              return pieces
            }

            if (part.mime === "application/x-directory") {
              const args = { filePath: filepath }
              const listCtx: Tool.Context = {
                sessionID: input.sessionID,
                abort: new AbortController().signal,
                agent: input.agentName,
                messageID: input.info.id,
                extra: { bypassCwdCheck: true },
                messages: [],
                metadata: async () => {},
                ask: async () => {},
              }
              const result = await ReadTool.init().then((t) => t.execute(args, listCtx))
              return [
                {
                  id: Identifier.ascending("part"),
                  messageID: input.info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                },
                {
                  id: Identifier.ascending("part"),
                  messageID: input.info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: result.output,
                },
                {
                  ...part,
                  id: part.id ?? Identifier.ascending("part"),
                  messageID: input.info.id,
                  sessionID: input.sessionID,
                },
              ]
            }

            const file = Bun.file(filepath)
            FileTime.read(input.sessionID, filepath)
            return [
              {
                id: Identifier.ascending("part"),
                messageID: input.info.id,
                sessionID: input.sessionID,
                type: "text",
                text: `Called the Read tool with the following input: {\"filePath\":\"${filepath}\"}`,
                synthetic: true,
              },
              {
                id: part.id ?? Identifier.ascending("part"),
                messageID: input.info.id,
                sessionID: input.sessionID,
                type: "file",
                url: `data:${part.mime};base64,` + Buffer.from(await file.bytes()).toString("base64"),
                mime: part.mime,
                filename: part.filename!,
                source: part.source,
              },
            ]
          }
        }
      }

      if (part.type === "agent") {
        // Check if this agent would be denied by task permission
        const perm = PermissionNext.evaluate("task", part.name, input.agentPermission)
        const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
        return [
          {
            id: Identifier.ascending("part"),
            ...part,
            messageID: input.info.id,
            sessionID: input.sessionID,
          },
          {
            id: Identifier.ascending("part"),
            messageID: input.info.id,
            sessionID: input.sessionID,
            type: "text",
            synthetic: true,
            // An extra space is added here. Otherwise the 'Use' gets appended
            // to user's last word; making a combined word
            text:
              " Use the above message and context to generate a prompt and call the task tool with subagent: " +
              part.name +
              hint,
          },
        ]
      }

      return [
        {
          id: Identifier.ascending("part"),
          ...part,
          messageID: input.info.id,
          sessionID: input.sessionID,
        },
      ]
    }),
  )
    .then((x) => x.flat())
    .then((drafts) =>
      drafts.map(
        (part): MessageV2.Part => ({
          ...part,
          id: Identifier.ascending("part"),
          messageID: input.info.id,
          sessionID: input.sessionID,
        }),
      ),
    )

  return parts
}
