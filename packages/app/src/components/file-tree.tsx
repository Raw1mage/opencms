import { useFile } from "@/context/file"
import { useSDK } from "@/context/sdk"
import { encodeFilePath } from "@/context/file/path"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import type { FileOperationResult } from "@opencode-ai/sdk/v2"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  Show,
  splitProps,
  Switch,
  untrack,
  type Accessor,
  type ComponentProps,
  type JSX,
  type ParentProps,
  type Setter,
} from "solid-js"
import { Dynamic, Portal } from "solid-js/web"
import type { FileNode } from "@opencode-ai/sdk/v2"
import {
  applyCheckboxToggle,
  applyRowClick,
  applySelectAllToggle,
  emptySelection,
  type SelectionState,
} from "./file-tree-selection"

const MAX_DEPTH = 128

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatModifiedShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ""
  const d = new Date(ms)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  const hh = String(d.getHours()).padStart(2, "0")
  const mi = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`
}

function pathToFileUrl(filepath: string): string {
  return `file://${encodeFilePath(filepath)}`
}

type Kind = "add" | "del" | "mix"

type Filter = {
  files: Set<string>
  dirs: Set<string>
}

export type FileTreeContextMenuTarget =
  | {
      kind: "row"
      node: FileNode
      path: string
      nodeType: FileNode["type"]
      parentPath: string
    }
  | {
      kind: "folder"
      path: string
      node?: FileNode
      parentPath: string
    }

export type FileTreeContextSelectionItem = {
  path: string
  type: FileNode["type"]
}

export type FileTreeClipboardEntry = {
  path: string
  type: FileNode["type"]
}

export type ClipboardState = { mode: "copy" | "cut"; entries: readonly FileTreeClipboardEntry[] } | null

export type FileTreeContextMenuActionId =
  | "open"
  | "create-file"
  | "create-folder"
  | "rename"
  | "copy"
  | "cut"
  | "paste"
  | "paste-external"
  | "delete"
  | "restore"
  | "upload"
  | "download"

export type FileTreeContextMenuAction = {
  id: FileTreeContextMenuActionId
  label: string
  enabled: boolean
  reason?: string
}

export type FileTreeContextMenuActionGroup = {
  id: "open" | "new" | "clipboard" | "organize" | "transfer"
  label: string
  actions: FileTreeContextMenuAction[]
}

const parentPath = (path: string) => {
  const idx = path.lastIndexOf("/")
  if (idx === -1) return ""
  return path.slice(0, idx)
}

const isRecyclebinPath = (path: string) => path === "recyclebin" || path.startsWith("recyclebin/")

export function fileTreeRowContextMenuTarget(node: FileNode): FileTreeContextMenuTarget {
  return {
    kind: "row",
    node,
    path: node.path,
    nodeType: node.type,
    parentPath: parentPath(node.path),
  }
}

export function fileTreeFolderContextMenuTarget(path: string, node?: FileNode): FileTreeContextMenuTarget {
  const target: FileTreeContextMenuTarget = {
    kind: "folder",
    path,
    parentPath: parentPath(path),
  }
  if (node) target.node = node
  return target
}

export function fileTreeContextMenuActionGroups(input: {
  target: FileTreeContextMenuTarget
  selection?: readonly FileTreeContextSelectionItem[]
  hasPendingClipboard?: boolean
}): FileTreeContextMenuActionGroup[] {
  const selected = input.selection ?? []
  const targetSelected = input.target.kind === "row" && selected.some((item) => item.path === input.target.path)
  const selectedItems = targetSelected ? selected : []
  const selectionCount = selectedItems.length
  const effectiveCount = selectionCount || (input.target.kind === "row" ? 1 : 0)
  const singleRow = input.target.kind === "row" && selectionCount <= 1
  const folderDestination =
    input.target.kind === "folder" || (input.target.kind === "row" && input.target.nodeType === "directory")
  const fileRow = input.target.kind === "row" && input.target.nodeType === "file"
  const restoreCandidate = input.target.kind === "row" && isRecyclebinPath(input.target.path)

  return [
    {
      id: "open",
      label: "Open",
      actions: [
        {
          id: "open",
          label: fileRow ? "Open file" : "Open folder",
          enabled: input.target.kind === "row" && selectionCount <= 1,
          reason:
            input.target.kind === "folder"
              ? "Choose a file or folder row to open."
              : "Open supports one item at a time.",
        },
      ],
    },
    {
      id: "new",
      label: "New",
      actions: [
        { id: "create-file", label: "New file", enabled: folderDestination, reason: "Choose a destination folder." },
        {
          id: "create-folder",
          label: "New folder",
          enabled: folderDestination,
          reason: "Choose a destination folder.",
        },
        { id: "upload", label: "Upload files", enabled: folderDestination, reason: "Choose a destination folder." },
      ],
    },
    {
      id: "clipboard",
      label: "Clipboard",
      actions: [
        {
          id: "copy",
          label: selectionCount > 1 ? `Copy ${selectionCount} items` : "Copy",
          enabled: effectiveCount > 0,
        },
        { id: "cut", label: selectionCount > 1 ? `Cut ${selectionCount} items` : "Cut", enabled: effectiveCount > 0 },
        {
          id: "paste",
          label: "Paste here",
          enabled: folderDestination && !!input.hasPendingClipboard,
          reason: !folderDestination ? "Choose a destination folder." : "No copied or cut items are pending.",
        },
        {
          id: "paste-external",
          label: "Paste to writable destination…",
          enabled: !!input.hasPendingClipboard,
          reason: "No copied or cut items are pending.",
        },
      ],
    },
    {
      id: "organize",
      label: "Organize",
      actions: [
        { id: "rename", label: "Rename", enabled: singleRow, reason: "Rename supports one row at a time." },
        {
          id: "delete",
          label: effectiveCount > 1 ? `Delete ${effectiveCount} items` : "Delete",
          enabled: effectiveCount > 0,
        },
        {
          id: "restore",
          label: "Restore from recyclebin",
          enabled: restoreCandidate,
          reason: "Only recyclebin items can be restored.",
        },
      ],
    },
    {
      id: "transfer",
      label: "Transfer",
      actions: [
        {
          id: "download",
          label: "Download",
          enabled: fileRow && selectionCount <= 1,
          reason: fileRow ? "Download supports one file at a time." : "Directory download is not supported.",
        },
      ],
    },
  ]
}

export function shouldListRoot(input: { level: number; dir?: { loaded?: boolean; loading?: boolean } }) {
  if (input.level !== 0) return false
  if (input.dir?.loaded) return false
  if (input.dir?.loading) return false
  return true
}

export function shouldListExpanded(input: {
  level: number
  dir?: { expanded?: boolean; loaded?: boolean; loading?: boolean }
}) {
  if (input.level === 0) return false
  if (!input.dir?.expanded) return false
  if (input.dir.loaded) return false
  if (input.dir.loading) return false
  return true
}

export function dirsToExpand(input: {
  level: number
  filter?: { dirs: Set<string> }
  expanded: (dir: string) => boolean
}) {
  if (input.level !== 0) return []
  if (!input.filter) return []
  return [...input.filter.dirs].filter((dir) => !input.expanded(dir))
}

const kindLabel = (kind: Kind) => {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
}

const kindTextColor = (kind: Kind) => {
  if (kind === "add") return "color: var(--icon-diff-add-base)"
  if (kind === "del") return "color: var(--icon-diff-delete-base)"
  return "color: var(--icon-warning-active)"
}

const kindDotColor = (kind: Kind) => {
  if (kind === "add") return "background-color: var(--icon-diff-add-base)"
  if (kind === "del") return "background-color: var(--icon-diff-delete-base)"
  return "background-color: var(--icon-warning-active)"
}

const visibleKind = (node: FileNode, kinds?: ReadonlyMap<string, Kind>, marks?: Set<string>) => {
  const kind = kinds?.get(node.path)
  if (!kind) return
  if (!marks?.has(node.path)) return
  return kind
}

const buildDragImage = (target: HTMLElement) => {
  const icon = target.querySelector('[data-component="file-icon"]') ?? target.querySelector("svg")
  const text = target.querySelector("span")
  if (!icon || !text) return

  const image = document.createElement("div")
  image.className =
    "flex items-center gap-x-2 px-2 py-1 bg-surface-raised-base rounded-md border border-border-base text-12-regular text-text-strong"
  image.style.position = "absolute"
  image.style.top = "-1000px"
  image.innerHTML = (icon as SVGElement).outerHTML + (text as HTMLSpanElement).outerHTML
  return image
}

const withFileDragImage = (event: DragEvent) => {
  const image = buildDragImage(event.currentTarget as HTMLElement)
  if (!image) return
  document.body.appendChild(image)
  event.dataTransfer?.setDragImage(image, 0, 12)
  setTimeout(() => document.body.removeChild(image), 0)
}

const FileTreeNode = (
  p: ParentProps &
    ComponentProps<"div"> &
    ComponentProps<"button"> & {
      node: FileNode
      level: number
      active?: string
      selected?: boolean
      cut?: boolean
      nodeClass?: string
      draggable: boolean
      kinds?: ReadonlyMap<string, Kind>
      marks?: Set<string>
      as?: "div" | "button"
      leading?: JSX.Element
      trailing?: JSX.Element
    },
) => {
  const [local, rest] = splitProps(p, [
    "node",
    "level",
    "active",
    "selected",
    "cut",
    "nodeClass",
    "draggable",
    "kinds",
    "marks",
    "as",
    "leading",
    "trailing",
    "children",
    "class",
    "classList",
  ])
  const kind = () => visibleKind(local.node, local.kinds, local.marks)
  const active = () => !!kind() && !local.node.ignored
  const color = () => {
    const value = kind()
    if (!value) return
    return kindTextColor(value)
  }

  return (
    <Dynamic
      component={local.as ?? "div"}
      classList={{
        "w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-left hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors cursor-pointer": true,
        "bg-surface-base-active": local.node.path === local.active,
        "bg-surface-raised-base-hover": !!local.selected && local.node.path !== local.active,
        "opacity-60": !!local.cut,
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
        [local.nodeClass ?? ""]: !!local.nodeClass,
      }}
      data-filetree-row="true"
      data-filetree-selected={local.selected ? "true" : undefined}
      data-filetree-cut={local.cut ? "true" : undefined}
      style={`padding-left: ${Math.max(0, 8 + local.level * 12 - (local.node.type === "file" ? 24 : 4))}px`}
      draggable={local.draggable}
      onDragStart={(event: DragEvent) => {
        if (!local.draggable) return
        event.dataTransfer?.setData("text/plain", `file:${local.node.path}`)
        event.dataTransfer?.setData("text/uri-list", pathToFileUrl(local.node.path))
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy"
        withFileDragImage(event)
      }}
      {...rest}
    >
      {local.leading}
      {local.children}
      <span
        classList={{
          "flex-1 min-w-0 text-12-medium whitespace-nowrap truncate": true,
          "text-text-weak": local.node.ignored,
          "text-text-base": !local.node.ignored && !active(),
        }}
        style={active() ? color() : undefined}
      >
        {local.node.name}
      </span>
      {(() => {
        const value = kind()
        if (!value) return null
        if (local.node.type === "file") {
          return (
            <span class="shrink-0 w-4 text-center text-12-medium" style={kindTextColor(value)}>
              {kindLabel(value)}
            </span>
          )
        }
        return <div class="shrink-0 size-1.5 mr-1.5 rounded-full" style={kindDotColor(value)} />
      })()}
      {local.trailing}
    </Dynamic>
  )
}

export default function FileTree(props: {
  path: string
  class?: string
  nodeClass?: string
  active?: string
  level?: number
  allowed?: readonly string[]
  modified?: readonly string[]
  kinds?: ReadonlyMap<string, Kind>
  draggable?: boolean
  onFileClick?: (file: FileNode) => void
  onContextMenuTarget?: (target: FileTreeContextMenuTarget) => void
  contextSelection?: readonly FileTreeContextSelectionItem[]
  hasPendingClipboard?: boolean
  contextMenu?: (target: FileTreeContextMenuTarget) => JSX.Element
  showHeader?: boolean

  _filter?: Filter
  _marks?: Set<string>
  _deeps?: Map<string, number>
  _kinds?: ReadonlyMap<string, Kind>
  _chain?: readonly string[]
  _contextMenuTarget?: Accessor<FileTreeContextMenuTarget | undefined>
  _setContextMenuTarget?: Setter<FileTreeContextMenuTarget | undefined>
  _selection?: Accessor<SelectionState>
  _setSelection?: Setter<SelectionState>
  _pathTypes?: Map<string, FileNode["type"]>
  _clipboard?: Accessor<ClipboardState>
  _setClipboard?: Setter<ClipboardState>
}) {
  const file = useFile()
  const sdk = useSDK()
  const level = props.level ?? 0
  const draggable = () => props.draggable ?? true
  const root = !props._chain
  const [localContextMenuTarget, setLocalContextMenuTarget] = createSignal<FileTreeContextMenuTarget>()
  const contextMenuTarget = props._contextMenuTarget ?? localContextMenuTarget
  const setContextMenuTarget = props._setContextMenuTarget ?? setLocalContextMenuTarget
  const [localSelection, setLocalSelection] = createSignal<SelectionState>(emptySelection())
  const selection = props._selection ?? localSelection
  const setSelection = props._setSelection ?? setLocalSelection
  const pathTypes = props._pathTypes ?? new Map<string, FileNode["type"]>()
  const [localClipboard, setLocalClipboard] = createSignal<ClipboardState>(null)
  const clipboard = props._clipboard ?? localClipboard
  const setClipboard = props._setClipboard ?? setLocalClipboard
  let uploadInputEl: HTMLInputElement | undefined
  let pendingUploadParent: string | undefined

  const key = (p: string) =>
    file
      .normalize(p)
      .replace(/[\\/]+$/, "")
      .replaceAll("\\", "/")
  const chain = props._chain ? [...props._chain, key(props.path)] : [key(props.path)]

  const filter = createMemo(() => {
    if (props._filter) return props._filter

    const allowed = props.allowed
    if (!allowed) return

    const files = new Set(allowed)
    const dirs = new Set<string>()

    for (const item of allowed) {
      const parts = item.split("/")
      const parents = parts.slice(0, -1)
      for (const [idx] of parents.entries()) {
        const dir = parents.slice(0, idx + 1).join("/")
        if (dir) dirs.add(dir)
      }
    }

    return { files, dirs }
  })

  const marks = createMemo(() => {
    if (props._marks) return props._marks

    const out = new Set<string>()
    for (const item of props.modified ?? []) out.add(item)
    for (const item of props.kinds?.keys() ?? []) out.add(item)
    if (out.size === 0) return
    return out
  })

  const kinds = createMemo(() => {
    if (props._kinds) return props._kinds
    return props.kinds
  })

  const deeps = createMemo(() => {
    if (props._deeps) return props._deeps

    const out = new Map<string, number>()

    const root = props.path
    if (!(file.tree.state(root)?.expanded ?? false)) return out

    const seen = new Set<string>()
    const stack: { dir: string; lvl: number; i: number; kids: string[]; max: number }[] = []

    const push = (dir: string, lvl: number) => {
      const id = key(dir)
      if (seen.has(id)) return
      seen.add(id)

      const kids = file.tree
        .children(dir)
        .filter((node) => node.type === "directory" && (file.tree.state(node.path)?.expanded ?? false))
        .map((node) => node.path)

      stack.push({ dir, lvl, i: 0, kids, max: lvl })
    }

    push(root, level - 1)

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!

      if (top.i < top.kids.length) {
        const next = top.kids[top.i]!
        top.i++
        push(next, top.lvl + 1)
        continue
      }

      out.set(top.dir, top.max)
      stack.pop()

      const parent = stack[stack.length - 1]
      if (!parent) continue
      parent.max = Math.max(parent.max, top.max)
    }

    return out
  })

  createEffect(() => {
    const current = filter()
    const dirs = dirsToExpand({
      level,
      filter: current,
      expanded: (dir) => untrack(() => file.tree.state(dir)?.expanded) ?? false,
    })
    for (const dir of dirs) file.tree.expand(dir)
  })

  createEffect(
    on(
      () => props.path,
      (path) => {
        const dir = untrack(() => file.tree.state(path))
        if (!shouldListRoot({ level, dir })) return
        void file.tree.list(path)
      },
      { defer: false },
    ),
  )

  createEffect(() => {
    const dir = file.tree.state(props.path)
    if (!shouldListExpanded({ level, dir })) return
    void file.tree.list(props.path)
  })

  const nodes = createMemo(() => {
    const nodes = file.tree.children(props.path) ?? []
    const current = filter()
    if (!current) return nodes

    const parent = (path: string) => {
      const idx = path.lastIndexOf("/")
      if (idx === -1) return ""
      return path.slice(0, idx)
    }

    const leaf = (path: string) => {
      const idx = path.lastIndexOf("/")
      return idx === -1 ? path : path.slice(idx + 1)
    }

    const out = nodes.filter((node) => {
      if (node.type === "file") return current.files.has(node.path)
      return current.dirs.has(node.path)
    })

    const seen = new Set(out.map((node) => node.path))

    for (const dir of current.dirs) {
      if (parent(dir) !== props.path) continue
      if (seen.has(dir)) continue
      out.push({
        name: leaf(dir),
        path: dir,
        absolute: dir,
        type: "directory",
        ignored: false,
      })
      seen.add(dir)
    }

    for (const item of current.files) {
      if (parent(item) !== props.path) continue
      if (seen.has(item)) continue
      out.push({
        name: leaf(item),
        path: item,
        absolute: item,
        type: "file",
        ignored: false,
      })
      seen.add(item)
    }

    out.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    return out
  })

  // Track the cursor position at the moment of the last right-click inside
  // the tree so confirmation popovers can anchor near where the user
  // actually clicked, not at the screen center.
  const [lastMenuAnchor, setLastMenuAnchor] = createSignal<{ x: number; y: number } | undefined>()
  const captureMenuAnchor = (event: MouseEvent) => {
    setLastMenuAnchor({ x: event.clientX, y: event.clientY })
  }

  const publishContextMenuTarget = (target: FileTreeContextMenuTarget) => {
    setContextMenuTarget(target)
    props.onContextMenuTarget?.(target)
  }

  const handleBackgroundContextMenu = (event: MouseEvent) => {
    captureMenuAnchor(event)
    const target = event.target
    if (target instanceof Element && target.closest('[data-filetree-row="true"]')) return
    const folder = target instanceof Element ? target.closest<HTMLElement>("[data-filetree-folder-path]") : undefined
    const path = file.normalize(folder?.dataset.filetreeFolderPath ?? props.path)
    publishContextMenuTarget(fileTreeFolderContextMenuTarget(path))
  }

  // ----- Phase 3.3: action dispatch wiring -----------------------------
  // The context menu actions defined by fileTreeContextMenuActionGroups
  // are paired here with concrete handlers that call the file SDK and feed
  // results back into the file context for refresh + tab reconcile. V1 uses
  // window.prompt / window.confirm for name + delete confirmation as a known
  // UX limitation; Phase 7 polish replaces them with in-app dialogs.

  type ActionTarget = FileTreeContextMenuTarget

  const parentForCreate = (target: ActionTarget): string => {
    if (target.kind === "folder") return target.path
    if (target.nodeType === "directory") return target.path
    return target.parentPath
  }

  const parentForUpload = parentForCreate

  const surfaceError = (err: unknown, fallbackTitle: string) => {
    const data = (err && typeof err === "object" && "data" in err ? (err as { data?: unknown }).data : undefined) as
      | { code?: string; message?: string }
      | undefined
    const code = typeof data?.code === "string" ? data.code : undefined
    const message =
      (typeof data?.message === "string" && data.message) ||
      (err instanceof Error ? err.message : undefined) ||
      "Operation failed."
    showToast({
      variant: "error",
      title: code ? `${fallbackTitle} (${code})` : fallbackTitle,
      description: message,
    })
  }

  const finishOperation = (result: FileOperationResult | undefined, successDescription: string) => {
    if (!result) return
    file.applyOperationResult(result)
    setSelection(emptySelection())
    showToast({ variant: "success", title: "File operation", description: successDescription })
  }

  const runCreate = async (target: ActionTarget, type: "file" | "directory") => {
    const parent = parentForCreate(target)
    const label = type === "directory" ? "Folder name" : "File name"
    const name = window.prompt(`${label} (in ${parent || "/"})`)?.trim()
    if (!name) return
    try {
      const response = await sdk.client.file.create({ parent, name, type })
      finishOperation(response.data, `${type === "directory" ? "Folder" : "File"} created: ${parent ? parent + "/" : ""}${name}`)
    } catch (err) {
      surfaceError(err, `Create ${type} failed`)
    }
  }

  const runRename = async (target: ActionTarget) => {
    if (target.kind !== "row") return
    const current = target.path.split("/").pop() ?? target.path
    const next = window.prompt(`Rename "${current}" to:`, current)?.trim()
    if (!next || next === current) return
    try {
      const response = await sdk.client.file.rename({ path: target.path, name: next })
      finishOperation(response.data, `Renamed to ${response.data?.destination ?? next}`)
    } catch (err) {
      surfaceError(err, "Rename failed")
    }
  }

  // Anchored in-app delete confirmation. Replaces the browser-native
  // window.confirm() (which renders centered with an origin-prefixed
  // header — visually disconnected from the right-click action). Uses
  // the captured cursor position from the most recent contextmenu event
  // and renders a fixed Portal layer near that point.
  type DeletePending = { batch: string[]; anchor: { x: number; y: number } }
  const [deletePending, setDeletePending] = createSignal<DeletePending | undefined>()

  const runDelete = (target: ActionTarget) => {
    if (target.kind !== "row") return
    const sel = selection().selected
    const batch = sel.has(target.path) && sel.size > 1 ? Array.from(sel) : [target.path]
    const anchor = lastMenuAnchor() ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    setDeletePending({ batch, anchor })
  }

  const performDelete = async (batch: string[]) => {
    let recyclebinCount = 0
    let permanentCount = 0
    let lastError: unknown
    for (const path of batch) {
      try {
        const response = await sdk.client.file.deleteToRecyclebin({ path, confirmed: true })
        if (response.data) {
          file.applyOperationResult(response.data)
          if (response.data.destination) recyclebinCount++
          else permanentCount++
        }
      } catch (err) {
        lastError = err
      }
    }
    setSelection(emptySelection())
    const succeeded = recyclebinCount + permanentCount
    if (succeeded > 0) {
      const parts: string[] = []
      if (recyclebinCount > 0) parts.push(`${recyclebinCount} to recyclebin`)
      if (permanentCount > 0) parts.push(`${permanentCount} permanently deleted (cloud client handles trash)`)
      showToast({
        variant: "success",
        title: succeeded === batch.length ? "Deleted" : `Deleted ${succeeded} of ${batch.length}`,
        description: parts.join(" · "),
      })
    }
    if (lastError) surfaceError(lastError, "Delete failed")
  }

  const runRestore = async (target: ActionTarget) => {
    if (target.kind !== "row") return
    try {
      const response = await sdk.client.file.restoreFromRecyclebin({ tombstonePath: target.path })
      finishOperation(response.data, `Restored to ${response.data?.destination ?? target.path}`)
    } catch (err) {
      surfaceError(err, "Restore failed")
    }
  }

  const runUpload = (target: ActionTarget) => {
    if (!uploadInputEl) return
    pendingUploadParent = parentForUpload(target)
    uploadInputEl.value = ""
    uploadInputEl.click()
  }

  const handleUploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || pendingUploadParent === undefined) return
    const parent = pendingUploadParent
    pendingUploadParent = undefined
    let succeeded = 0
    let lastError: unknown
    for (const item of Array.from(files)) {
      try {
        const response = await sdk.client.file.upload({ parent, file: item })
        if (response.data) succeeded++
      } catch (err) {
        lastError = err
      }
    }
    // Refresh once at the end with a synthetic result; the per-file results
    // already updated the tree branch via the loop's applyOperationResult
    // (skipped above for clarity — let the outer loop call it now).
    if (succeeded > 0) {
      showToast({
        variant: "success",
        title: "Upload complete",
        description: succeeded === files.length ? `${succeeded} file(s)` : `${succeeded} of ${files.length} file(s)`,
      })
      // Force a refresh of the upload-target folder once after the batch.
      void file.tree.refresh(parent)
    }
    if (lastError) surfaceError(lastError, "Upload failed")
  }

  const runDownload = async (target: ActionTarget) => {
    if (target.kind !== "row" || target.nodeType !== "file") return
    try {
      const url = new URL(`${sdk.url}/api/v2/file/download`)
      url.searchParams.set("directory", sdk.directory)
      url.searchParams.set("path", target.path)
      const response = await sdk.fetch(url.toString())
      if (!response.ok) {
        const body = await response.json().catch(() => undefined)
        const synthetic = { data: body }
        surfaceError(synthetic, "Download failed")
        return
      }
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const filename = target.path.split("/").pop() ?? "download"
      const anchor = document.createElement("a")
      anchor.href = objectUrl
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(objectUrl)
      showToast({ variant: "success", title: "Downloaded", description: filename })
    } catch (err) {
      surfaceError(err, "Download failed")
    }
  }

  const runOpen = (target: ActionTarget) => {
    if (target.kind !== "row" || target.nodeType !== "file") return
    props.onFileClick?.(target.node)
  }

  // ----- Phase 4.1 + 4.2 + 4.4: in-app clipboard + paste/move ----------
  // Copy / cut record the source set in an in-app `clipboard` signal so
  // paste can decide between sdk.client.file.copy and sdk.client.file.move.
  // After a successful cut+paste the clipboard clears (sources are gone);
  // copy paste persists so the user can paste again. Conflicts surface as
  // FILE_OP_DUPLICATE toasts via the existing surfaceError path.

  const collectClipboardEntries = (target: ActionTarget): FileTreeClipboardEntry[] => {
    if (target.kind !== "row") return []
    const sel = selection().selected
    if (sel.has(target.path) && sel.size > 1) {
      const out: FileTreeClipboardEntry[] = []
      for (const path of sel) {
        const type = pathTypes.get(path)
        if (type) out.push({ path, type })
      }
      return out
    }
    return [{ path: target.path, type: target.nodeType }]
  }

  const runClipboard = (target: ActionTarget, mode: "copy" | "cut") => {
    const entries = collectClipboardEntries(target)
    if (entries.length === 0) return
    setClipboard({ mode, entries })
    showToast({
      variant: "default",
      title: mode === "copy" ? "Copied" : "Cut",
      description:
        entries.length === 1
          ? entries[0].path
          : `${entries.length} items — paste into a folder to ${mode === "copy" ? "duplicate" : "move"}`,
    })
  }

  // Per-paste session "Apply to all" memory for overwrite confirms. Reset
  // per runPaste call so each paste batch starts fresh.
  const runPaste = async (target: ActionTarget) => {
    const cb = clipboard()
    if (!cb || cb.entries.length === 0) {
      showToast({
        variant: "error",
        title: "Paste failed",
        description: "No copied or cut items are pending.",
      })
      return
    }
    const destinationParent = parentForCreate(target)
    let succeeded = 0
    let cancelled = 0
    let lastError: unknown
    let overwriteAllRemaining: boolean | undefined // undefined = ask each, true = overwrite all, false = skip all
    for (const entry of cb.entries) {
      let overwrite = false
      let resolved = false
      while (!resolved) {
        try {
          const response =
            cb.mode === "cut"
              ? await sdk.client.file.move({ source: entry.path, destinationParent, overwrite })
              : await sdk.client.file.copy({ source: entry.path, destinationParent, overwrite })
          if (response.data) {
            file.applyOperationResult(response.data)
            succeeded++
          }
          resolved = true
        } catch (err) {
          const data = (err && typeof err === "object" && "data" in err ? (err as { data?: unknown }).data : undefined) as
            | { code?: string }
            | undefined
          if (data?.code === "FILE_OP_DUPLICATE" && !overwrite) {
            const basename = entry.path.split("/").pop() ?? entry.path
            const remaining = cb.entries.length - (succeeded + cancelled + 1)
            let decision: "overwrite" | "skip"
            if (overwriteAllRemaining === true) {
              decision = "overwrite"
            } else if (overwriteAllRemaining === false) {
              decision = "skip"
            } else if (remaining > 0) {
              // Multi-item paste with collisions still ahead: ask once with
              // the option to apply to all. Browser confirm() is yes/no, so
              // we layer two prompts: the first ack-or-skip, then "apply
              // to all remaining?".
              const ok = window.confirm(
                `「${basename}」已存在於目的地：${destinationParent || "/"}\n\n要覆蓋嗎？\n（資料夾會整個覆寫，內部衝突檔案會一起換掉。）`,
              )
              decision = ok ? "overwrite" : "skip"
              if (remaining > 0) {
                const applyAll = window.confirm(
                  decision === "overwrite"
                    ? `對剩餘 ${remaining} 個衝突項目都套用「覆蓋」？\n按取消會逐項詢問。`
                    : `對剩餘 ${remaining} 個衝突項目都套用「跳過」？\n按取消會逐項詢問。`,
                )
                if (applyAll) overwriteAllRemaining = decision === "overwrite"
              }
            } else {
              const ok = window.confirm(
                `「${basename}」已存在於目的地：${destinationParent || "/"}\n\n要覆蓋嗎？\n（資料夾會整個覆寫，內部衝突檔案會一起換掉。）`,
              )
              decision = ok ? "overwrite" : "skip"
            }
            if (decision === "overwrite") {
              overwrite = true
              continue // retry same entry with overwrite=true
            }
            cancelled++
            resolved = true
          } else {
            lastError = err
            resolved = true
          }
        }
      }
    }
    if (cb.mode === "cut") setClipboard(null)
    setSelection(emptySelection())
    if (succeeded > 0) {
      showToast({
        variant: "success",
        title: cb.mode === "cut" ? "Moved" : "Copied",
        description:
          succeeded === cb.entries.length
            ? `${succeeded} item(s) into ${destinationParent || "/"}`
            : `${succeeded} of ${cb.entries.length} item(s) into ${destinationParent || "/"}` +
              (cancelled > 0 ? ` (${cancelled} skipped)` : ""),
      })
    } else if (cancelled > 0 && !lastError) {
      showToast({
        variant: "default",
        title: "Paste cancelled",
        description: `${cancelled} item(s) skipped (destination already exists).`,
      })
    }
    if (lastError) surfaceError(lastError, cb.mode === "cut" ? "Move failed" : "Copy failed")
  }

  // Phase 4.3: paste to a writable destination outside the active project.
  // Pre-conditions enforced server-side: source must still be inside the
  // active project; destination is canonicalized and write-permission
  // probed before any bytes are touched. UX-side: V1 uses window.prompt
  // for the absolute path and window.confirm to surface the canonical
  // destination. Both are deferred-to-Phase-7 polish placeholders.
  const runPasteExternal = async () => {
    const cb = clipboard()
    if (!cb || cb.entries.length === 0) {
      showToast({
        variant: "error",
        title: "Paste failed",
        description: "No copied or cut items are pending.",
      })
      return
    }
    const requested = window.prompt("Paste destination (absolute path):")?.trim()
    if (!requested) return

    let preflight: Awaited<ReturnType<typeof sdk.client.file.destinationPreflight>>
    try {
      preflight = await sdk.client.file.destinationPreflight({
        destinationParent: requested,
        scope: "external",
      })
    } catch (err) {
      surfaceError(err, "External paste preflight failed")
      return
    }
    const result = preflight.data
    if (!result || !result.writable) {
      showToast({
        variant: "error",
        title: "External paste blocked",
        description: result?.reason ? `${result.reason}: ${result.canonicalPath ?? requested}` : "Destination is not writable.",
      })
      return
    }
    const canonical = result.canonicalPath
    const confirmed = window.confirm(
      `Paste ${cb.entries.length} item(s) into:\n${canonical}\n\n${cb.mode === "cut" ? "Source files will be MOVED." : "Source files will be COPIED."}`,
    )
    if (!confirmed) return

    let succeeded = 0
    let lastError: unknown
    for (const entry of cb.entries) {
      try {
        const response =
          cb.mode === "cut"
            ? await sdk.client.file.move({ source: entry.path, destinationParent: canonical, scope: "external" })
            : await sdk.client.file.copy({ source: entry.path, destinationParent: canonical, scope: "external" })
        if (response.data) {
          file.applyOperationResult(response.data)
          succeeded++
        }
      } catch (err) {
        lastError = err
      }
    }
    if (cb.mode === "cut") setClipboard(null)
    setSelection(emptySelection())
    if (succeeded > 0) {
      showToast({
        variant: "success",
        title: cb.mode === "cut" ? "Moved (external)" : "Copied (external)",
        description:
          succeeded === cb.entries.length
            ? `${succeeded} item(s) into ${canonical}`
            : `${succeeded} of ${cb.entries.length} item(s) into ${canonical}`,
      })
    }
    if (lastError) surfaceError(lastError, cb.mode === "cut" ? "External move failed" : "External copy failed")
  }

  const runAction = (id: FileTreeContextMenuActionId, target: ActionTarget) => {
    switch (id) {
      case "open":
        runOpen(target)
        return
      case "create-file":
        void runCreate(target, "file")
        return
      case "create-folder":
        void runCreate(target, "directory")
        return
      case "rename":
        void runRename(target)
        return
      case "delete":
        void runDelete(target)
        return
      case "restore":
        void runRestore(target)
        return
      case "upload":
        runUpload(target)
        return
      case "download":
        void runDownload(target)
        return
      case "copy":
        runClipboard(target, "copy")
        return
      case "cut":
        runClipboard(target, "cut")
        return
      case "paste":
        void runPaste(target)
        return
      case "paste-external":
        void runPasteExternal()
        return
    }
  }

  const effectiveContextSelection = createMemo<readonly FileTreeContextSelectionItem[] | undefined>(() => {
    if (props.contextSelection) return props.contextSelection
    const sel = selection().selected
    if (sel.size === 0) return undefined
    const items: FileTreeContextSelectionItem[] = []
    for (const path of sel) {
      const type = pathTypes.get(path)
      if (type) items.push({ path, type })
    }
    return items.length > 0 ? items : undefined
  })

  const effectiveHasPendingClipboard = createMemo(() => {
    if (props.hasPendingClipboard !== undefined) return props.hasPendingClipboard
    return (clipboard()?.entries.length ?? 0) > 0
  })

  const cutPathSet = createMemo(() => {
    const cb = clipboard()
    if (!cb || cb.mode !== "cut") return undefined
    const set = new Set<string>()
    for (const e of cb.entries) set.add(e.path)
    return set
  })

  const defaultContextMenu = (target: FileTreeContextMenuTarget) => (
    <For
      each={fileTreeContextMenuActionGroups({
        target,
        selection: effectiveContextSelection(),
        hasPendingClipboard: effectiveHasPendingClipboard(),
      })}
    >
      {(group, index) => (
        <ContextMenu.Group>
          <Show when={index() > 0}>
            <ContextMenu.Separator />
          </Show>
          <ContextMenu.GroupLabel>{group.label}</ContextMenu.GroupLabel>
          <For each={group.actions}>
            {(action) => (
              <ContextMenu.Item
                disabled={!action.enabled}
                onSelect={() => {
                  if (!action.enabled) return
                  const target = contextMenuTarget()
                  if (!target) return
                  runAction(action.id, target)
                }}
              >
                <ContextMenu.ItemLabel>{action.label}</ContextMenu.ItemLabel>
                <Show when={!action.enabled && action.reason}>
                  {(reason) => <ContextMenu.ItemDescription>{reason()}</ContextMenu.ItemDescription>}
                </Show>
              </ContextMenu.Item>
            )}
          </For>
        </ContextMenu.Group>
      )}
    </For>
  )

  const remember = (node: FileNode) => {
    pathTypes.set(node.path, node.type)
  }

  // Mirror every currently-visible node into pathTypes so that selection
  // helpers built from path strings alone (Shift-click range, header
  // select-all, programmatic selection from outside) can still emit a
  // typed contextSelection. Without this, shift-click range adds the
  // path strings to selection() but their types are never registered,
  // and effectiveContextSelection silently drops them — surfacing as
  // "Cut N items" where N is suspiciously smaller than what the user
  // visually highlighted.
  createEffect(() => {
    for (const node of nodes()) pathTypes.set(node.path, node.type)
  })

  const siblingPaths = createMemo(() => nodes().map((n) => n.path))

  const isSelected = (path: string) => selection().selected.has(path)

  const handleRowClick = (node: FileNode, event: MouseEvent) => {
    remember(node)
    setSelection((prev) =>
      applyRowClick(prev, node.path, siblingPaths(), {
        shift: event.shiftKey,
        ctrlOrMeta: event.ctrlKey || event.metaKey,
      }),
    )
  }

  const handleCheckboxToggle = (node: FileNode) => {
    remember(node)
    setSelection((prev) => applyCheckboxToggle(prev, node.path))
  }

  const handleHeaderToggle = () => {
    for (const node of nodes()) remember(node)
    setSelection((prev) => applySelectAllToggle(prev, siblingPaths()))
  }

  const headerAllSelected = createMemo(() => {
    const sibs = siblingPaths()
    if (sibs.length === 0) return false
    const sel = selection().selected
    return sibs.every((p) => sel.has(p))
  })

  const headerIndeterminate = createMemo(() => {
    const sibs = siblingPaths()
    if (sibs.length === 0) return false
    const sel = selection().selected
    const some = sibs.some((p) => sel.has(p))
    return some && !headerAllSelected()
  })

  const stopPropagation = (e: MouseEvent) => e.stopPropagation()

  const renderLeading = (node: FileNode) => (
    <span class="shrink-0 size-4 flex items-center justify-center" onClick={stopPropagation} onDblClick={stopPropagation}>
      <Checkbox
        checked={isSelected(node.path)}
        onChange={() => handleCheckboxToggle(node)}
        aria-label={`Select ${node.name}`}
        hideLabel
      >
        {node.name}
      </Checkbox>
    </span>
  )

  const renderTrailing = (node: FileNode) => (
    <span class="contents text-text-weak text-12-regular">
      <span class="shrink-0 w-16 text-right tabular-nums truncate">
        {node.type === "file" && typeof node.size === "number" ? formatBytes(node.size) : ""}
      </span>
      <span class="shrink-0 w-44 text-right tabular-nums truncate">
        {typeof node.modifiedAt === "number" ? formatModifiedShort(node.modifiedAt) : ""}
      </span>
    </span>
  )

  const renderHeader = () => (
    <div class="w-full h-6 flex items-center gap-x-1.5 px-1.5 text-text-weak text-12-medium border-b border-border-weak-base">
      <span class="shrink-0 size-4 flex items-center justify-center">
        <Checkbox
          checked={headerAllSelected()}
          indeterminate={headerIndeterminate()}
          onChange={handleHeaderToggle}
          aria-label="Select all visible"
          hideLabel
        >
          select all
        </Checkbox>
      </span>
      <span class="w-4 shrink-0" />
      <span class="size-4 shrink-0" />
      <span class="flex-1 min-w-0">Name</span>
      <span class="shrink-0 w-16 text-right">Size</span>
      <span class="shrink-0 w-44 text-right">Modified</span>
    </div>
  )

  // ----- Keyboard shortcuts (root tree only) ----------------------------
  // Bound on the root tree <div>. keydown bubbles from focused interactive
  // children (checkboxes, chevrons, etc.) so the handler only fires when
  // focus is INSIDE the file tree. When focus moves to chat input,
  // terminal, or any other surface in a separate DOM subtree, events
  // never reach this handler and Ctrl+C / Ctrl+V / Ctrl+X behave normally
  // for that surface — no manual release needed.
  //
  // Bindings:
  //   Ctrl/Cmd+C  -> copy current selection to in-app clipboard
  //   Ctrl/Cmd+X  -> cut current selection
  //   Ctrl/Cmd+V  -> paste at the anchor's containing folder (or root)
  //   Escape      -> clear selection
  // Other modifier combos and plain keys pass through untouched.
  const buildClipboardEntriesFromSelection = (): FileTreeClipboardEntry[] => {
    const out: FileTreeClipboardEntry[] = []
    for (const path of selection().selected) {
      const type = pathTypes.get(path)
      if (type) out.push({ path, type })
    }
    return out
  }
  const pasteParentFromAnchor = (): string => {
    const anchor = selection().anchor
    if (!anchor) return props.path  // tree root
    const type = pathTypes.get(anchor)
    if (type === "directory") return anchor
    const idx = anchor.lastIndexOf("/")
    return idx === -1 ? "" : anchor.slice(0, idx)
  }
  const handleTreeKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.shiftKey) return
    const mod = event.ctrlKey || event.metaKey
    const target = event.target as Element | null
    const tag = target?.tagName
    // Don't hijack typing inside actual editable elements (rename inline,
    // search box, etc.).
    if (tag === "INPUT" || tag === "TEXTAREA" || (target as HTMLElement | null)?.isContentEditable) return

    if (event.key === "Escape" && !mod) {
      if (selection().selected.size === 0 && selection().anchor === undefined) return
      event.preventDefault()
      setSelection(emptySelection())
      return
    }

    if (!mod) return
    const key = event.key.toLowerCase()
    if (key === "c") {
      const entries = buildClipboardEntriesFromSelection()
      if (entries.length === 0) return
      event.preventDefault()
      setClipboard({ mode: "copy", entries })
      showToast({
        variant: "default",
        title: "Copied",
        description: entries.length === 1 ? entries[0].path : `${entries.length} items`,
      })
      return
    }
    if (key === "x") {
      const entries = buildClipboardEntriesFromSelection()
      if (entries.length === 0) return
      event.preventDefault()
      setClipboard({ mode: "cut", entries })
      showToast({
        variant: "default",
        title: "Cut",
        description: entries.length === 1 ? entries[0].path : `${entries.length} items`,
      })
      return
    }
    if (key === "v") {
      const cb = clipboard()
      if (!cb || cb.entries.length === 0) return
      event.preventDefault()
      const pasteParent = pasteParentFromAnchor()
      const targetForPaste: FileTreeContextMenuTarget = {
        kind: "folder",
        path: pasteParent,
        parentPath: parentPath(pasteParent),
      }
      void runPaste(targetForPaste)
      return
    }
  }

  const tree = () => (
    <div
      class={`flex flex-col gap-0.5 ${root ? "min-h-full" : ""} ${props.class ?? ""}`}
      data-filetree-folder-path={file.normalize(props.path)}
      onContextMenu={root ? handleBackgroundContextMenu : undefined}
      onKeyDown={root ? handleTreeKeyDown : undefined}
      tabIndex={root ? -1 : undefined}
    >
      <Show when={root && props.showHeader}>{renderHeader()}</Show>
      <For each={nodes()}>
        {(node) => {
          const expanded = () => file.tree.state(node.path)?.expanded ?? false
          const deep = () => deeps().get(node.path) ?? -1
          const kind = () => visibleKind(node, kinds(), marks())

          return (
            <Switch>
              <Match when={node.type === "directory"}>
                <Collapsible
                  variant="ghost"
                  class="w-full"
                  data-scope="filetree"
                  forceMount={false}
                  open={expanded()}
                  onOpenChange={(open) => {
                    if (open) {
                      file.tree.expand(node.path)
                    } else {
                      void file.tree.refresh(node.path)
                      file.tree.collapse(node.path)
                    }
                  }}
                >
                  <FileTreeNode
                    node={node}
                    level={level}
                    active={props.active}
                    selected={isSelected(node.path)}
                    cut={cutPathSet()?.has(node.path)}
                    nodeClass={props.nodeClass}
                    draggable={draggable()}
                    kinds={kinds()}
                    marks={marks()}
                    leading={renderLeading(node)}
                    trailing={renderTrailing(node)}
                    onClick={(event: MouseEvent) => handleRowClick(node, event)}
                    onDblClick={() => {
                      if (expanded()) {
                        void file.tree.refresh(node.path)
                        file.tree.collapse(node.path)
                      } else {
                        file.tree.expand(node.path)
                      }
                    }}
                    onContextMenu={(event: MouseEvent) => {
                      captureMenuAnchor(event)
                      publishContextMenuTarget(fileTreeRowContextMenuTarget(node))
                    }}
                  >
                    <Collapsible.Trigger
                      as="button"
                      type="button"
                      class="size-4 flex items-center justify-center text-icon-base shrink-0 hover:text-text-base"
                      aria-label={expanded() ? "Collapse" : "Expand"}
                      onClick={stopPropagation}
                      onDblClick={stopPropagation}
                    >
                      <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
                    </Collapsible.Trigger>
                  </FileTreeNode>
                  <Collapsible.Content class="relative pt-0.5">
                    <div
                      classList={{
                        "absolute top-0 bottom-0 w-px pointer-events-none bg-border-weak-base opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none": true,
                        "group-hover/filetree:opacity-100": expanded() && deep() === level,
                        "group-hover/filetree:opacity-50": !(expanded() && deep() === level),
                      }}
                      style={`left: ${Math.max(0, 8 + level * 12 - 4) + 8}px`}
                    />
                    <Show
                      when={level < MAX_DEPTH && !chain.includes(key(node.path))}
                      fallback={<div class="px-2 py-1 text-12-regular text-text-base">...</div>}
                    >
                      <FileTree
                        path={node.path}
                        level={level + 1}
                        allowed={props.allowed}
                        modified={props.modified}
                        kinds={props.kinds}
                        active={props.active}
                        draggable={props.draggable}
                        onFileClick={props.onFileClick}
                        onContextMenuTarget={props.onContextMenuTarget}
                        contextSelection={props.contextSelection}
                        hasPendingClipboard={props.hasPendingClipboard}
                        contextMenu={props.contextMenu}
                        _filter={filter()}
                        _marks={marks()}
                        _deeps={deeps()}
                        _kinds={kinds()}
                        _chain={chain}
                        _contextMenuTarget={contextMenuTarget}
                        _setContextMenuTarget={setContextMenuTarget}
                        _selection={selection}
                        _setSelection={setSelection}
                        _pathTypes={pathTypes}
                        _clipboard={clipboard}
                        _setClipboard={setClipboard}
                      />
                    </Show>
                  </Collapsible.Content>
                </Collapsible>
              </Match>
              <Match when={node.type === "file"}>
                <FileTreeNode
                  node={node}
                  level={level}
                  active={props.active}
                  selected={isSelected(node.path)}
                  cut={cutPathSet()?.has(node.path)}
                  nodeClass={props.nodeClass}
                  draggable={draggable()}
                  kinds={kinds()}
                  marks={marks()}
                  leading={renderLeading(node)}
                  trailing={renderTrailing(node)}
                  onClick={(event: MouseEvent) => handleRowClick(node, event)}
                  onDblClick={() => props.onFileClick?.(node)}
                  onContextMenu={() => publishContextMenuTarget(fileTreeRowContextMenuTarget(node))}
                >
                  <div class="w-4 shrink-0" />
                  <FileIcon node={node} class="text-icon-base size-4" />
                </FileTreeNode>
              </Match>
            </Switch>
          )
        }}
      </For>
    </div>
  )

  if (!root) return tree()

  return (
    <ContextMenu>
      <ContextMenu.Trigger as="div" class="contents">
        {tree()}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          // UAT pass 2: distinct background + auto-dismiss on outside click.
          // Default modal=true (we removed the modal={false} override) gives
          // Kobalte its overlay-based outside detection so the menu closes
          // when the user clicks elsewhere. Blue tint distinguishes the menu
          // from the same-toned file tree underneath.
          class="!bg-blue-950 !border-2 !border-blue-500 !shadow-lg"
        >
          <Show when={contextMenuTarget()}>{(target) => (props.contextMenu ?? defaultContextMenu)(target())}</Show>
        </ContextMenu.Content>
      </ContextMenu.Portal>
      <input
        ref={(el) => {
          uploadInputEl = el
        }}
        type="file"
        multiple
        class="hidden"
        aria-hidden="true"
        onChange={(event) => {
          const target = event.currentTarget
          void handleUploadFiles(target.files).finally(() => {
            target.value = ""
          })
        }}
      />
      <Show when={deletePending()}>
        {(pending) => {
          // Position-clamped so the popup never overflows the viewport edge.
          const POPUP_MAX_W = 360
          const POPUP_MAX_H = 200
          const left = () => Math.max(8, Math.min(pending().anchor.x, window.innerWidth - POPUP_MAX_W - 8))
          const top = () => Math.max(8, Math.min(pending().anchor.y, window.innerHeight - POPUP_MAX_H - 8))
          const batch = () => pending().batch
          const sample = () => batch().slice(0, 3).join(", ")
          const more = () => (batch().length > 3 ? ` and ${batch().length - 3} more` : "")
          // Outside-click + Esc to dismiss. Mirrors the in-app dismissal
          // contract used by the right-click context menu and the popout
          // window chrome.
          let overlayRef: HTMLDivElement | undefined
          const onOutsideKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
              e.preventDefault()
              setDeletePending(undefined)
            }
          }
          createEffect(() => {
            if (!deletePending()) return
            window.addEventListener("keydown", onOutsideKey, true)
            onCleanup(() => window.removeEventListener("keydown", onOutsideKey, true))
          })
          return (
            <Portal>
              <div
                ref={(el) => {
                  overlayRef = el
                }}
                class="fixed inset-0 z-[200]"
                onClick={(e) => {
                  if (e.target === overlayRef) setDeletePending(undefined)
                }}
              >
                <div
                  class="fixed bg-slate-900 border-2 border-slate-600 rounded-md shadow-xl text-slate-100 p-3 text-12-regular"
                  style={{
                    "max-width": `${POPUP_MAX_W}px`,
                    "max-height": `${POPUP_MAX_H}px`,
                    left: `${left()}px`,
                    top: `${top()}px`,
                  }}
                  data-slot="filetree-delete-confirm"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div class="text-14-medium mb-1">
                    {batch().length === 1 ? "Delete this item?" : `Delete ${batch().length} items?`}
                  </div>
                  <div class="text-text-weak break-all mb-3 max-h-20 overflow-auto">
                    {sample()}
                    {more()}
                  </div>
                  <div class="flex justify-end gap-2">
                    <button
                      type="button"
                      class="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-100"
                      onClick={() => setDeletePending(undefined)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      class="px-2 py-1 rounded bg-red-600 hover:bg-red-500 text-white"
                      onClick={() => {
                        const b = batch()
                        setDeletePending(undefined)
                        void performDelete(b)
                      }}
                    >
                      確定
                    </button>
                  </div>
                </div>
              </div>
            </Portal>
          )
        }}
      </Show>
    </ContextMenu>
  )
}
