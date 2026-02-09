import { type Prompt, type ImageAttachmentPart, type FileAttachmentPart, type AgentPart } from "@/context/prompt"
import { type FileSelection } from "@/context/file"
import { Identifier } from "@/utils/id"
import { getFilename } from "@opencode-ai/util/path"
import { type Part } from "@opencode-ai/sdk/v2/client"

type RequestPartsInput = {
  prompt: Prompt
  context: any[]
  images: ImageAttachmentPart[]
  text: string
  sessionID: string
  messageID: string
  sessionDirectory: string
}

export function buildRequestParts(input: RequestPartsInput) {
  const { prompt, context, images, text, sessionID, messageID, sessionDirectory } = input

  const toAbsolutePath = (path: string) =>
    path.startsWith("/") ? path : (sessionDirectory + "/" + path).replace("//", "/")

  const encodeFilePath = (filepath: string): string =>
    filepath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")

  const fileAttachments = prompt.filter((part) => part.type === "file") as FileAttachmentPart[]
  const agentAttachments = prompt.filter((part) => part.type === "agent") as AgentPart[]

  const fileAttachmentParts = fileAttachments.map((attachment) => {
    const absolute = toAbsolutePath(attachment.path)
    const query = attachment.selection
      ? `?start=${attachment.selection.startLine}&end=${attachment.selection.endLine}`
      : ""
    return {
      id: Identifier.ascending("part"),
      type: "file" as const,
      mime: "text/plain",
      url: `file://${encodeFilePath(absolute)}${query}`,
      filename: getFilename(attachment.path),
      source: {
        type: "file" as const,
        text: {
          value: attachment.content,
          start: attachment.start,
          end: attachment.end,
        },
        path: absolute,
      },
    }
  })

  const agentAttachmentParts = agentAttachments.map((attachment) => ({
    id: Identifier.ascending("part"),
    type: "agent" as const,
    name: attachment.name,
    source: {
      value: attachment.content,
      start: attachment.start,
      end: attachment.end,
    },
  }))

  const usedUrls = new Set(fileAttachmentParts.map((part) => part.url))

  const contextParts: Array<any> = []

  const commentNote = (path: string, selection: FileSelection | undefined, comment: string) => {
    const start = selection ? Math.min(selection.startLine, selection.endLine) : undefined
    const end = selection ? Math.max(selection.startLine, selection.endLine) : undefined
    const range =
      start === undefined || end === undefined
        ? "this file"
        : start === end
          ? `line ${start}`
          : `lines ${start} through ${end}`

    return `The user made the following comment regarding ${range} of ${path}: ${comment}`
  }

  const addContextFile = (input: { path: string; selection?: FileSelection; comment?: string }) => {
    const absolute = toAbsolutePath(input.path)
    const query = input.selection ? `?start=${input.selection.startLine}&end=${input.selection.endLine}` : ""
    const url = `file://${encodeFilePath(absolute)}${query}`

    const comment = input.comment?.trim()
    if (!comment && usedUrls.has(url)) return
    usedUrls.add(url)

    if (comment) {
      contextParts.push({
        id: Identifier.ascending("part"),
        type: "text",
        text: commentNote(input.path, input.selection, comment),
        synthetic: true,
      })
    }

    contextParts.push({
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url,
      filename: getFilename(input.path),
    })
  }

  for (const item of context) {
    if (item.type !== "file") continue
    addContextFile({ path: item.path, selection: item.selection, comment: item.comment })
  }

  const imageAttachmentParts = images.map((attachment) => ({
    id: Identifier.ascending("part"),
    type: "file" as const,
    mime: attachment.mime,
    url: attachment.dataUrl,
    filename: attachment.filename,
  }))

  const textPart = {
    id: Identifier.ascending("part"),
    type: "text" as const,
    text,
  }

  const requestParts = [
    textPart,
    ...fileAttachmentParts,
    ...contextParts,
    ...agentAttachmentParts,
    ...imageAttachmentParts,
  ]

  const optimisticParts = requestParts.map((part) => ({
    ...part,
    sessionID,
    messageID,
  })) as unknown as Part[]

  return {
    requestParts,
    optimisticParts,
  }
}
