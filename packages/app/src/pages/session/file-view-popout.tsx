import { Show, createEffect, createMemo, createResource } from "solid-js"
import { useParams, useSearchParams } from "@solidjs/router"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

/**
 * Phase 5.3 — File-view tab pop-out window.
 *
 * Opens a focused viewer for a single project-relative file path passed
 * via the `?path=` query param. Same chrome contract as terminal /
 * file-explorer pop-outs (Phase 5.2 / 5.4): no app sidebar, no global
 * SessionHeader; just a minimal title bar showing the session title +
 * filename + close × button.
 *
 * V1 viewer scope: text / code / SVG / image / binary placeholder. PDF /
 * HTML iframe rendering and the rich Markdown viewer used by the embedded
 * file-tab body live inside FileTabContent, which has many session-bound
 * dependencies; reusing it from here is deferred to a polish iteration.
 * The popped viewer falls back to "Open in main view" guidance for those
 * cases so the user can finish reading from the docked tab.
 */
export default function FileViewPopoutRoute() {
  const language = useLanguage()
  const sdk = useSDK()
  const file = useFile()
  const params = useParams<{ dir?: string; id?: string }>()
  const [searchParams] = useSearchParams<{ path?: string }>()

  const targetPath = createMemo(() => {
    const raw = searchParams.path
    if (!raw) return undefined
    return file.normalize(raw)
  })

  const [session] = createResource(
    () => params.id,
    async (id) => {
      if (!id) return
      return sdk.client.session
        .get({ sessionID: id })
        .then((x) => x.data)
        .catch(() => undefined)
    },
  )

  const sessionTitle = createMemo(() => session.latest?.title?.trim() || language.t("command.session.new"))

  createEffect(() => {
    const p = targetPath()
    if (!p) return
    void file.load(p)
  })

  createEffect(() => {
    const p = targetPath()
    document.title = p ? `${p.split("/").pop()} · ${sessionTitle()}` : sessionTitle()
  })

  const state = createMemo(() => {
    const p = targetPath()
    if (!p) return undefined
    return file.get(p)
  })

  const content = createMemo(() => state()?.content)

  const filename = createMemo(() => targetPath()?.split("/").pop() ?? "")

  const isImage = createMemo(() => {
    const c = content()
    return c?.mimeType?.startsWith("image/") ?? false
  })

  const isSvg = createMemo(() => {
    const c = content()
    if (!c) return false
    if (c.mimeType === "image/svg+xml") return true
    return targetPath()?.toLowerCase().endsWith(".svg") ?? false
  })

  const isBinary = createMemo(() => content()?.type === "binary" && !isImage())

  const imageDataUrl = createMemo(() => {
    const c = content()
    if (!c || !isImage() || isSvg()) return undefined
    if (c.encoding === "base64") return `data:${c.mimeType ?? "image/png"};base64,${c.content}`
    return undefined
  })

  return (
    <div class="min-h-screen w-full flex flex-col bg-slate-900 text-slate-100">
      <div
        role="banner"
        class="h-8 flex items-center gap-2 px-3 border-b border-slate-700 bg-slate-800 select-none"
        data-slot="file-view-popout-titlebar"
      >
        <span class="text-12-medium text-text-base truncate flex-1 min-w-0">
          {filename() || "(no file)"} · {sessionTitle()}
        </span>
        <button
          type="button"
          class="text-12-regular text-text-weak hover:text-text-base"
          onClick={() => window.close()}
          aria-label={language.t("common.close") ?? "Close"}
        >
          ×
        </button>
      </div>
      <div class="flex-1 min-h-0 overflow-auto">
        <Show
          when={targetPath()}
          fallback={
            <div class="size-full flex items-center justify-center text-text-weak">No file path provided.</div>
          }
        >
          <Show
            when={state()?.loaded}
            fallback={
              <Show
                when={state()?.error}
                fallback={
                  <div class="size-full flex items-center justify-center text-text-weak">
                    {language.t("common.loading") ?? "Loading"}
                  </div>
                }
              >
                {(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}
              </Show>
            }
          >
            <Show
              when={isSvg() && content()}
              fallback={
                <Show
                  when={isImage() && imageDataUrl()}
                  fallback={
                    <Show
                      when={isBinary()}
                      fallback={
                        <pre class="px-4 py-3 text-12-regular whitespace-pre-wrap break-words text-text-base">
                          {content()?.content}
                        </pre>
                      }
                    >
                      <div class="size-full flex flex-col items-center justify-center gap-3 text-text-weak px-6 text-center">
                        <div class="text-14-semibold text-text-strong">{filename()}</div>
                        <div class="text-12-regular">
                          Binary file. Download via the right-click menu in the docked tab.
                        </div>
                      </div>
                    </Show>
                  }
                >
                  {(url) => <img src={url()} alt={filename()} class="max-w-full mx-auto block px-4 py-3" />}
                </Show>
              }
            >
              <div class="px-4 py-3" innerHTML={content()?.content ?? ""} />
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}
