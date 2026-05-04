const FILE_REF_PATTERN =
  /(?:\/[A-Za-z0-9._\-/]+\.[A-Za-z0-9_-]+|(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+)(?::\d+){0,2}/g

function isInsideWorkspaceAbsolute(path: string, workspaceRoot: string) {
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "")
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`)
}

function isValidRelativePath(path: string) {
  if (!path) return false
  if (path.startsWith("../") || path.startsWith("./") || path.startsWith("~")) return false
  if (/^(https?:|data:|blob:|file:|opencode-file:)/i.test(path)) return false
  // Require a directory separator: bare basenames like "grafcet.step4.svg"
  // are ambiguous (could exist anywhere in the workspace) and resolving
  // them as workspace-root-relative produces broken links pointing to
  // the wrong location. Force the AI to spell out a path before we link it.
  if (!path.includes("/")) return false
  return /\.[A-Za-z0-9_-]+$/.test(path)
}

function encodeFileLink(path: string, line?: number, column?: number) {
  const params = new URLSearchParams()
  if (line) params.set("line", String(line))
  if (column) params.set("column", String(column))
  const query = params.size > 0 ? `?${params.toString()}` : ""
  return `opencode-file://${encodeURIComponent(path)}${query}`
}

function detectFileReference(candidate: string, workspaceRoot: string) {
  const trimmed = candidate.replace(/[),.;]+$/, "")
  const m = trimmed.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/)
  if (!m) return
  const path = m[1] ?? trimmed
  if (!path) return
  const line = m[2] ? Number(m[2]) : undefined
  const column = m[3] ? Number(m[3]) : undefined
  if (path.startsWith("/")) {
    if (!isInsideWorkspaceAbsolute(path, workspaceRoot)) return
    return { original: trimmed, path, line, column }
  }
  if (!isValidRelativePath(path)) return
  return { original: trimmed, path, line, column }
}

function linkifyFileSegment(text: string, workspaceRoot: string) {
  return text.replace(FILE_REF_PATTERN, (match, offset, source) => {
    const prev = offset > 0 ? source[offset - 1] : ""
    if (prev === "(" || prev === "[" || prev === "`") return match
    const ref = detectFileReference(match, workspaceRoot)
    if (!ref) return match
    return `[${ref.original}](${encodeFileLink(ref.path, ref.line, ref.column)})`
  })
}

export function linkifyFileReferences(text: string, workspaceRoot: string | undefined) {
  if (!workspaceRoot) return text
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
          if (part.startsWith("`") && part.endsWith("`")) {
            const inner = part.slice(1, -1).trim()
            if (!inner) return part
            const ref = detectFileReference(inner, workspaceRoot)
            if (!ref) return part
            return `[${part}](${encodeFileLink(ref.path, ref.line, ref.column)})`
          }
          return linkifyFileSegment(part, workspaceRoot)
        })
        .join("")
    })
    .join("\n")
}
