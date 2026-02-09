import { useFile } from "@/context/file"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createMemo, Show, splitProps, type ComponentProps, type ParentProps } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { VList } from "virtua/solid"
import { useFlattenedTree, type FlattenedNode } from "@/hooks/use-flattened-tree"

function pathToFileUrl(filepath: string): string {
  const encodedPath = filepath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  return `file://${encodedPath}`
}

type Kind = "add" | "del" | "mix"

type Filter = {
  files: Set<string>
  dirs: Set<string>
}

export default function FileTree(props: {
  path: string
  class?: string
  nodeClass?: string
  active?: string
  allowed?: readonly string[]
  modified?: readonly string[]
  kinds?: ReadonlyMap<string, Kind>
  draggable?: boolean
  tooltip?: boolean
  onFileClick?: (file: FileNode) => void
}) {
  const file = useFile()
  const draggable = () => props.draggable ?? true
  const tooltip = () => props.tooltip ?? true

  const flattened = useFlattenedTree({
    rootPath: props.path,
    allowed: props.allowed,
  })

  // Auto-expand directories when 'allowed' list is provided (e.g., in "Changes" tab)
  createMemo(() => {
    const allowed = props.allowed
    if (!allowed) return

    for (const item of allowed) {
      const parts = item.split("/")
      const parents = parts.slice(0, -1)
      for (const [idx] of parents.entries()) {
        const dir = parents.slice(0, idx + 1).join("/")
        if (dir && !file.tree.state(dir)?.expanded) {
          file.tree.expand(dir)
        }
      }
    }
  })

  const marks = createMemo(() => {
    const out = new Set<string>()
    for (const item of props.modified ?? []) out.add(item)
    for (const item of props.kinds?.keys() ?? []) out.add(item)
    if (out.size === 0) return
    return out
  })

  const kinds = createMemo(() => props.kinds)

  const Node = (
    p: ParentProps &
      ComponentProps<"div"> &
      ComponentProps<"button"> & {
        node: FileNode
        depth: number
        as?: "div" | "button"
      },
  ) => {
    const [local, rest] = splitProps(p, ["node", "depth", "as", "children", "class", "classList"])
    return (
      <Dynamic
        component={local.as ?? "div"}
        classList={{
          "w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-left hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors cursor-pointer": true,
          "bg-surface-base-active": local.node.path === props.active,
          ...(local.classList ?? {}),
          [local.class ?? ""]: !!local.class,
          [props.nodeClass ?? ""]: !!props.nodeClass,
        }}
        style={`padding-left: ${Math.max(0, 8 + local.depth * 12 - (local.node.type === "file" ? 24 : 4))}px`}
        draggable={draggable()}
        onDragStart={(e: DragEvent) => {
          if (!draggable()) return
          e.dataTransfer?.setData("text/plain", `file:${local.node.path}`)
          e.dataTransfer?.setData("text/uri-list", pathToFileUrl(local.node.path))
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy"

          const dragImage = document.createElement("div")
          dragImage.className =
            "flex items-center gap-x-2 px-2 py-1 bg-surface-raised-base rounded-md border border-border-base text-12-regular text-text-strong"
          dragImage.style.position = "absolute"
          dragImage.style.top = "-1000px"

          const icon =
            (e.currentTarget as HTMLElement).querySelector('[data-component="file-icon"]') ??
            (e.currentTarget as HTMLElement).querySelector("svg")
          const text = (e.currentTarget as HTMLElement).querySelector("span")
          if (icon && text) {
            dragImage.innerHTML = (icon as SVGElement).outerHTML + (text as HTMLSpanElement).outerHTML
          }

          document.body.appendChild(dragImage)
          e.dataTransfer?.setDragImage(dragImage, 0, 12)
          setTimeout(() => document.body.removeChild(dragImage), 0)
        }}
        {...rest}
      >
        {local.children}
        {(() => {
          const kind = kinds()?.get(local.node.path)
          const marked = marks()?.has(local.node.path) ?? false
          const active = !!kind && marked && !local.node.ignored
          const color =
            kind === "add"
              ? "color: var(--icon-diff-add-base)"
              : kind === "del"
                ? "color: var(--icon-diff-delete-base)"
                : kind === "mix"
                  ? "color: var(--icon-diff-modified-base)"
                  : undefined
          return (
            <span
              classList={{
                "flex-1 min-w-0 text-12-medium whitespace-nowrap truncate": true,
                "text-text-weaker": local.node.ignored,
                "text-text-weak": !local.node.ignored && !active,
              }}
              style={active ? color : undefined}
            >
              {local.node.name}
            </span>
          )
        })()}
        {(() => {
          const kind = kinds()?.get(local.node.path)
          if (!kind) return null
          if (!marks()?.has(local.node.path)) return null

          if (local.node.type === "file") {
            const text = kind === "add" ? "A" : kind === "del" ? "D" : "M"
            const color =
              kind === "add"
                ? "color: var(--icon-diff-add-base)"
                : kind === "del"
                  ? "color: var(--icon-diff-delete-base)"
                  : "color: var(--icon-diff-modified-base)"

            return (
              <span class="shrink-0 w-4 text-center text-12-medium" style={color}>
                {text}
              </span>
            )
          }

          if (local.node.type === "directory") {
            const color =
              kind === "add"
                ? "background-color: var(--icon-diff-add-base)"
                : kind === "del"
                  ? "background-color: var(--icon-diff-delete-base)"
                  : "background-color: var(--icon-diff-modified-base)"

            return <div class="shrink-0 size-1.5 mr-1.5 rounded-full" style={color} />
          }

          return null
        })()}
      </Dynamic>
    )
  }

  const RenderNode = (p: { item: FlattenedNode }) => {
    const node = p.item.node
    const depth = p.item.depth
    const expanded = p.item.expanded

    const Wrapper = (props: ParentProps) => {
      if (!tooltip()) return props.children

      const parts = node.path.split("/")
      const leaf = parts[parts.length - 1] ?? node.path
      const head = parts.slice(0, -1).join("/")
      const prefix = head ? `${head}/` : ""

      const kind = () => kinds()?.get(node.path)
      const label = () => {
        const k = kind()
        if (!k) return
        if (k === "add") return "Additions"
        if (k === "del") return "Deletions"
        return "Modifications"
      }

      const ignored = () => node.type === "directory" && node.ignored

      return (
        <Tooltip
          forceMount={false}
          openDelay={2000}
          placement="bottom-start"
          class="w-full"
          contentStyle={{ "max-width": "480px", width: "fit-content" }}
          value={
            <div class="flex items-center min-w-0 whitespace-nowrap text-12-regular">
              <span
                class="min-w-0 truncate text-text-invert-base"
                style={{ direction: "rtl", "unicode-bidi": "plaintext" }}
              >
                {prefix}
              </span>
              <span class="shrink-0 text-text-invert-strong">{leaf}</span>
              <Show when={label()}>
                {(t: () => string) => (
                  <>
                    <span class="mx-1 font-bold text-text-invert-strong">•</span>
                    <span class="shrink-0 text-text-invert-strong">{t()}</span>
                  </>
                )}
              </Show>
              <Show when={ignored()}>
                <>
                  <span class="mx-1 font-bold text-text-invert-strong">•</span>
                  <span class="shrink-0 text-text-invert-strong">Ignored</span>
                </>
              </Show>
            </div>
          }
        >
          {props.children}
        </Tooltip>
      )
    }

    return (
      <Show
        when={node.type === "directory"}
        fallback={
          <Wrapper>
            <Node node={node} depth={depth} as="button" type="button" onClick={() => props.onFileClick?.(node)}>
              <div class="w-4 shrink-0" />
              <FileIcon node={node} class="text-icon-weak size-4" />
            </Node>
          </Wrapper>
        }
      >
        <Wrapper>
          <Node node={node} depth={depth} as="button" type="button" onClick={() => file.tree.toggle(node.path)}>
            <div class="size-4 flex items-center justify-center text-icon-weak">
              <Icon name={expanded ? "chevron-down" : "chevron-right"} size="small" />
            </div>
          </Node>
        </Wrapper>
      </Show>
    )
  }

  return (
    <div class={`flex flex-col gap-0.5 h-full min-h-0 ${props.class ?? ""}`}>
      <VList data={flattened()}>{(item) => <RenderNode item={item} />}</VList>
    </div>
  )
}
