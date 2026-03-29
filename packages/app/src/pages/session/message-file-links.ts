import { createPathHelpers } from "@/context/file/path"

const FILE_LINK_SCHEME = "opencode-file://"
const FILE_REF_PATTERN =
  /(?:\/[A-Za-z0-9._\-/]+\.[A-Za-z0-9_-]+|(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+)(?::\d+)?/g

type FileRef = {
  original: string
  path: string
  line?: number
}

function splitLineSuffix(input: string) {
  const match = input.match(/^(.*?)(?::(\d+))?$/)
  if (!match) return { path: input }
  const line = match[2] ? Number(match[2]) : undefined
  return { path: match[1] ?? input, line }
}

function isInsideWorkspaceAbsolute(path: string, workspaceRoot: string) {
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "")
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`)
}

function isValidRelativePath(path: string) {
  if (!path) return false
  if (path.startsWith("../") || path.startsWith("./") || path.startsWith("~")) return false
  if (/^(https?:|data:|blob:|file:)/i.test(path)) return false
  return /\.[A-Za-z0-9_-]+$/.test(path)
}

export function encodeFileLink(path: string, line?: number) {
  const query = line ? `?line=${line}` : ""
  return `${FILE_LINK_SCHEME}${encodeURIComponent(path)}${query}`
}

export function decodeFileLink(href: string) {
  if (!href.startsWith(FILE_LINK_SCHEME)) return
  const url = new URL(href)
  const encodedPath = `${url.host}${url.pathname}`
  const path = decodeURIComponent(encodedPath)
  const line = url.searchParams.get("line")
  return {
    path,
    line: line ? Number(line) : undefined,
  }
}

export function detectFileReference(candidate: string, workspaceRoot: string): FileRef | undefined {
  const trimmed = candidate.replace(/[),.;]+$/, "")
  const { path, line } = splitLineSuffix(trimmed)
  if (!path) return

  if (path.startsWith("/")) {
    if (!isInsideWorkspaceAbsolute(path, workspaceRoot)) return
    return { original: trimmed, path, line }
  }

  if (!isValidRelativePath(path)) return
  return { original: trimmed, path, line }
}

function linkifySegment(text: string, workspaceRoot: string) {
  return text.replace(FILE_REF_PATTERN, (match, offset, source) => {
    const prev = offset > 0 ? source[offset - 1] : ""
    if (prev === "(" || prev === "[" || prev === "`") return match
    const ref = detectFileReference(match, workspaceRoot)
    if (!ref) return match
    return `[${ref.original}](${encodeFileLink(ref.path, ref.line)})`
  })
}

export function linkifyFileReferences(text: string, workspaceRoot: string) {
  const lines = text.split("\n")
  let inFence = false

  return lines
    .map((line) => {
      const trimmed = line.trimStart()
      if (/^(```|~~~)/.test(trimmed)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line

      const parts = line.split(/(`[^`]*`)/g)
      return parts
        .map((part) => {
          if (part.startsWith("`") && part.endsWith("`")) return part
          return linkifySegment(part, workspaceRoot)
        })
        .join("")
    })
    .join("\n")
}

export function resolveFileReferencePath(input: string, workspaceRoot: string) {
  const path = createPathHelpers(() => workspaceRoot)
  return path.normalize(input)
}
