export function promptPlaceholder(options: {
  mode: "normal" | "shell"
  commentCount: number
  example: string
  t: (key: any, params?: any) => string
}) {
  if (options.mode === "shell") {
    return options.t("prompt.placeholder.shell")
  }
  if (options.commentCount > 1) {
    return options.t("prompt.placeholder.summarizeComments")
  }
  if (options.commentCount === 1) {
    return options.t("prompt.placeholder.summarizeComment")
  }
  return options.t("prompt.placeholder.normal", { example: options.example })
}
