import { $ } from "bun"
import { ConfigMarkdown } from "../config/markdown"

const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

function parseCommandArguments(argumentsText: string) {
  const raw = argumentsText.match(argsRegex) ?? []
  return raw.map((arg) => arg.replace(quoteTrimRegex, ""))
}

export async function renderCommandTemplate(input: {
  templateCommand: string
  argumentsText: string
}) {
  const args = parseCommandArguments(input.argumentsText)
  const placeholders = input.templateCommand.match(placeholderRegex) ?? []

  let last = 0
  for (const item of placeholders) {
    const value = Number(item.slice(1))
    if (value > last) last = value
  }

  const withArgs = input.templateCommand.replaceAll(placeholderRegex, (_, index) => {
    const position = Number(index)
    const argIndex = position - 1
    if (argIndex >= args.length) return ""
    if (position === last) return args.slice(argIndex).join(" ")
    return args[argIndex]
  })

  const usesArgumentsPlaceholder = input.templateCommand.includes("$ARGUMENTS")
  let template = withArgs.replaceAll("$ARGUMENTS", input.argumentsText)

  if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.argumentsText.trim()) {
    template = template + "\n\n" + input.argumentsText
  }

  const shell = ConfigMarkdown.shell(template)
  if (shell.length > 0) {
    const results = await Promise.all(
      shell.map(async ([, cmd]) => {
        try {
          return await $`${{ raw: cmd }}`.quiet().nothrow().text()
        } catch (error) {
          return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
        }
      }),
    )
    let index = 0
    template = template.replace(bashRegex, () => results[index++])
  }

  return template.trim()
}
