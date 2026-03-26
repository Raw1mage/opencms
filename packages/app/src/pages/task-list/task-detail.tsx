import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectModel, type ModelSelectResult } from "@/components/dialog-select-model"
import { createCronApi, type CronJob } from "./api"
import { describeCronExpr, formatRelativeTime, CRON_PRESETS } from "./cron-utils"
import { RunHistoryPanel } from "./run-history"

/**
 * Right panel — inline task editor + output console.
 * Handles both "view/edit existing" and "create new" modes.
 */
export function TaskDetail() {
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const navigate = useNavigate()
  const params = useParams<{ jobId?: string }>()
  const dialog = useDialog()
  const api = createMemo(() => createCronApi(globalSDK.url, globalSDK.fetch))

  // --- state ---
  const [job, setJob] = createSignal<CronJob>()
  const [loading, setLoading] = createSignal(false)

  // form fields (work for both create and edit)
  const [name, setName] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [cronExpr, setCronExpr] = createSignal("*/30 * * * *")
  const [timezone, setTimezone] = createSignal("")
  const [modelSelection, setModelSelection] = createSignal<ModelSelectResult | undefined>()
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()

  // test / output
  const [testing, setTesting] = createSignal(false)
  const [outputLines, setOutputLines] = createSignal<OutputLine[]>([])
  const [runHistoryKey, setRunHistoryKey] = createSignal(0)

  const isNew = () => params.jobId === "new"
  const hasJob = () => !!params.jobId && !isNew()

  type OutputLine = { ts: number; text: string; kind: "info" | "ok" | "error" }

  function addOutput(text: string, kind: OutputLine["kind"] = "info") {
    setOutputLines((prev) => [...prev, { ts: Date.now(), text, kind }])
  }

  // --- load job when route changes ---
  async function loadJob() {
    const id = params.jobId
    if (!id || id === "new") {
      setJob(undefined)
      setName("")
      setPrompt("")
      setCronExpr("*/30 * * * *")
      setTimezone("")
      setModelSelection(undefined)
      setDirty(false)
      setOutputLines([])
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      const data = await api().getJob(id)
      setJob(data)
      populateForm(data)
    } catch {
      setJob(undefined)
    } finally {
      setLoading(false)
    }
  }

  function populateForm(j: CronJob) {
    setName(j.name)
    const p = j.payload
    setPrompt(p.kind === "agentTurn" ? p.message : p.kind === "systemEvent" ? p.text : "")
    if (p.kind === "agentTurn" && p.model) {
      const [providerID, ...rest] = p.model.split("/")
      const modelID = rest.join("/")
      setModelSelection(providerID && modelID ? { providerID, modelID, accountID: p.accountId } : undefined)
    } else {
      setModelSelection(undefined)
    }
    if (j.schedule.kind === "cron") {
      setCronExpr(j.schedule.expr)
      setTimezone(j.schedule.tz ?? "")
    }
    setDirty(false)
  }

  createEffect(on(() => params.jobId, () => { void loadJob() }))

  // --- mark dirty on any field change ---
  function fieldChange<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setDirty(true); setError(undefined) }
  }

  // --- save (create or update) ---
  async function handleSave() {
    const n = name().trim()
    const p = prompt().trim()
    const c = cronExpr().trim()
    if (!n) return setError("Name is required")
    if (!p) return setError("Prompt is required")
    if (!c || c.split(/\s+/).length !== 5) return setError("Cron expression must be 5 fields")

    setSaving(true)
    setError(undefined)
    try {
      const sel = modelSelection()
      const modelStr = sel ? `${sel.providerID}/${sel.modelID}` : undefined
      const accountId = sel?.accountID

      if (isNew()) {
        const created = await api().createJob({
          name: n,
          enabled: true,
          schedule: { kind: "cron", expr: c, tz: timezone().trim() || undefined },
          payload: { kind: "agentTurn", message: p, lightContext: true, model: modelStr, accountId },
          sessionTarget: "isolated",
          wakeMode: "now",
        })
        addOutput(`Task "${created.name}" created`, "ok")
        navigate(`/system/tasks/${created.id}`)
      } else {
        const j = job()
        if (!j) return
        await api().updateJob(j.id, {
          name: n,
          schedule: { kind: "cron", expr: c, tz: timezone().trim() || undefined },
          payload: { kind: "agentTurn", message: p, lightContext: true, model: modelStr, accountId },
        })
        addOutput("Changes saved", "ok")
        await loadJob()
      }
      setDirty(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // --- test run ---
  async function handleTest() {
    const j = job()
    if (!j) return
    setTesting(true)
    addOutput(`Running test for "${j.name}"...`)
    try {
      await api().triggerJob(j.id)
      addOutput("Test triggered — waiting for result...", "ok")
      // Poll for the latest run result after a delay
      setTimeout(async () => {
        try {
          const runs = await api().getRuns(j.id, 1)
          if (runs.length > 0) {
            const run = runs[0]
            if (run.status === "error") {
              addOutput(`Error: ${run.error ?? "unknown"}`, "error")
            } else if (run.summary) {
              addOutput(run.summary, "ok")
            } else {
              addOutput("Run completed (no output)", "info")
            }
          }
          setRunHistoryKey((k) => k + 1)
          void loadJob()
        } catch {
          // ignore
        }
        setTesting(false)
      }, 3000)
    } catch (e) {
      addOutput(`Test failed: ${e instanceof Error ? e.message : String(e)}`, "error")
      setTesting(false)
    }
  }

  // --- toggle enable/disable ---
  async function handleToggle() {
    const j = job()
    if (!j) return
    await api().updateJob(j.id, { enabled: !j.enabled })
    addOutput(j.enabled ? "Task disabled" : "Task enabled", "ok")
    await loadJob()
  }

  // --- delete ---
  async function handleDelete() {
    const j = job()
    if (!j) return
    if (!confirm(`Delete task "${j.name}"?`)) return
    await api().deleteJob(j.id)
    navigate("/system/tasks")
  }

  // =========== RENDER ===========

  return (
    <Show when={params.jobId} fallback={
      <div class="flex-1 flex items-center justify-center h-full">
        <div class="text-center">
          <Icon name="checklist" size="large" class="text-color-dimmed mx-auto mb-3" />
          <p class="text-14-medium text-color-dimmed">Select a task to view details</p>
          <p class="text-12-medium text-color-dimmed mt-1">or create a new one</p>
        </div>
      </div>
    }>
    <Show when={!loading()} fallback={
      <div class="flex-1 flex items-center justify-center h-full text-13-medium text-color-dimmed">Loading...</div>
    }>
      <Show when={hasJob() ? job() : true} fallback={
        <div class="flex-1 flex items-center justify-center h-full text-13-medium text-color-dimmed">Task not found</div>
      }>
        <div class="flex flex-col h-full overflow-hidden">
          {/* ─── Toolbar ─── */}
          <div class="shrink-0 flex items-center justify-between px-4 py-2 border-b border-border-base bg-background-base">
            <div class="flex items-center gap-2">
              <Show when={hasJob()}>
                <div classList={{
                  "w-2 h-2 rounded-full": true,
                  "bg-green-400": job()?.enabled,
                  "bg-neutral-500": !job()?.enabled,
                }} />
                <span classList={{
                  "text-11-medium px-1.5 py-0.5 rounded": true,
                  "bg-green-500/15 text-green-400": job()?.enabled,
                  "bg-neutral-500/15 text-neutral-400": !job()?.enabled,
                }}>
                  {job()?.enabled ? "Active" : "Disabled"}
                </span>
              </Show>
              <Show when={isNew()}>
                <span class="text-13-semibold text-accent-base">New Task</span>
              </Show>
              <Show when={dirty()}>
                <span class="text-11-medium text-yellow-400 px-1.5 py-0.5 rounded bg-yellow-500/10">Unsaved</span>
              </Show>
            </div>
            <div class="flex items-center gap-1.5">
              <Show when={hasJob()}>
                <Button size="small" variant="ghost" onClick={handleTest} disabled={testing()}>
                  <Icon name="play" size="small" />
                  <span class="ml-1">{testing() ? "Running..." : "Test"}</span>
                </Button>
              </Show>
              <Button size="small" onClick={handleSave} disabled={saving() || (!dirty() && !isNew())}>
                <Icon name="check" size="small" />
                <span class="ml-1">{saving() ? "Saving..." : isNew() ? "Create" : "Save"}</span>
              </Button>
              <Show when={hasJob()}>
                <Button size="small" variant="ghost" onClick={handleToggle}>
                  {job()?.enabled ? "Disable" : "Enable"}
                </Button>
                <Button size="small" variant="ghost" onClick={handleDelete}>
                  <Icon name="trash" size="small" class="text-red-400" />
                </Button>
              </Show>
            </div>
          </div>

          {/* ─── Main scrollable body ─── */}
          <div class="flex-1 overflow-y-auto">
            {/* Form fields */}
            <div class="px-4 py-3 space-y-4 border-b border-border-weak-base">
              {/* Name */}
              <div>
                <label class="block text-11-semibold text-color-dimmed uppercase tracking-wider mb-1">Name</label>
                <input
                  class="w-full bg-background-input rounded border border-border-base px-3 py-2 text-13-medium text-color-primary focus:outline-none focus:border-accent-base"
                  placeholder="e.g. Check stock alerts"
                  value={name()}
                  onInput={(e) => fieldChange(setName)(e.currentTarget.value)}
                />
              </div>

              {/* Prompt */}
              <div>
                <label class="block text-11-semibold text-color-dimmed uppercase tracking-wider mb-1">Prompt</label>
                <textarea
                  class="w-full min-h-[100px] max-h-[250px] resize-y bg-background-input rounded border border-border-base px-3 py-2 text-13-medium text-color-primary placeholder:text-color-dimmed focus:outline-none focus:border-accent-base"
                  placeholder="What should the AI do on each run?"
                  value={prompt()}
                  onInput={(e) => fieldChange(setPrompt)(e.currentTarget.value)}
                />
              </div>

              {/* Schedule */}
              <div>
                <label class="block text-11-semibold text-color-dimmed uppercase tracking-wider mb-1">Schedule</label>
                <div class="flex gap-2">
                  <input
                    class="flex-1 bg-background-input rounded border border-border-base px-3 py-2 text-13-medium text-color-primary font-mono focus:outline-none focus:border-accent-base"
                    placeholder="*/30 * * * *"
                    value={cronExpr()}
                    onInput={(e) => fieldChange(setCronExpr)(e.currentTarget.value)}
                  />
                  <input
                    class="w-28 bg-background-input rounded border border-border-base px-2 py-2 text-12-medium text-color-secondary focus:outline-none focus:border-accent-base"
                    placeholder="Timezone"
                    value={timezone()}
                    onInput={(e) => fieldChange(setTimezone)(e.currentTarget.value)}
                  />
                </div>
                <p class="text-11-medium text-color-dimmed mt-1">{describeCronExpr(cronExpr())}</p>
                <Show when={hasJob() && job()?.state.nextRunAtMs}>
                  <p class="text-11-medium text-color-dimmed mt-0.5">
                    Next: {formatRelativeTime(job()!.state.nextRunAtMs!)}
                  </p>
                </Show>
              </div>

              {/* Model */}
              <div>
                <label class="block text-11-semibold text-color-dimmed uppercase tracking-wider mb-1">Model</label>
                <TaskModelButton
                  selection={modelSelection()}
                  providers={globalSync.data.provider.all ?? []}
                  onOpen={() => {
                    const sel = modelSelection()
                    dialog.show(() => (
                      <DialogSelectModel
                        initialProviderId={sel?.providerID}
                        initialAccountId={sel?.accountID}
                        onModelSelect={(key) => {
                          setModelSelection(key)
                          setDirty(true)
                        }}
                      />
                    ))
                  }}
                />
              </div>

              {/* Schedule Presets */}
              <div class="flex flex-wrap gap-1.5">
                <For each={CRON_PRESETS}>
                  {(preset) => (
                    <button
                      classList={{
                        "text-11-medium rounded px-2 py-1 border transition-colors cursor-pointer": true,
                        "border-accent-base text-accent-base bg-accent-base/10": cronExpr() === preset.expr,
                        "border-border-base text-color-dimmed hover:text-color-secondary hover:border-border-base": cronExpr() !== preset.expr,
                      }}
                      onClick={() => fieldChange(setCronExpr)(preset.expr)}
                    >
                      {preset.label}
                    </button>
                  )}
                </For>
              </div>

              <Show when={error()}>
                <div class="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-12-medium text-red-400">
                  {error()}
                </div>
              </Show>
            </div>

            {/* ─── Output Console ─── */}
            <div class="px-4 py-3 border-b border-border-weak-base">
              <div class="flex items-center justify-between mb-2">
                <span class="text-11-semibold text-color-dimmed uppercase tracking-wider">Output</span>
                <Show when={outputLines().length > 0}>
                  <button
                    class="text-11-medium text-color-dimmed hover:text-color-secondary cursor-pointer"
                    onClick={() => setOutputLines([])}
                  >
                    Clear
                  </button>
                </Show>
              </div>
              <div class="bg-background-input rounded border border-border-base min-h-[80px] max-h-[250px] overflow-y-auto font-mono text-12-medium">
                <Show when={outputLines().length === 0}>
                  <div class="px-3 py-4 text-color-dimmed text-center italic">
                    {hasJob() ? "Click Test to run this task and see output here" : "Create the task first, then test it"}
                  </div>
                </Show>
                <Show when={outputLines().length > 0}>
                  <div class="px-3 py-2 space-y-0.5">
                    <For each={outputLines()}>
                      {(line) => (
                        <div classList={{
                          "whitespace-pre-wrap break-words py-0.5": true,
                          "text-color-secondary": line.kind === "info",
                          "text-green-400": line.kind === "ok",
                          "text-red-400": line.kind === "error",
                        }}>
                          <span class="text-color-dimmed text-11-medium mr-2 select-none">
                            {new Date(line.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                          </span>
                          {line.text}
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </div>

            {/* ─── Execution History (existing jobs only) ─── */}
            <Show when={hasJob() && job()}>
              {(j) => (
                <div class="px-4 py-3">
                  <div class="flex items-center justify-between mb-2">
                    <span class="text-11-semibold text-color-dimmed uppercase tracking-wider">Execution Log</span>
                    <button
                      class="text-11-medium text-color-dimmed hover:text-color-secondary cursor-pointer"
                      onClick={() => setRunHistoryKey((k) => k + 1)}
                    >
                      Refresh
                    </button>
                  </div>
                  <div data-key={runHistoryKey()}>
                    <RunHistoryPanel jobId={j().id} api={api()} />
                  </div>
                </div>
              )}
            </Show>
          </div>

          {/* ─── Job metadata footer (existing jobs only) ─── */}
          <Show when={hasJob() && job()}>
            {(j) => (
              <div class="shrink-0 flex items-center gap-4 px-4 py-1.5 border-t border-border-weak-base text-11-medium text-color-dimmed">
                <Show when={modelSelection()}>
                  {(sel) => <span>Model: {sel().providerID}/{sel().modelID}{sel().accountID ? ` (${sel().accountID})` : ""}</span>}
                </Show>
                <span>Target: {j().sessionTarget}</span>
                <Show when={j().state.consecutiveErrors && j().state.consecutiveErrors! > 0}>
                  <span class="text-red-400">{j().state.consecutiveErrors} error(s)</span>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </Show>
    </Show>
  )
}

/**
 * Model selection button — shows current selection and opens the full model manager dialog.
 */
function TaskModelButton(props: {
  selection: ModelSelectResult | undefined
  providers: Array<{ id: string; name?: string; models: Record<string, { id: string; name: string }> }>
  onOpen: () => void
}) {
  const displayLabel = createMemo(() => {
    const sel = props.selection
    if (!sel) return "Default (system)"
    const provider = props.providers.find((p) => p.id === sel.providerID)
    const providerName = provider?.name ?? sel.providerID
    const model = provider?.models[sel.modelID]
    const modelName = model ? model.name.replace("(latest)", "").trim() : sel.modelID
    const accountSuffix = sel.accountID ? ` · ${sel.accountID}` : ""
    return `${providerName} / ${modelName}${accountSuffix}`
  })

  return (
    <button
      onClick={props.onOpen}
      class="w-full flex items-center justify-between bg-background-input rounded border border-border-base px-3 py-2 text-13-medium text-color-primary hover:border-accent-base transition-colors cursor-pointer"
    >
      <span class="truncate">{displayLabel()}</span>
      <Icon name="chevron-right" size="small" class="text-color-dimmed shrink-0 ml-2" />
    </button>
  )
}
