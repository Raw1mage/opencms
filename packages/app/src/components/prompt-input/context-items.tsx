import { Component, For, Show } from "solid-js"
import { getDirectory, getFilename, getFilenameTruncated } from "@opencode-ai/util/path"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { usePrompt, type ContextItem } from "@/context/prompt"
import { useComments } from "@/context/comments"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useFile } from "@/context/file"
import { useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"

export const ContextItems: Component = () => {
  const prompt = usePrompt()
  const comments = useComments()
  const language = useLanguage()
  const layout = useLayout()
  const files = useFile()
  const params = useParams()
  const sync = useSync()

  const sessionKey = () => `${params.dir}${params.id ? "/" + params.id : ""}`
  const tabs = () => layout.tabs(sessionKey())

  const commentInReview = (path: string) => {
    const sessionID = params.id
    if (!sessionID) return false

    const diffs = sync.data.session_diff[sessionID]
    if (!diffs) return false
    return diffs.some((diff) => diff.file === path)
  }

  const openComment = (item: ContextItem) => {
    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    comments.setActive(focus)

    const wantsReview = item.commentOrigin === "review" || (item.commentOrigin !== "file" && commentInReview(item.path))
    if (wantsReview) {
      layout.fileTree.open()
      layout.fileTree.setTab("changes")
      requestAnimationFrame(() => comments.setFocus(focus))
      return
    }

    layout.fileTree.open()
    layout.fileTree.setTab("all")
    const tab = files.tab(item.path)
    tabs().open(tab)
    files.load(item.path)
    requestAnimationFrame(() => comments.setFocus(focus))
  }

  return (
    <Show when={prompt.context.items().length > 0}>
      <div class="flex flex-nowrap items-start gap-2 p-2 overflow-x-auto no-scrollbar">
        <For each={prompt.context.items()}>
          {(item) => {
            const active = () => {
              const a = comments.active()
              return !!item.commentID && item.commentID === a?.id && item.path === a?.file
            }
            return (
              <Tooltip
                value={
                  <span class="flex max-w-[300px]">
                    <span class="text-text-invert-base truncate-start [unicode-bidi:plaintext] min-w-0">
                      {getDirectory(item.path)}
                    </span>
                    <span class="shrink-0">{getFilename(item.path)}</span>
                  </span>
                }
                placement="top"
                openDelay={2000}
              >
                <div
                  classList={{
                    "group shrink-0 flex flex-col rounded-[6px] pl-2 pr-1 py-1 max-w-[200px] h-12 transition-all transition-transform shadow-xs-border hover:shadow-xs-border-hover": true,
                    "cursor-pointer hover:bg-surface-interactive-weak": !!item.commentID && !active(),
                    "cursor-pointer bg-surface-interactive-hover hover:bg-surface-interactive-hover shadow-xs-border-hover":
                      active(),
                    "bg-background-stronger": !active(),
                  }}
                  onClick={() => {
                    openComment(item)
                  }}
                >
                  <div class="flex items-center gap-1.5">
                    <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-3.5" />
                    <div class="flex items-center text-11-regular min-w-0 font-medium">
                      <span class="text-text-strong whitespace-nowrap">{getFilenameTruncated(item.path, 14)}</span>
                      <Show when={item.selection}>
                        {(sel) => (
                          <span class="text-text-weak whitespace-nowrap shrink-0">
                            {sel().startLine === sel().endLine
                              ? `:${sel().startLine}`
                              : `:${sel().startLine}-${sel().endLine}`}
                          </span>
                        )}
                      </Show>
                    </div>
                    <IconButton
                      type="button"
                      icon="close-small"
                      variant="ghost"
                      class="ml-auto h-5 w-5 opacity-0 group-hover:opacity-100 transition-all"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (item.commentID) comments.remove(item.path, item.commentID)
                        prompt.context.remove(item.key)
                      }}
                      aria-label={language.t("prompt.context.removeFile")}
                    />
                  </div>
                  <Show when={item.comment}>
                    {(comment) => (
                      <div class="text-12-regular text-text-strong ml-5 pr-1 truncate">{comment()}</div>
                    )}
                  </Show>
                </div>
              </Tooltip>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
