export function stripFileProtocol(input: string) {
  if (!input.startsWith("file://")) return input
  return input.slice("file://".length)
}

export function stripQueryAndHash(input: string) {
  const hashIndex = input.indexOf("#")
  const queryIndex = input.indexOf("?")

  if (hashIndex !== -1 && queryIndex !== -1) {
    return input.slice(0, Math.min(hashIndex, queryIndex))
  }

  if (hashIndex !== -1) return input.slice(0, hashIndex)
  if (queryIndex !== -1) return input.slice(0, queryIndex)
  return input
}

export function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return new TextDecoder().decode(new Uint8Array(bytes))
}

export function decodeFilePath(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export function encodeFilePath(filepath: string): string {
  // Normalize Windows paths: convert backslashes to forward slashes
  let normalized = filepath.replace(/\\/g, "/")

  // Handle Windows absolute paths (D:/path -> /D:/path for proper file:// URLs)
  if (/^[A-Za-z]:/.test(normalized)) {
    normalized = "/" + normalized
  }

  // Encode each path segment (preserving forward slashes as path separators)
  // Keep the colon in Windows drive letters (`/C:/...`) so downstream file URL parsers
  // can reliably detect drives.
  return normalized
    .split("/")
    .map((segment, index) => {
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment
      return encodeURIComponent(segment)
    })
    .join("/")
}

export function createPathHelpers(scope: () => string) {
  const normalize = (input: string) => {
    const root = scope().replace(/\\/g, "/")

    let path = unquoteGitPath(decodeFilePath(stripQueryAndHash(stripFileProtocol(input)))).replace(/\\/g, "/")
    const wasAbsolute = path.startsWith("/") || /^[A-Za-z]:/.test(path)

    const windows = /^[A-Za-z]:/.test(root)
    const canonRoot = windows ? root.toLowerCase() : root
    const canonPath = windows ? path.toLowerCase() : path
    if (
      canonPath.startsWith(canonRoot) &&
      (canonRoot.endsWith("/") || canonPath === canonRoot || canonPath[canonRoot.length] === "/")
    ) {
      path = path.slice(root.length)
    }

    if (path.startsWith("./") || path.startsWith(".\\")) {
      path = path.slice(2)
    }

    if (path.startsWith("/") || path.startsWith("\\")) {
      path = path.slice(1)
    }

    // Strip workspace-basename prefix from genuinely relative inputs.
    // The AI naturally cites paths as "opencode/specs/foo.svg" (project name
    // prefix), but normalize otherwise returns that verbatim and file loads
    // resolve to <workspace>/opencode/specs/... — a bogus path. Only apply
    // when the original input was relative; absolute inputs that happen to
    // contain a same-named subdirectory must not be mangled.
    if (!wasAbsolute && path) {
      const basename = root.replace(/\/+$/, "").split("/").pop()
      if (basename && basename.length > 0) {
        const prefix = `${basename}/`
        const canon = windows ? path.toLowerCase() : path
        const canonPrefix = windows ? prefix.toLowerCase() : prefix
        if (canon.startsWith(canonPrefix)) {
          path = path.slice(prefix.length)
        }
      }
    }

    return path
  }

  const tab = (input: string) => {
    const path = normalize(input)
    return `file://${encodeFilePath(path)}`
  }

  const pathFromTab = (tabValue: string) => {
    if (!tabValue.startsWith("file://")) return
    return normalize(tabValue)
  }

  const normalizeDir = (input: string) => normalize(input).replace(/\/+$/, "")

  return {
    normalize,
    tab,
    pathFromTab,
    normalizeDir,
  }
}
