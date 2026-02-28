import { Show, createEffect, createMemo } from "solid-js"
import { useSearchParams } from "@solidjs/router"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Terminal } from "@/components/terminal"
import { useLanguage } from "@/context/language"
import { useTerminal } from "@/context/terminal"

export default function TerminalPopoutRoute() {
  const language = useLanguage()
  const terminal = useTerminal()
  const [searchParams] = useSearchParams<{ pty?: string }>()

  const requestedID = createMemo(() => searchParams.pty)

  const selectedID = createMemo(() => {
    const all = terminal.all()
    const requested = requestedID()
    if (requested && all.some((x) => x.id === requested)) return requested
    return terminal.active() ?? all[0]?.id
  })

  const selectedPTY = createMemo(() => {
    const id = selectedID()
    if (!id) return
    return terminal.all().find((x) => x.id === id)
  })

  createEffect(() => {
    const id = selectedID()
    if (!id) return
    if (terminal.active() !== id) terminal.open(id)
    document.title = `${language.t("terminal.title")} · ${selectedPTY()?.title ?? id}`
  })

  return (
    <div class="size-full flex flex-col bg-background-base">
      <div class="h-10 shrink-0 border-b border-border-weak-base flex items-center justify-between px-2">
        <div class="text-13-medium text-text-strong truncate">
          {language.t("terminal.title")}: {selectedPTY()?.title ?? "-"}
        </div>
        <div class="flex items-center gap-1">
          <IconButton
            icon="plus-small"
            variant="ghost"
            onClick={terminal.new}
            aria-label={language.t("command.terminal.new")}
          />
          <IconButton
            icon="close"
            variant="ghost"
            onClick={() => window.close()}
            aria-label={language.t("common.close")}
          />
        </div>
      </div>

      <div class="flex-1 min-h-0 relative">
        <Show
          when={selectedPTY()}
          fallback={
            <div class="size-full flex items-center justify-center text-text-weak">
              {language.t("terminal.loading")}
            </div>
          }
        >
          {(pty) => (
            <div class="absolute inset-0">
              <Terminal
                pty={pty()}
                class="!px-0 !py-0"
                contextMenuCopiesSelection
                ignoreStoredViewport
                onCleanup={terminal.update}
                onConnectError={() => terminal.clone(pty().id)}
              />
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
