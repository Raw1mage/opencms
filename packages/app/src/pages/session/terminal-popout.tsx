import { Show, createEffect, createMemo, createResource } from "solid-js"
import { useParams, useSearchParams } from "@solidjs/router"
import { Terminal } from "@/components/terminal"
import { useLanguage } from "@/context/language"
import { useTerminal } from "@/context/terminal"
import { useSDK } from "@/context/sdk"
import { terminalTabLabel } from "@/pages/session/terminal-label"

export default function TerminalPopoutRoute() {
  const language = useLanguage()
  const terminal = useTerminal()
  const sdk = useSDK()
  const params = useParams<{ dir?: string; id?: string }>()
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

  const [session] = createResource(
    () => params.id,
    async (id) => {
      if (!id) return
      const result = await sdk.client.session
        .get({ sessionID: id })
        .then((x) => x.data)
        .catch(() => undefined)
      return result
    },
  )

  const sessionTitle = createMemo(() => {
    const title = session.latest?.title?.trim()
    if (title) return title
    return language.t("command.session.new")
  })

  createEffect(() => {
    if (!terminal.ready()) return
    if (terminal.all().length > 0) return
    terminal.new()
  })

  createEffect(() => {
    const id = selectedID()
    if (!id) return
    if (terminal.active() !== id) terminal.open(id)
    document.title = `${sessionTitle()} · ${language.t("terminal.title")}`
  })

  // Phase 5.4: terminal pop-out window must NOT render the app sidebar or
  // global SessionHeader. Replace the header with a minimal terminal-only
  // title bar showing the session title + popped terminal label.
  const popoutTitle = createMemo(() => {
    const pty = selectedPTY()
    if (!pty) return sessionTitle()
    const label = terminalTabLabel({
      title: pty.title,
      titleNumber: pty.titleNumber,
      t: language.t as (key: string, vars?: Record<string, string | number | boolean>) => string,
    })
    return `${sessionTitle()} · ${label}`
  })

  return (
    <div class="min-h-screen w-full flex flex-col bg-background-base">
      <div
        role="banner"
        class="h-8 flex items-center gap-2 px-3 border-b border-border-weak-base bg-background-stronger select-none"
        data-slot="terminal-popout-titlebar"
      >
        <span class="text-12-medium text-text-base truncate flex-1 min-w-0">{popoutTitle()}</span>
        <button
          type="button"
          class="text-12-regular text-text-weak hover:text-text-base"
          onClick={() => window.close()}
          aria-label={language.t("common.close") ?? "Close"}
        >
          ×
        </button>
      </div>
      <div class="flex-1 min-h-0 relative">
        <Show
          when={selectedPTY()}
          keyed
          fallback={
            <div class="size-full flex items-center justify-center text-text-weak">
              {language.t("terminal.loading")}
            </div>
          }
        >
          {(pty) => (
            <div class="absolute inset-0">
              <Terminal
                pty={pty}
                class="!px-0 !py-0"
                contextMenuCopiesSelection
                ignoreStoredViewport
                clearSelectionOnInput
                onCleanup={terminal.update}
                onConnectError={() => terminal.clone(pty.id)}
              />
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
