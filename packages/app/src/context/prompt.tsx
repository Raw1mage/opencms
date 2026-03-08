import { createStore, type SetStoreFunction } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createMemo, createRoot, onCleanup, createEffect } from "solid-js"
import { useParams } from "@solidjs/router"
import type { FileSelection } from "@/context/file"
import { useGlobalSync } from "./global-sync"
import { normalizeWorkspaceDirectory } from "./global-sync/workspace-adapter"
import { Persist, persisted } from "@/utils/persist"
import { checksum } from "@opencode-ai/util/encode"

interface PartBase {
  content: string
  start: number
  end: number
}

export interface TextPart extends PartBase {
  type: "text"
}

export interface FileAttachmentPart extends PartBase {
  type: "file"
  path: string
  selection?: FileSelection
}

export interface AgentPart extends PartBase {
  type: "agent"
  name: string
}

export interface ImageAttachmentPart {
  type: "image"
  id: string
  filename: string
  mime: string
  dataUrl: string
}

export type ContentPart = TextPart | FileAttachmentPart | AgentPart | ImageAttachmentPart
export type Prompt = ContentPart[]

export type FileContextItem = {
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export type ContextItem = FileContextItem

export const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

function isSelectionEqual(a?: FileSelection, b?: FileSelection) {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar
  )
}

function isPartEqual(partA: ContentPart, partB: ContentPart) {
  switch (partA.type) {
    case "text":
      return partB.type === "text" && partA.content === partB.content
    case "file":
      return partB.type === "file" && partA.path === partB.path && isSelectionEqual(partA.selection, partB.selection)
    case "agent":
      return partB.type === "agent" && partA.name === partB.name
    case "image":
      return partB.type === "image" && partA.id === partB.id
  }
}

export function isPromptEqual(promptA: Prompt, promptB: Prompt): boolean {
  if (promptA.length !== promptB.length) return false
  for (let i = 0; i < promptA.length; i++) {
    if (!isPartEqual(promptA[i], promptB[i])) return false
  }
  return true
}

function cloneSelection(selection?: FileSelection) {
  if (!selection) return undefined
  return { ...selection }
}

function clonePart(part: ContentPart): ContentPart {
  if (part.type === "text") return { ...part }
  if (part.type === "image") return { ...part }
  if (part.type === "agent") return { ...part }
  return {
    ...part,
    selection: cloneSelection(part.selection),
  }
}

function clonePrompt(prompt: Prompt): Prompt {
  return prompt.map(clonePart)
}

function contextItemKey(item: ContextItem) {
  if (item.type !== "file") return item.type
  const start = item.selection?.startLine
  const end = item.selection?.endLine
  const key = `${item.type}:${item.path}:${start}:${end}`

  if (item.commentID) {
    return `${key}:c=${item.commentID}`
  }

  const comment = item.comment?.trim()
  if (!comment) return key
  const digest = checksum(comment) ?? comment
  return `${key}:c=${digest.slice(0, 8)}`
}

function createPromptActions(
  setStore: SetStoreFunction<{
    prompt: Prompt
    cursor?: number
    context: {
      items: (ContextItem & { key: string })[]
    }
  }>,
) {
  return {
    set(prompt: Prompt, cursorPosition?: number) {
      const next = clonePrompt(prompt)
      batch(() => {
        setStore("prompt", next)
        if (cursorPosition !== undefined) setStore("cursor", cursorPosition)
      })
    },
    reset() {
      batch(() => {
        setStore("prompt", clonePrompt(DEFAULT_PROMPT))
        setStore("cursor", 0)
      })
    },
  }
}

const WORKSPACE_KEY = "__workspace__"
const MAX_PROMPT_SESSIONS = 20

export function getPromptWorkspaceDirectory(dir: string, workspaceDirectory?: string) {
  return normalizeWorkspaceDirectory(workspaceDirectory ?? dir)
}

export function getPromptSessionScopeDirectory(dir: string, id: string | undefined, workspaceDirectory?: string) {
  if (id) return normalizeWorkspaceDirectory(dir)
  return getPromptWorkspaceDirectory(dir, workspaceDirectory)
}

type PromptSession = ReturnType<typeof createPromptSession>

type PromptCacheEntry = {
  value: PromptSession
  dispose: VoidFunction
}

function createPromptSession(dir: string, id: string | undefined) {
  const legacyV2 = `${dir}/prompt${id ? "/" + id : ""}.v2`
  const oldConfig = Persist.scoped(dir, id, "prompt", [legacyV2])

  const [inputStore, setInputStore, _i, inputReady] = persisted(
    Persist.scoped(dir, id, "prompt-input", [oldConfig.key, ...(oldConfig.legacy || [])]),
    createStore<{
      prompt: Prompt
      cursor?: number
      context?: {
        items: (ContextItem & { key: string })[]
      }
    }>({
      prompt: clonePrompt(DEFAULT_PROMPT),
      cursor: undefined,
    }),
  )

  const [contextStore, setContextStore, _c, contextReady] = persisted(
    Persist.scoped(dir, id, "prompt-context"),
    createStore<{
      context: {
        items: (ContextItem & { key: string })[]
      }
    }>({
      context: {
        items: [],
      },
    }),
  )

  createEffect(() => {
    if (inputReady() && inputStore.context && contextReady()) {
      batch(() => {
        setContextStore("context", inputStore.context!)
        setInputStore("context", undefined)
      })
    }
  })

  return {
    ready: () => inputReady() && contextReady(),
    current: createMemo(() => inputStore.prompt),
    cursor: createMemo(() => inputStore.cursor),
    dirty: createMemo(() => !isPromptEqual(inputStore.prompt, DEFAULT_PROMPT)),
    context: {
      items: createMemo(() => contextStore.context.items),
      add(item: ContextItem) {
        const key = contextItemKey(item)
        if (contextStore.context.items.find((x) => x.key === key)) return
        setContextStore("context", "items", (items) => [...items, { key, ...item }])
      },
      remove(key: string) {
        setContextStore("context", "items", (items) => items.filter((x) => x.key !== key))
      },
    },
    set(prompt: Prompt, cursorPosition?: number) {
      const next = clonePrompt(prompt)
      batch(() => {
        setInputStore("prompt", next)
        if (cursorPosition !== undefined) setInputStore("cursor", cursorPosition)
      })
    },
    reset() {
      batch(() => {
        setInputStore("prompt", clonePrompt(DEFAULT_PROMPT))
        setInputStore("cursor", 0)
      })
    },
  }
}

export const { use: usePrompt, provider: PromptProvider } = createSimpleContext({
  name: "Prompt",
  gate: false,
  init: () => {
    const params = useParams()
    const globalSync = useGlobalSync()
    const cache = new Map<string, PromptCacheEntry>()

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_PROMPT_SESSIONS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const load = (dir: string, id: string | undefined) => {
      const [store] = globalSync.child(dir, { bootstrap: false })
      const scopeDir = getPromptSessionScopeDirectory(dir, id, store.workspace?.directory)
      const key = `${scopeDir}:${id ?? WORKSPACE_KEY}`
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      const entry = createRoot((dispose) => ({
        value: createPromptSession(scopeDir, id),
        dispose,
      }))

      cache.set(key, entry)
      prune()
      return entry.value
    }

    const session = createMemo(() => load(params.dir!, params.id))

    return {
      ready: () => session().ready(),
      current: () => session().current(),
      cursor: () => session().cursor(),
      dirty: () => session().dirty(),
      context: {
        items: () => session().context.items(),
        add: (item: ContextItem) => session().context.add(item),
        remove: (key: string) => session().context.remove(key),
      },
      set: (prompt: Prompt, cursorPosition?: number) => session().set(prompt, cursorPosition),
      reset: () => session().reset(),
    }
  },
})
