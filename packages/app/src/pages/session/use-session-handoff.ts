import { createEffect } from "solid-js"
import { usePrompt } from "@/context/prompt"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { useLanguage } from "@/context/language"
import { useFile, type SelectedLineRange } from "@/context/file"
import { handoff } from "./utils/handoff"

interface HandoffOptions {
  tabs: () => { all: () => string[] }
}

export function useSessionHandoff(options: HandoffOptions) {
  const prompt = usePrompt()
  const terminal = useTerminal()
  const language = useLanguage()
  const file = useFile()

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    handoff.prompt = previewPrompt()
  })

  createEffect(() => {
    if (!terminal.ready()) return
    language.locale()

    const label = (pty: LocalPTY) => {
      const title = pty.title
      const number = pty.titleNumber
      const match = title.match(/^Terminal (\d+)$/)
      const parsed = match ? Number(match[1]) : undefined
      const isDefaultTitle = Number.isFinite(number) && number > 0 && Number.isFinite(parsed) && parsed === number

      if (title && !isDefaultTitle) return title
      if (Number.isFinite(number) && number > 0) return language.t("terminal.title.numbered", { number })
      if (title) return title
      return language.t("terminal.title")
    }

    handoff.terminals = terminal.all().map(label)
  })

  createEffect(() => {
    if (!file.ready()) return
    handoff.files = Object.fromEntries(
      options
        .tabs()
        .all()
        .flatMap((tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return []
          return [[path, file.selectedLines(path) ?? null] as const]
        }),
    ) as Record<string, SelectedLineRange | null>
  })
}
