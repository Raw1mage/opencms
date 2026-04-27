import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { BasicTool } from "./basic-tool"
import { ToolRegistry, type ToolProps } from "./tool-registry"
import { Markdown } from "./markdown"

interface SvgBlockArtifact {
  name: string
  svg: string
}

interface ParsedSvgBlockOutput {
  summary: string
  artifacts: SvgBlockArtifact[]
}

const SVG_BLOCK_RE = /^--- SVG: (.+?) ---$/

function parseSvgBlockOutput(output: string): ParsedSvgBlockOutput {
  const lines = output.split("\n")
  const summaryLines: string[] = []
  const artifacts: SvgBlockArtifact[] = []
  let currentName: string | null = null
  let currentSvgLines: string[] = []

  for (const line of lines) {
    const match = SVG_BLOCK_RE.exec(line)
    if (match) {
      // flush previous artifact
      if (currentName !== null) {
        artifacts.push({ name: currentName, svg: currentSvgLines.join("\n") })
      }
      currentName = match[1]
      currentSvgLines = []
    } else if (currentName !== null) {
      currentSvgLines.push(line)
    } else {
      summaryLines.push(line)
    }
  }
  // flush last artifact
  if (currentName !== null) {
    artifacts.push({ name: currentName, svg: currentSvgLines.join("\n") })
  }

  return {
    summary: summaryLines.join("\n").trim(),
    artifacts,
  }
}

export function hasSvgBlockOutput(output?: string): boolean {
  return output ? parseSvgBlockOutput(output).artifacts.length > 0 : false
}

function svgToDataUrl(svg: string): string {
  return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg.trim())))
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function downloadSvg(svg: string, filename: string) {
  downloadBlob(svg, filename, "image/svg+xml")
}

const btnClass =
  "px-2 py-1 text-11-medium text-text-dimmed hover:text-text-base hover:bg-surface-tertiary rounded transition-colors cursor-pointer"

/** Inline SVG editor — drag/move elements, edit text, delete, download edited result */
function SvgBlockEditor(props: { svg: string; filename: string; onDiscard: () => void }) {
  let containerRef: HTMLDivElement | undefined
  let selectedElement: SVGElement | null = null
  let initialTransform = { x: 0, y: 0 }
  let startMouse = { x: 0, y: 0 }
  const [hasChanges, setHasChanges] = createSignal(false)
  const [selectedTag, setSelectedTag] = createSignal<string | null>(null)

  const getTranslate = (el: SVGElement): { x: number; y: number } => {
    const transform = el.getAttribute("transform")
    if (!transform) return { x: 0, y: 0 }
    const match = /translate\(([^,]+),?\s*([^)]+)\)/.exec(transform)
    if (match) return { x: parseFloat(match[1]), y: parseFloat(match[2]) }
    return { x: 0, y: 0 }
  }

  const getSvg = () => containerRef?.querySelector("svg")

  const clearSelection = () => {
    containerRef?.querySelectorAll(".svg-editor-selected").forEach((el) => el.classList.remove("svg-editor-selected"))
    selectedElement = null
    setSelectedTag(null)
  }

  const startDrag = (evt: MouseEvent) => {
    evt.preventDefault()
    evt.stopPropagation()
    const el = evt.currentTarget as SVGElement
    clearSelection()
    selectedElement = el
    el.classList.add("svg-editor-selected")
    setSelectedTag(el.tagName)

    initialTransform = getTranslate(el)
    const svg = getSvg()
    if (!svg) return
    const CTM = svg.getScreenCTM()
    if (!CTM) return
    startMouse.x = (evt.clientX - CTM.e) / CTM.a
    startMouse.y = (evt.clientY - CTM.f) / CTM.d
  }

  const drag = (evt: MouseEvent) => {
    if (!selectedElement) return
    evt.preventDefault()
    const svg = getSvg()
    if (!svg) return
    const CTM = svg.getScreenCTM()
    if (!CTM) return
    const dx = (evt.clientX - CTM.e) / CTM.a - startMouse.x
    const dy = (evt.clientY - CTM.f) / CTM.d - startMouse.y
    selectedElement.setAttribute("transform", `translate(${initialTransform.x + dx}, ${initialTransform.y + dy})`)
    setHasChanges(true)
  }

  const endDrag = () => {
    if (selectedElement) selectedElement = null
  }

  const initInteractions = () => {
    const svg = getSvg()
    if (!svg) return
    const elements = svg.querySelectorAll("text, path, rect, circle, polygon, polyline, g")
    elements.forEach((el) => {
      if (el.tagName === "rect" && el.getAttribute("fill") === "white" && !el.getAttribute("stroke")) return
      ;(el as HTMLElement).style.cursor = "grab"
      el.addEventListener("mousedown", startDrag as EventListener)
    })
    svg.addEventListener("mousemove", drag as EventListener)
    svg.addEventListener("mouseup", endDrag)
    svg.addEventListener("mouseleave", endDrag)
  }

  const deleteSelected = () => {
    if (!selectedElement) return
    selectedElement.remove()
    selectedElement = null
    setSelectedTag(null)
    setHasChanges(true)
  }

  const startTextEdit = () => {
    if (!selectedElement || selectedElement.tagName !== "text") return
    const current = selectedElement.textContent ?? ""
    const next = prompt("Edit label:", current)
    if (next !== null && next !== current) {
      selectedElement.textContent = next
      setHasChanges(true)
    }
  }

  const handleDownload = () => {
    const content = containerRef?.innerHTML ?? ""
    downloadSvg(content, `edited_${props.filename}`)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.key === "Delete" || e.key === "Backspace") && selectedElement) {
      e.preventDefault()
      deleteSelected()
    }
    if (e.key === "Escape") clearSelection()
  }

  onMount(() => {
    if (containerRef) {
      containerRef.innerHTML = props.svg
      initInteractions()
    }
    document.addEventListener("keydown", handleKeyDown)
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
  })

  return (
    <div>
      {/* Editor Toolbar */}
      <div
        style={{
          display: "flex",
          "align-items": "center",
          gap: "0.25rem",
          padding: "0.375rem 0.75rem",
          "border-bottom": "1px solid var(--color-border-base)",
          background: "var(--color-surface-secondary)",
        }}
      >
        <span style={{ "font-size": "12px", "font-weight": "600", color: "var(--color-text-base)", "margin-right": "0.5rem" }}>
          SVG Editor
        </span>
        <div style={{ width: "1px", height: "1rem", background: "var(--color-border-base)", margin: "0 0.25rem" }} />
        <button class={btnClass} onClick={deleteSelected} title="Delete selected (Del)">
          Delete
        </button>
        <Show when={selectedTag() === "text"}>
          <button class={btnClass} onClick={startTextEdit} title="Edit text label">
            Edit Text
          </button>
        </Show>
        <div style={{ flex: "1" }} />
        <Show when={hasChanges()}>
          <span style={{ "font-size": "11px", "font-weight": "500", color: "var(--color-accent-primary)", "margin-right": "0.5rem" }}>
            Unsaved
          </span>
        </Show>
        <button class={btnClass} onClick={handleDownload} title="Download edited SVG">
          Download
        </button>
        <button class={btnClass} onClick={props.onDiscard}>
          Discard
        </button>
      </div>

      {/* SVG Canvas */}
      <div
        ref={containerRef}
        style={{
          overflow: "auto",
          padding: "0.75rem",
          display: "flex",
          "justify-content": "center",
          "align-items": "start",
          background: "white",
        }}
      />

      <style>{`
        [data-component="diagram-preview"] .svg-editor-selected {
          outline: 2px dashed var(--color-accent-primary, #3b82f6);
          outline-offset: 2px;
        }
        [data-component="diagram-preview"] svg text:hover,
        [data-component="diagram-preview"] svg rect:hover,
        [data-component="diagram-preview"] svg circle:hover,
        [data-component="diagram-preview"] svg path:hover,
        [data-component="diagram-preview"] svg polyline:hover,
        [data-component="diagram-preview"] svg polygon:hover {
          filter: brightness(0.8);
        }
      `}</style>
    </div>
  )
}

function SvgBlockPreview(props: { artifact: SvgBlockArtifact; jsonPayload?: string }) {
  const [expanded, setExpanded] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  const dataUrl = createMemo(() => svgToDataUrl(props.artifact.svg))

  const downloadJson = () => {
    if (!props.jsonPayload) return
    // Pretty-print if it's valid JSON
    let content = props.jsonPayload
    try {
      content = JSON.stringify(JSON.parse(content), null, 2)
    } catch {}
    const baseName = props.artifact.name.replace(/\.svg$/i, "")
    downloadBlob(content, `${baseName}.json`, "application/json")
  }

  return (
    <div data-component="diagram-preview" style={{ "margin-bottom": "0.5rem" }}>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          padding: "0.25rem 0",
        }}
      >
        <span
          style={{
            "font-size": "12px",
            "font-weight": "600",
            color: "var(--color-text-dimmed)",
          }}
        >
          {props.artifact.name}
        </span>
        <div style={{ display: "flex", gap: "0.25rem" }}>
          <Show when={expanded() && !editing()}>
            <button class={btnClass} onClick={() => setEditing(true)} title="Edit SVG">
              Edit
            </button>
          </Show>
          <Show when={expanded()}>
            <button class={btnClass} onClick={() => setExpanded(false)} title="Collapse">
              Collapse
            </button>
          </Show>
          <button
            class={btnClass}
            onClick={() => downloadSvg(props.artifact.svg, `${props.artifact.name}.svg`)}
            title="Download SVG"
          >
            SVG
          </button>
          <Show when={props.jsonPayload}>
            <button class={btnClass} onClick={downloadJson} title="Download JSON payload">
              JSON
            </button>
          </Show>
        </div>
      </div>
      <div
        style={{
          "max-height": expanded() ? "none" : "300px",
          overflow: "hidden",
          "border-radius": "6px",
          border: "1px solid var(--color-border-base)",
          background: "white",
          cursor: expanded() ? "default" : "pointer",
        }}
        onClick={() => { if (!expanded()) setExpanded(true) }}
      >
        <Show
          when={editing()}
          fallback={
            <div style={{ display: "flex", "justify-content": "center", padding: "0.75rem" }}>
              <img
                src={dataUrl()}
                alt={props.artifact.name}
                style={{ "max-width": "100%", height: "auto" }}
                draggable={false}
              />
            </div>
          }
        >
          <SvgBlockEditor
            svg={props.artifact.svg}
            filename={props.artifact.name}
            onDiscard={() => setEditing(false)}
          />
        </Show>
      </div>
    </div>
  )
}

// --- ToolRegistry registrations ---

function renderSvgBlockTool(props: ToolProps, config: { title: string; subtitle: () => string; jsonPayload?: () => string | undefined }) {
  const parsed = createMemo(() => (props.output ? parseSvgBlockOutput(props.output) : null))
  const hasArtifacts = createMemo(() => (parsed()?.artifacts.length ?? 0) > 0)
  const statusLabel = createMemo(() => {
    if (props.status === "running") return "rendering…"
    if (!props.output) return ""
    return parsed()?.summary.includes("ERROR") ? "error" : "ok"
  })

  return (
    <BasicTool
      icon="mcp"
      trigger={{
        title: config.title,
        subtitle: `${config.subtitle()}${statusLabel() ? " — " + statusLabel() : ""}`,
      }}
      defaultOpen={hasArtifacts()}
      hideDetails={props.hideDetails}
      forceOpen={props.forceOpen}
      locked={props.locked}
    >
      <div data-component="diagram-tool-output" style={{ padding: "0.5rem 0.75rem" }}>
        {/* Summary */}
        <Show when={parsed()?.summary}>
          {(summary) => (
            <div data-component="tool-output" data-scrollable style={{ "margin-bottom": "0.5rem" }}>
              <Markdown text={summary()} />
            </div>
          )}
        </Show>

        {/* SVG Previews */}
        <Show when={hasArtifacts()}>
          <For each={parsed()!.artifacts}>
            {(artifact) => <SvgBlockPreview artifact={artifact} jsonPayload={config.jsonPayload?.()} />}
          </For>
        </Show>
      </div>
    </BasicTool>
  )
}

export function SvgBlockTool(props: ToolProps) {
  return renderSvgBlockTool(props, {
    title: props.tool,
    subtitle: () => String(props.input?.title ?? props.input?.path ?? props.input?.diagram_type ?? "svg"),
    jsonPayload: () => (typeof props.input?.json_payload === "string" ? props.input.json_payload : undefined),
  })
}

ToolRegistry.register({
  name: "drawmiat_validate_diagram",
  render(props: ToolProps) {
    const diagramType = createMemo(() => props.input?.diagram_type ?? "diagram")

    return (
      <BasicTool
        icon="mcp"
        trigger={{
          title: "validate_diagram",
          subtitle: diagramType(),
        }}
        hideDetails={props.hideDetails}
        forceOpen={props.forceOpen}
        locked={props.locked}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <Markdown text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})
