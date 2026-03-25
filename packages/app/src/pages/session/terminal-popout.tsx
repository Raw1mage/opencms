import { Show, createEffect, createMemo, createResource } from "solid-js"
import { useParams, useSearchParams } from "@solidjs/router"
import { SessionHeader } from "@/components/session"
import { Terminal } from "@/components/terminal"
import { useLanguage } from "@/context/language"
import { useTerminal } from "@/context/terminal"
import { useSDK } from "@/context/sdk"

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

  return (
    <div class="min-h-screen w-full flex flex-col bg-background-base">
      <SessionHeader />
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
