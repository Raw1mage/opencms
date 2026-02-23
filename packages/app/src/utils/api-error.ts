const PROJECT_BOUNDARY_PATTERN = /path escapes project directory/i

function extractMessage(error: unknown): string | undefined {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: string } }).data
    if (typeof data?.message === "string" && data.message.trim().length > 0) return data.message
  }
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error.trim().length > 0) return error
  return
}

export function formatApiErrorMessage(input: { error: unknown; fallback: string; projectBoundaryMessage?: string }) {
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
