import { Show, createEffect, createMemo, createResource } from "solid-js"
import { useParams } from "@solidjs/router"
import FileTree from "@/components/file-tree"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

/**
 * Phase 5.2 — File Explorer pop-out window.
 *
 * Renders the FileTree as a focused independent surface, mirroring the
 * terminal pop-out chrome contract from Phase 5.4: no app sidebar, no
 * global SessionHeader, just a minimal title bar + the tree.
 *
 * V1 caveat: double-click in the popped window does NOT open the file in
 * the main window (cross-window file-tab orchestration is deferred to a
 * later iteration). Single-row mutations via right-click context menu
 * (create / rename / delete / restore / upload / download / cut / copy /
 * paste) all work — they go through the same SDK + applyOperationResult
 * pipeline as the embedded tree.
 */
export default function FileExplorerPopoutRoute() {
  const language = useLanguage()
  const sdk = useSDK()
  const params = useParams<{ dir?: string; id?: string }>()

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
    document.title = `${sessionTitle()} · Files`
  })

  // Cross-window file open: when the user double-clicks a file in the popped
  // explorer, dispatch the same `opencode:open-file` CustomEvent the mother
  // window already listens for in session.tsx (line ~1909). Mother window
  // calls openTab(...) and shows the file in its file pane. If the mother
  // window has been closed, fall back silently — the popped explorer stays
  // usable for mutation actions (create / rename / delete / upload / etc.).
  const requestOpenInMother = (path: string) => {
    const opener = window.opener as Window | null
    if (!opener || opener.closed) return
    try {
      opener.dispatchEvent(new CustomEvent("opencode:open-file", { detail: { path } }))
      opener.focus()
    } catch {
      // cross-origin restriction or torn-down opener — silently no-op.
    }
  }

  return (
    <div class="min-h-screen w-full flex flex-col bg-slate-900 text-slate-100">
      <div
        role="banner"
        class="h-8 flex items-center gap-2 px-3 border-b border-slate-700 bg-slate-800 select-none"
        data-slot="file-explorer-popout-titlebar"
      >
        <span class="text-12-medium text-text-base truncate flex-1 min-w-0">{sessionTitle()} · Files</span>
        <button
          type="button"
          class="text-12-regular text-text-weak hover:text-text-base"
          onClick={() => window.close()}
          aria-label={language.t("common.close") ?? "Close"}
        >
          ×
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-auto px-3 py-2">
        <Show
          when={sdk.directory}
          fallback={
            <div class="size-full flex items-center justify-center text-text-weak">
              {language.t("common.loading") ?? "Loading"}
            </div>
          }
        >
          <FileTree
            path=""
            modified={[]}
            kinds={new Map()}
            showHeader
            onFileClick={(node) => requestOpenInMother(node.path)}
          />
        </Show>
      </div>
    </div>
  )
}
