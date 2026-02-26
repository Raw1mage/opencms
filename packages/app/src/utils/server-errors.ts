export type ConfigInvalidError = {
  name: "ConfigInvalidError"
  data: {
    path?: string
    message?: string
    issues?: Array<{ message: string; path: string[] }>
  }
}

function isConfigInvalidErrorLike(error: unknown): error is ConfigInvalidError {
  if (typeof error !== "object" || error === null) return false
  const obj = error as Record<string, unknown>
  return obj.name === "ConfigInvalidError" && typeof obj.data === "object" && obj.data !== null
}

export function formatReadableConfigInvalidError(error: ConfigInvalidError) {
  const head = "Invalid configuration"
  const file = error.data.path && error.data.path !== "config" ? error.data.path : ""
  const detail = error.data.message?.trim() ?? ""
  const issues = (error.data.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`)
  if (issues.length) return [head, file, ...issues].filter(Boolean).join("\n")
  return [head, file, detail].filter(Boolean).join("\n")
}

export function formatServerError(error: unknown) {
  if (isConfigInvalidErrorLike(error)) return formatReadableConfigInvalidError(error)
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Unknown error"
}
