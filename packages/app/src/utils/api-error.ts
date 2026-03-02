const PROJECT_BOUNDARY_PATTERN = /path escapes project directory/i

function extractMessage(error: unknown): string | undefined {
  let msg: string | undefined
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: string } }).data
    if (typeof data?.message === "string" && data.message.trim().length > 0) msg = data.message
  } else if (error instanceof Error && error.message) {
    msg = error.message
  } else if (typeof error === "string" && error.trim().length > 0) {
    msg = error
  }

  if (msg && (msg.trim().toLowerCase().startsWith("<!doctype html") || /(<\s*html[^>]*>|<\s*body[^>]*>)/i.test(msg))) {
    return undefined // will cause fallback to be used
  }

  return msg
}

export function formatApiErrorMessage(input: { error: unknown; fallback: string; projectBoundaryMessage?: string }) {
  if (input.error instanceof Error && input.error.message === "__OPENCODE_SILENT_UNAUTHORIZED__") {
    return "__OPENCODE_SILENT_UNAUTHORIZED__"
  }
  const raw = extractMessage(input.error)
  if (!raw) return input.fallback
  if (PROJECT_BOUNDARY_PATTERN.test(raw)) {
    return (
      input.projectBoundaryMessage ??
      "This action is limited to the current workspace directory. Switch workspace or choose a path inside the active project."
    )
  }
  return raw
}
