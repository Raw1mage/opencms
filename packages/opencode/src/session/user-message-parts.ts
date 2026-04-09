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

const log = Log.create({ service: "session.user-message-parts" })

type UserMessagePartInput =
  | (Omit<MessageV2.TextPart, "id" | "messageID" | "sessionID"> & { id?: string })
  | (Omit<MessageV2.FilePart, "id" | "messageID" | "sessionID"> & { id?: string })
  | (Omit<MessageV2.AgentPart, "id" | "messageID" | "sessionID"> & { id?: string })
  | (Omit<MessageV2.SubtaskPart, "id" | "messageID" | "sessionID"> & { id?: string })

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
          case "data:":
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
        if (part.name === "plan" || part.name === "planner") {
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
              text: " The user explicitly requested planner mode via @planner. Do not treat this as a subagent task. Load the planner skill and continue planner-first discussion, maintaining the active planner artifacts.",
            },
          ]
        }

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
