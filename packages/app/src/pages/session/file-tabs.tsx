import {
  type ValidComponent,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  Match,
  on,
  onCleanup,
  Show,
  Suspense,
  Switch,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { sampledChecksum } from "@opencode-ai/util/encode"
import { decode64 } from "@/utils/base64"
import { showToast } from "@opencode-ai/ui/toast"
import { Icon } from "@opencode-ai/ui/icon"
import { LineComment as LineCommentView, LineCommentEditor } from "@opencode-ai/ui/line-comment"
import { Mark } from "@opencode-ai/ui/logo"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useLayout } from "@/context/layout"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useComments } from "@/context/comments"
import { useLanguage } from "@/context/language"
import {
  collectMarkdownAssetRefs,
  isMarkdownPath,
  replaceMarkdownAssetRefs,
  resolveMarkdownAssetPath,
} from "./markdown-file-viewer"
import { RichMarkdownSurface } from "./rich-markdown-surface"

const formatCommentLabel = (range: SelectedLineRange) => {
  const start = Math.min(range.start, range.end)
  const end = Math.max(range.start, range.end)
  if (start === end) return `line ${start}`
  return `lines ${start}-${end}`
}

const LazySvgEditor = lazy(() => import("@/components/svg-editor").then((m) => ({ default: m.SvgEditor })))

function SvgViewer(props: {
  svgContent: () => string | undefined
  svgPreviewUrl: () => string | undefined
  path: () => string | undefined
  renderCode: (code: string, className: string) => any
  language: ReturnType<typeof useLanguage>
  onSaveContent?: (path: string, content: string) => void
}) {
  const [scale, setScale] = createSignal(1)
  const [showSource, setShowSource] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  const MIN_SCALE = 0.1
  const MAX_SCALE = 5

  const zoomIn = () => setScale((s) => Math.min(MAX_SCALE, s * 1.25))
  const zoomOut = () => setScale((s) => Math.max(MIN_SCALE, s / 1.25))
  const zoomReset = () => setScale(1)

  const handleWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    if (e.deltaY < 0) zoomIn()
    else zoomOut()
  }

  return (
    <div class="flex flex-col h-full">
      {/* Toolbar */}
      <div class="flex items-center gap-1 px-4 py-2 border-b border-border-base bg-surface-secondary shrink-0">
        <button
          class="px-2 py-1 text-12-medium text-text-dimmed hover:text-text-base hover:bg-surface-tertiary rounded transition-colors"
          onClick={zoomOut}
          title="Zoom Out"
        >
          -
        </button>
        <button
          class="px-2 py-1 text-12-medium text-text-dimmed hover:text-text-base hover:bg-surface-tertiary rounded transition-colors min-w-[3rem] text-center"
          onClick={zoomReset}
          title="Reset Zoom"
        >
          {Math.round(scale() * 100)}%
        </button>
        <button
          class="px-2 py-1 text-12-medium text-text-dimmed hover:text-text-base hover:bg-surface-tertiary rounded transition-colors"
          onClick={zoomIn}
          title="Zoom In"
        >
          +
        </button>
        <div class="w-px h-4 bg-border-base mx-1" />
        <button
          class="px-2 py-1 text-12-medium text-text-dimmed hover:text-text-base hover:bg-surface-tertiary rounded transition-colors"
          onClick={() => setShowSource((v) => !v)}
          title="Toggle Source"
        >
          {showSource() ? "Preview" : "Source"}
        </button>
        <div class="flex-1" />
        <Show when={!editing()}>
          <button
            class="px-2 py-1 text-12-medium text-text-dimmed hover:text-text-base hover:bg-surface-tertiary rounded transition-colors"
            onClick={() => setEditing(true)}
            title="Edit SVG"
          >
            Edit
          </button>
        </Show>
      </div>

      {/* Content: Editor or Preview */}
      <Show
        when={!editing()}
        fallback={
          <Show when={props.svgContent()}>
            {(content) => (
              <Suspense
                fallback={<div class="flex-1 flex items-center justify-center text-text-dimmed">Loading editor...</div>}
              >
                <LazySvgEditor
                  svgContent={content()}
                  filename={props.path()?.split("/").pop()}
                  onSave={(edited) => {
                    const p = props.path()
                    if (p && props.onSaveContent) {
                      props.onSaveContent(p, edited)
                    }
                    setEditing(false)
                  }}
                  onDiscard={() => setEditing(false)}
                />
              </Suspense>
            )}
          </Show>
        }
      >
        <Show
          when={!showSource()}
          fallback={
            <div class="flex-1 overflow-auto px-6 py-4 pb-40">{props.renderCode(props.svgContent() ?? "", "")}</div>
          }
        >
          <div class="flex-1 overflow-auto cursor-grab active:cursor-grabbing" onWheel={handleWheel}>
            <div class="flex justify-center items-start p-6 min-h-full" style={{ "padding-bottom": "10rem" }}>
              <Show when={props.svgPreviewUrl()}>
                <img
                  src={props.svgPreviewUrl()}
                  alt={props.path()}
                  class="select-none block"
                  style={{ width: `${scale() * 100}%`, "max-width": "none", height: "auto" }}
                  draggable={false}
                />
              </Show>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function MarkdownFileViewer(props: {
  path: () => string | undefined
  contents: () => string
  file: ReturnType<typeof useFile>
  renderSource: (source: string, wrapperClass: string) => any
}) {
  const [showSource, setShowSource] = createSignal(false)

  const assetRefs = createMemo(() => {
    const currentPath = props.path()
    if (!currentPath || !isMarkdownPath(currentPath)) return []
    return collectMarkdownAssetRefs(props.contents())
      .map((ref) => ({ ref, resolved: resolveMarkdownAssetPath(currentPath, ref) }))
      .filter((item): item is { ref: string; resolved: string } => Boolean(item.resolved))
      .filter((item) => item.resolved.toLowerCase().endsWith(".svg"))
  })

  createEffect(() => {
    for (const item of assetRefs()) {
      void props.file.load(item.resolved)
    }
  })

  const assetMap = createMemo(() => {
    const resolved: Record<string, string> = {}
    for (const item of assetRefs()) {
      const state = props.file.get(item.resolved)
      const content = state?.content
      if (!content) continue
      if (!item.resolved.toLowerCase().endsWith(".svg") && !content.mimeType?.toLowerCase().startsWith("image/svg+xml")) continue
      if (content.encoding === "base64") {
        resolved[item.ref] = `data:image/svg+xml;base64,${content.content}`
        continue
      }
      resolved[item.ref] = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content.content)}`
    }
    return resolved
  })

  const previewText = createMemo(() => replaceMarkdownAssetRefs(props.contents(), assetMap()))

  return (
    <div class="flex min-h-full flex-col">
      <div class="sticky top-0 z-10 flex items-center gap-1 border-b border-border-base bg-surface-secondary px-4 py-2">
        <button
          class="px-2 py-1 text-12-medium text-text-dimmed hover:text-text-base hover:bg-surface-tertiary rounded transition-colors"
          onClick={() => setShowSource(false)}
        >
          Preview
        </button>
        <button
          class="px-2 py-1 text-12-medium text-text-dimmed hover:text-text-base hover:bg-surface-tertiary rounded transition-colors"
          onClick={() => setShowSource(true)}
        >
          Source
        </button>
      </div>
      <Show when={!showSource()} fallback={<div class="pb-40">{props.renderSource(props.contents(), "")}</div>}>
        <div class="px-6 py-4 pb-40">
          <RichMarkdownSurface
            text={previewText()}
            cacheKey={props.path() ?? "markdown-file-preview"}
            mermaidNotice="inline"
            proseClass="prose prose-sm max-w-none"
          />
        </div>
      </Show>
    </div>
  )
}

export function FileTabContent(props: {
  tab: string
  activeTab: () => string
  tabs: () => ReturnType<ReturnType<typeof useLayout>["tabs"]>
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  handoffFiles: () => Record<string, SelectedLineRange | null> | undefined
  file: ReturnType<typeof useFile>
  comments: ReturnType<typeof useComments>
  language: ReturnType<typeof useLanguage>
  codeComponent: NonNullable<ValidComponent>
  addCommentToContext: (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => void
}) {
  let scroll: HTMLDivElement | undefined
  let scrollFrame: number | undefined
  let pending: { x: number; y: number } | undefined
  let codeScroll: HTMLElement[] = []

  const path = createMemo(() => props.file.pathFromTab(props.tab))
  const state = createMemo(() => {
    const p = path()
    if (!p) return
    return props.file.get(p)
  })
  const contents = createMemo(() => state()?.content?.content ?? "")
  const cacheKey = createMemo(() => sampledChecksum(contents()))
  const isImage = createMemo(() => {
    const c = state()?.content
    const mimeType = c?.mimeType?.toLowerCase() ?? ""
    return c?.encoding === "base64" && mimeType.startsWith("image/") && !mimeType.startsWith("image/svg+xml")
  })
  const isSvg = createMemo(() => {
    const p = path()?.toLowerCase() ?? ""
    const c = state()?.content
    const mimeType = c?.mimeType?.toLowerCase() ?? ""
    return p.endsWith(".svg") || mimeType.startsWith("image/svg+xml")
  })
  const isBinary = createMemo(() => state()?.content?.type === "binary")
  const isHtml = createMemo(() => path()?.endsWith(".html") || path()?.endsWith(".htm"))
  const isMarkdown = createMemo(() => isMarkdownPath(path()))
  const svgContent = createMemo(() => {
    if (!isSvg()) return
    const c = state()?.content
    if (!c) return
    if (c.encoding !== "base64") return c.content
    return decode64(c.content)
  })

  const svgDecodeFailed = createMemo(() => {
    if (!isSvg()) return false
    const c = state()?.content
    if (!c) return false
    if (c.encoding !== "base64") return false
    return svgContent() === undefined
  })

  const svgToast = { shown: false }
  createEffect(() => {
    if (!svgDecodeFailed()) return
    if (svgToast.shown) return
    svgToast.shown = true
    showToast({
      variant: "error",
      title: props.language.t("toast.file.loadFailed.title"),
    })
  })
  const svgPreviewUrl = createMemo(() => {
    if (!isSvg()) return
    const c = state()?.content
    if (!c) return
    if (c.encoding === "base64") return `data:image/svg+xml;base64,${c.content}`
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(c.content)}`
  })
  const imageDataUrl = createMemo(() => {
    if (!isImage()) return
    const c = state()?.content
    return `data:${c?.mimeType};base64,${c?.content}`
  })
  const selectedLines = createMemo(() => {
    const p = path()
    if (!p) return null
    if (props.file.ready()) return props.file.selectedLines(p) ?? null
    return props.handoffFiles()?.[p] ?? null
  })

  let wrap: HTMLDivElement | undefined

  const fileComments = createMemo(() => {
    const p = path()
    if (!p) return []
    return props.comments.list(p)
  })

  const commentLayout = createMemo(() => {
    return fileComments()
      .map((comment) => `${comment.id}:${comment.selection.start}:${comment.selection.end}`)
      .join("|")
  })

  const commentedLines = createMemo(() => fileComments().map((comment) => comment.selection))

  const [note, setNote] = createStore({
    openedComment: null as string | null,
    commenting: null as SelectedLineRange | null,
    draft: "",
    positions: {} as Record<string, number>,
    draftTop: undefined as number | undefined,
  })

  const getRoot = () => {
    const el = wrap
    if (!el) return

    const host = el.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return

    const root = host.shadowRoot
    if (!root) return

    return root
  }

  const findMarker = (root: ShadowRoot, range: SelectedLineRange) => {
    const line = Math.max(range.start, range.end)
    const node = root.querySelector(`[data-line="${line}"]`)
    if (!(node instanceof HTMLElement)) return
    return node
  }

  const markerTop = (wrapper: HTMLElement, marker: HTMLElement) => {
    const wrapperRect = wrapper.getBoundingClientRect()
    const rect = marker.getBoundingClientRect()
    return rect.top - wrapperRect.top + Math.max(0, (rect.height - 20) / 2)
  }

  const updateComments = () => {
    const el = wrap
    const root = getRoot()
    if (!el || !root) {
      setNote("positions", {})
      setNote("draftTop", undefined)
      return
    }

    const estimateTop = (range: SelectedLineRange) => {
      const line = Math.max(range.start, range.end)
      const height = 24
      const offset = 2
      return Math.max(0, (line - 1) * height + offset)
    }

    const large = contents().length > 500_000

    const next: Record<string, number> = {}
    for (const comment of fileComments()) {
      const marker = findMarker(root, comment.selection)
      if (marker) next[comment.id] = markerTop(el, marker)
      else if (large) next[comment.id] = estimateTop(comment.selection)
    }

    const removed = Object.keys(note.positions).filter((id) => next[id] === undefined)
    const changed = Object.entries(next).filter(([id, top]) => note.positions[id] !== top)
    if (removed.length > 0 || changed.length > 0) {
      setNote(
        "positions",
        produce((draft) => {
          for (const id of removed) {
            delete draft[id]
          }

          for (const [id, top] of changed) {
            draft[id] = top
          }
        }),
      )
    }

    const range = note.commenting
    if (!range) {
      setNote("draftTop", undefined)
      return
    }

    const marker = findMarker(root, range)
    if (marker) {
      setNote("draftTop", markerTop(el, marker))
      return
    }

    setNote("draftTop", large ? estimateTop(range) : undefined)
  }

  const scheduleComments = () => {
    requestAnimationFrame(updateComments)
  }

  createEffect(() => {
    commentLayout()
    scheduleComments()
  })

  createEffect(() => {
    const range = note.commenting
    scheduleComments()
    if (!range) return
    setNote("draft", "")
  })

  createEffect(() => {
    const focus = props.comments.focus()
    const p = path()
    if (!focus || !p) return
    if (focus.file !== p) return
    if (props.activeTab() !== props.tab) return

    const target = fileComments().find((comment) => comment.id === focus.id)
    if (!target) return

    setNote("openedComment", target.id)
    setNote("commenting", null)
    props.file.setSelectedLines(p, target.selection)
    requestAnimationFrame(() => props.comments.clearFocus())
  })

  const getCodeScroll = () => {
    const el = scroll
    if (!el) return []

    const host = el.querySelector("diffs-container")
    if (!(host instanceof HTMLElement)) return []

    const root = host.shadowRoot
    if (!root) return []

    return Array.from(root.querySelectorAll("[data-code]")).filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node.clientWidth > 0,
    )
  }

  const queueScrollUpdate = (next: { x: number; y: number }) => {
    pending = next
    if (scrollFrame !== undefined) return

    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined

      const out = pending
      pending = undefined
      if (!out) return

      props.view().setScroll(props.tab, out)
    })
  }

  const handleCodeScroll = (event: Event) => {
    const el = scroll
    if (!el) return

    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return

    queueScrollUpdate({
      x: target.scrollLeft,
      y: el.scrollTop,
    })
  }

  const syncCodeScroll = () => {
    const next = getCodeScroll()
    if (next.length === codeScroll.length && next.every((el, i) => el === codeScroll[i])) return

    for (const item of codeScroll) {
      item.removeEventListener("scroll", handleCodeScroll)
    }

    codeScroll = next

    for (const item of codeScroll) {
      item.addEventListener("scroll", handleCodeScroll)
    }
  }

  const restoreScroll = () => {
    const el = scroll
    if (!el) return

    const s = props.view()?.scroll(props.tab)
    if (!s) return

    syncCodeScroll()

    if (codeScroll.length > 0) {
      for (const item of codeScroll) {
        if (item.scrollLeft !== s.x) item.scrollLeft = s.x
      }
    }

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (codeScroll.length > 0) return
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (codeScroll.length === 0) syncCodeScroll()

    queueScrollUpdate({
      x: codeScroll[0]?.scrollLeft ?? event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    })
  }

  createEffect(
    on(
      () => state()?.loaded,
      (loaded) => {
        if (!loaded) return
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => props.file.ready(),
      (ready) => {
        if (!ready) return
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => props.tabs().active() === props.tab,
      (active) => {
        if (!active) return
        if (!state()?.loaded) return
        requestAnimationFrame(restoreScroll)
      },
    ),
  )

  onCleanup(() => {
    for (const item of codeScroll) {
      item.removeEventListener("scroll", handleCodeScroll)
    }

    if (scrollFrame === undefined) return
    cancelAnimationFrame(scrollFrame)
  })

  const cancelCommenting = () => {
    const p = path()
    if (p) props.file.setSelectedLines(p, null)
    setNote("commenting", null)
  }

  const renderCode = (source: string, wrapperClass: string) => (
    <div
      ref={(el) => {
        wrap = el
        scheduleComments()
      }}
      class={`relative min-h-max ${wrapperClass}`}
    >
      <Dynamic
        component={props.codeComponent}
        file={{
          name: path() ?? "",
          contents: source,
          cacheKey: cacheKey(),
        }}
        enableLineSelection
        selectedLines={selectedLines()}
        commentedLines={commentedLines()}
        onRendered={() => {
          requestAnimationFrame(restoreScroll)
          requestAnimationFrame(scheduleComments)
        }}
        onLineSelected={(range: SelectedLineRange | null) => {
          const p = path()
          if (!p) return
          props.file.setSelectedLines(p, range)
          if (!range) setNote("commenting", null)
        }}
        onLineSelectionEnd={(range: SelectedLineRange | null) => {
          if (!range) {
            setNote("commenting", null)
            return
          }

          setNote("openedComment", null)
          setNote("commenting", range)
        }}
        overflow="scroll"
        class="select-text"
      />
      <For each={fileComments()}>
        {(comment) => (
          <LineCommentView
            id={comment.id}
            top={note.positions[comment.id]}
            open={note.openedComment === comment.id}
            comment={comment.comment}
            selection={formatCommentLabel(comment.selection)}
            onMouseEnter={() => {
              const p = path()
              if (!p) return
              props.file.setSelectedLines(p, comment.selection)
            }}
            onClick={() => {
              const p = path()
              if (!p) return
              setNote("commenting", null)
              setNote("openedComment", (current) => (current === comment.id ? null : comment.id))
              props.file.setSelectedLines(p, comment.selection)
            }}
          />
        )}
      </For>
      <Show when={note.commenting}>
        {(range) => (
          <Show when={note.draftTop !== undefined}>
            <LineCommentEditor
              top={note.draftTop}
              value={note.draft}
              selection={formatCommentLabel(range())}
              onInput={(value) => setNote("draft", value)}
              onCancel={cancelCommenting}
              onSubmit={(value) => {
                const p = path()
                if (!p) return
                props.addCommentToContext({
                  file: p,
                  selection: range(),
                  comment: value,
                  origin: "file",
                })
                setNote("commenting", null)
              }}
              onPopoverFocusOut={(e: FocusEvent) => {
                const current = e.currentTarget as HTMLDivElement
                const target = e.relatedTarget
                if (target instanceof Node && current.contains(target)) return

                setTimeout(() => {
                  if (!document.activeElement || !current.contains(document.activeElement)) {
                    cancelCommenting()
                  }
                }, 0)
              }}
            />
          </Show>
        )}
      </Show>
    </div>
  )

  return (
    <Tabs.Content
      value={props.tab}
      class="file-tab-content-scroll mt-3 relative flex-1 min-h-0 overflow-y-scroll overflow-x-auto"
      ref={(el: HTMLDivElement) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="min-h-max">
        <Switch>
          <Match when={state()?.loaded && isImage()}>
            <div class="px-6 py-4 pb-40">
              <img
                src={imageDataUrl()}
                alt={path()}
                class="max-w-full"
                onLoad={() => requestAnimationFrame(restoreScroll)}
              />
            </div>
          </Match>
          <Match when={state()?.loaded && isSvg()}>
            <SvgViewer
              svgContent={svgContent}
              svgPreviewUrl={svgPreviewUrl}
              path={path}
              renderCode={renderCode}
              language={props.language}
              onSaveContent={undefined}
            />
          </Match>
          <Match when={state()?.loaded && isHtml()}>
            <iframe
              sandbox="allow-same-origin"
              srcdoc={contents()}
              class="w-full border-0"
              style={{ height: "calc(100vh - 120px)" }}
              title={path()?.split("/").pop() ?? "HTML"}
            />
          </Match>
          <Match when={state()?.loaded && isBinary()}>
            <div class="h-full px-6 pb-42 flex flex-col items-center justify-center text-center gap-6">
              <Mark class="w-14 opacity-10" />
              <div class="flex flex-col gap-2 max-w-md">
                <div class="text-14-semibold text-text-strong truncate">{path()?.split("/").pop()}</div>
                <div class="text-14-regular text-text-weak">{props.language.t("session.files.binaryContent")}</div>
              </div>
            </div>
          </Match>
          <Match when={state()?.loaded && isMarkdown()}>
            <MarkdownFileViewer path={path} contents={contents} file={props.file} renderSource={renderCode} />
          </Match>
          <Match when={state()?.loaded}>{renderCode(contents(), "pb-40")}</Match>
          <Match when={state()?.loading}>
            <div class="px-6 py-4 text-text-weak">{props.language.t("common.loading")}...</div>
          </Match>
          <Match when={state()?.error}>{(err) => <div class="px-6 py-4 text-text-weak">{err()}</div>}</Match>
        </Switch>
      </div>
    </Tabs.Content>
  )
}
