import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"
import { useSettings } from "@/context/settings"
import { getSupportedProviderLabel } from "@/utils/provider-registry"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectModel, type ModelSelectResult } from "@/components/dialog-select-model"
import { createCronApi, type CronJob, type CronRunLogEntry } from "./api"
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
  const [timezone, setTimezone] = createSignal(DEFAULT_TIMEZONE)
  const [modelSelection, setModelSelection] = createSignal<ModelSelectResult | undefined>()
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()

  // test / output
  const [testing, setTesting] = createSignal(false)
  const [activeSessionId, setActiveSessionId] = createSignal<string>()
  const [outputError, setOutputError] = createSignal<string>()
  const [runHistoryKey, setRunHistoryKey] = createSignal(0)
  const [execLogOpen, setExecLogOpen] = createSignal(false)

  const isNew = () => params.jobId === "new"
  const hasJob = () => !!params.jobId && !isNew()

  // --- load job when route changes ---
  async function loadJob() {
    const id = params.jobId
    if (!id || id === "new") {
      setJob(undefined)
      setName("")
      setPrompt("")
      setCronExpr("*/30 * * * *")
      setTimezone(DEFAULT_TIMEZONE)
      setModelSelection(undefined)
      setDirty(false)
      setActiveSessionId(undefined)
      setOutputError(undefined)
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      const data = await api().getJob(id)
      setJob(data)
      populateForm(data)
      // Load latest run's session for output display
      const runs = await api()
        .getRuns(id, 1)
        .catch(() => [] as CronRunLogEntry[])
      if (runs[0]?.sessionId) {
        setActiveSessionId(runs[0].sessionId)
      }
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
      setTimezone(j.schedule.tz || DEFAULT_TIMEZONE)
    }
    setDirty(false)
  }

  createEffect(
    on(
      () => params.jobId,
      () => {
        void loadJob()
      },
    ),
  )

  // --- mark dirty on any field change ---
  function fieldChange<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v)
      setDirty(true)
      setError(undefined)
    }
  }

  // --- resolve model identity for save ---
  // Prefer current UI selection; fall back to the persisted job payload
  // so that edits to name/prompt/schedule don't accidentally erase model.
  function resolveModelForSave(): { model?: string; accountId?: string } {
    const sel = modelSelection()
    if (sel) {
      return {
        model: `${sel.providerID}/${sel.modelID}`,
        accountId: sel.accountID,
      }
    }
    // No explicit selection — preserve whatever was on the stored job
    const existing = job()
    if (existing?.payload.kind === "agentTurn" && existing.payload.model) {
      return {
        model: existing.payload.model,
        accountId: existing.payload.accountId,
      }
    }
    return {}
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
      const { model: modelStr, accountId } = resolveModelForSave()

      if (isNew()) {
        const created = await api().createJob({
          name: n,
          enabled: true,
          schedule: { kind: "cron", expr: c, tz: timezone().trim() || undefined },
          payload: { kind: "agentTurn", message: p, lightContext: true, model: modelStr, accountId },
          sessionTarget: "isolated",
          wakeMode: "now",
        })

        navigate(`/system/tasks/${created.id}`)
      } else {
        const j = job()
        if (!j) return
        await api().updateJob(j.id, {
          name: n,
          schedule: { kind: "cron", expr: c, tz: timezone().trim() || undefined },
          payload: { kind: "agentTurn", message: p, lightContext: true, model: modelStr, accountId },
        })

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
    setActiveSessionId(undefined)
    setOutputError(undefined)
    try {
      // Snapshot existing run IDs so we can detect the new one
      const existingRuns = await api()
        .getRuns(j.id, 5)
        .catch(() => [] as CronRunLogEntry[])
      const knownRunIds = new Set(existingRuns.map((r) => r.runId))

      await api().triggerJob(j.id)

      // Poll until a NEW run appears — set sessionId as soon as found
      const MAX_POLLS = 120
      const POLL_MS = 3000
      let run: CronRunLogEntry | undefined
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS))
        const runs = await api().getRuns(j.id, 5)
        const fresh = runs.find((r) => !knownRunIds.has(r.runId))

        // Show session output as soon as sessionId is available (even while running)
        if (fresh?.sessionId && !activeSessionId()) {
          setActiveSessionId(fresh.sessionId)
        }

        if (fresh?.status) {
          run = fresh
          break
        }
      }

      if (!run) {
        setOutputError("Timed out waiting for run to complete")
      } else if (run.status === "error") {
        setOutputError(run.error ?? "Unknown error")
      }

      setRunHistoryKey((k) => k + 1)
      setExecLogOpen(true)
      void loadJob()
    } catch (e) {
      setOutputError(e instanceof Error ? e.message : String(e))
    } finally {
      setTesting(false)
    }
  }

  // --- toggle enable/disable ---
  async function handleToggle() {
    const j = job()
    if (!j) return
    await api().updateJob(j.id, { enabled: !j.enabled })
    // visual feedback via loadJob() refresh
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
    <Show
      when={params.jobId}
      fallback={
        <div class="flex-1 flex items-center justify-center h-full">
          <div class="text-center">
            <Icon name="checklist" size="large" class="text-color-dimmed mx-auto mb-3" />
            <p class="text-14-medium text-color-dimmed">Select a task to view details</p>
            <p class="text-12-medium text-color-dimmed mt-1">or create a new one</p>
          </div>
        </div>
      }
    >
      <Show
        when={!loading()}
        fallback={
          <div class="flex-1 flex items-center justify-center h-full text-13-medium text-color-dimmed">Loading...</div>
        }
      >
        <Show
          when={hasJob() ? job() : true}
          fallback={
            <div class="flex-1 flex items-center justify-center h-full text-13-medium text-color-dimmed">
              Task not found
            </div>
          }
        >
          <div class="flex flex-col h-full overflow-hidden">
            {/* ═══ Header ═══ */}
            <div class="shrink-0 flex items-center justify-between px-4 py-2 border-b border-border-base bg-background-base">
              <div class="flex items-center gap-2">
                <Show when={hasJob()}>
                  <div
                    classList={{
                      "w-2 h-2 rounded-full": true,
                      "bg-green-400": job()?.enabled,
                      "bg-neutral-500": !job()?.enabled,
                    }}
                  />
                  <span
                    classList={{
                      "text-11-medium px-1.5 py-0.5 rounded": true,
                      "bg-green-500/15 text-green-400": job()?.enabled,
                      "bg-neutral-500/15 text-neutral-400": !job()?.enabled,
                    }}
                  >
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
                    <Icon name="arrow-right" size="small" />
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

            {/* ═══ Scrollable cards ═══ */}
            <div class="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {/* ── Prompt card ── */}
              <div class="rounded-lg border border-border-base bg-background-base">
                <div class="flex items-center gap-2 px-3 py-2 border-b border-border-weak-base">
                  <label class="text-11-semibold text-color-dimmed uppercase tracking-wider">Name</label>
                  <input
                    class="flex-1 bg-transparent text-13-medium text-color-primary focus:outline-none"
                    placeholder="e.g. Check stock alerts"
                    value={name()}
                    onInput={(e) => fieldChange(setName)(e.currentTarget.value)}
                  />
                </div>
                <textarea
                  class="w-full min-h-[100px] max-h-[300px] resize-y bg-transparent px-3 py-2 text-13-medium text-color-primary placeholder:text-color-dimmed focus:outline-none"
                  placeholder="What should the AI do on each run?"
                  value={prompt()}
                  onInput={(e) => fieldChange(setPrompt)(e.currentTarget.value)}
                />
              </div>

              {/* ── Schedule card ── */}
              <div class="rounded-lg border border-border-base bg-background-base px-3 py-2 space-y-2">
                <div class="flex items-center gap-2">
                  <label class="shrink-0 text-11-semibold text-color-dimmed uppercase tracking-wider">Schedule</label>
                  <input
                    class="w-40 bg-background-input rounded border border-border-base px-2 py-1.5 text-13-medium text-color-primary font-mono focus:outline-none focus:border-accent-base"
                    placeholder="*/30 * * * *"
                    value={cronExpr()}
                    onInput={(e) => fieldChange(setCronExpr)(e.currentTarget.value)}
                  />
                  <Select
                    options={TIMEZONE_OPTIONS}
                    current={TIMEZONE_OPTIONS.find((tz) => tz.value === timezone())}
                    value={(tz) => tz.value}
                    label={(tz) => tz.label}
                    onSelect={(tz) => {
                      if (tz) fieldChange(setTimezone)(tz.value)
                    }}
                    variant="ghost"
                    class="max-w-[200px]"
                    valueClass="truncate"
                  />
                  <span class="text-11-medium text-color-dimmed">{describeCronExpr(cronExpr())}</span>
                  <Show when={hasJob() && job()?.state.nextRunAtMs}>
                    <span class="text-11-medium text-color-dimmed">
                      · Next: {formatRelativeTime(job()!.state.nextRunAtMs!)}
                    </span>
                  </Show>
                </div>
                <div class="flex flex-wrap gap-1.5">
                  <For each={CRON_PRESETS}>
                    {(preset) => (
                      <button
                        classList={{
                          "text-11-medium rounded px-2 py-1 border transition-colors cursor-pointer": true,
                          "border-accent-base text-accent-base bg-accent-base/10": cronExpr() === preset.expr,
                          "border-border-base text-color-dimmed hover:text-color-secondary hover:border-border-base":
                            cronExpr() !== preset.expr,
                        }}
                        onClick={() => fieldChange(setCronExpr)(preset.expr)}
                      >
                        {preset.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>

              {/* ── Error banner ── */}
              <Show when={error()}>
                <div class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-12-medium text-red-400">
                  {error()}
                </div>
              </Show>

              <SessionStreamPanel
                sessionId={activeSessionId()}
                testing={testing()}
                outputError={outputError()}
                emptyText={hasJob() ? "Click Test to run this task" : "Create the task first, then test it"}
                onClear={() => {
                  setActiveSessionId(undefined)
                  setOutputError(undefined)
                }}
              />

              {/* ── Execution Log card (collapsed by default) ── */}
              <Show when={hasJob() && job()}>
                {(j) => (
                  <div class="rounded-lg border border-border-base bg-background-base overflow-hidden">
                    <div
                      class="w-full flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-background-input/50 transition-colors"
                      onClick={() => setExecLogOpen((v) => !v)}
                    >
                      <span class="text-11-semibold text-color-dimmed uppercase tracking-wider">Execution Log</span>
                      <div class="flex items-center gap-2">
                        <button
                          class="text-11-medium text-color-dimmed hover:text-color-secondary cursor-pointer"
                          onClick={(e) => {
                            e.stopPropagation()
                            setRunHistoryKey((k) => k + 1)
                          }}
                        >
                          Refresh
                        </button>
                        <Icon
                          name="chevron-down"
                          size="small"
                          class="text-color-dimmed transition-transform"
                          style={{ transform: execLogOpen() ? "rotate(180deg)" : "rotate(0deg)" }}
                        />
                      </div>
                    </div>
                    <Show when={execLogOpen()}>
                      <div
                        class="border-t border-border-weak-base px-3 py-2 overflow-y-auto resize-y"
                        style={{ "min-height": "60px", height: "160px", "max-height": "500px" }}
                        data-key={runHistoryKey()}
                      >
                        <RunHistoryPanel jobId={j().id} api={api()} />
                      </div>
                    </Show>
                  </div>
                )}
              </Show>
            </div>

            {/* ═══ Footer ═══ */}
            <div class="shrink-0 flex items-center gap-2 px-4 py-1.5 border-t border-border-weak-base">
              <TaskModelButton
                selection={modelSelection()}
                providers={globalSync.data.provider.all ?? []}
                accountFamilies={globalSync.data.account_families}
                onOpen={() => {
                  const sel = modelSelection()
                  dialog.show(() => (
                    <DialogSelectModel
                      initialProviderId={sel?.providerID}
                      initialAccountId={sel?.accountID}
                      onModelSelect={(key) => {
                        setModelSelection(key)
                        const j = job()
                        if (j) {
                          const modelStr = `${key.providerID}/${key.modelID}`
                          const existing = j.payload.kind === "agentTurn" ? j.payload : undefined
                          api()
                            .updateJob(j.id, {
                              payload: {
                                kind: "agentTurn",
                                message: existing?.message ?? "",
                                lightContext: existing?.lightContext,
                                model: modelStr,
                                accountId: key.accountID,
                              },
                            })
                            .then(() => {
                              void loadJob()
                            })
                            .catch(() => {
                              // model save failed — will show stale selection on next load
                            })
                        } else {
                          setDirty(true)
                        }
                      }}
                    />
                  ))
                }}
              />
              <Show when={hasJob() && job()}>
                {(j) => (
                  <>
                    <span class="text-11-medium text-color-dimmed">Target: {j().sessionTarget}</span>
                    <Show when={j().state.consecutiveErrors && j().state.consecutiveErrors! > 0}>
                      <span class="text-11-medium text-red-400">{j().state.consecutiveErrors} error(s)</span>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </div>
        </Show>
      </Show>
    </Show>
  )
}

const TIMEZONE_OPTIONS = [
  { value: "Asia/Taipei", label: "UTC+8 CST (Taipei)" },
  { value: "Asia/Tokyo", label: "UTC+9 JST (Tokyo)" },
  { value: "Asia/Shanghai", label: "UTC+8 CST (Shanghai)" },
  { value: "Asia/Hong_Kong", label: "UTC+8 HKT (Hong Kong)" },
  { value: "Asia/Singapore", label: "UTC+8 SGT (Singapore)" },
  { value: "Asia/Seoul", label: "UTC+9 KST (Seoul)" },
  { value: "America/New_York", label: "UTC-5 EST (New York)" },
  { value: "America/Los_Angeles", label: "UTC-8 PST (Los Angeles)" },
  { value: "America/Chicago", label: "UTC-6 CST (Chicago)" },
  { value: "Europe/London", label: "UTC+0 GMT (London)" },
  { value: "Europe/Berlin", label: "UTC+1 CET (Berlin)" },
  { value: "Australia/Sydney", label: "UTC+11 AEDT (Sydney)" },
  { value: "UTC", label: "UTC" },
]

const DEFAULT_TIMEZONE = "Asia/Taipei"

/**
 * Model selection button — replicates session footer bar style:
 * [Provider Badge] [ProviderIcon ModelName ▾] [AccountName]
 */
function TaskModelButton(props: {
  selection: ModelSelectResult | undefined
  providers: Array<{ id: string; name?: string; models: Record<string, { id: string; name: string }> }>
  accountFamilies?: Record<
    string,
    { activeAccount?: string; accounts?: Record<string, { name?: string; email?: string }> }
  >
  onOpen: () => void
}) {
  const provider = createMemo(() => {
    const sel = props.selection
    if (!sel) return undefined
    return props.providers.find((p) => p.id === sel.providerID)
  })

  const providerLabel = createMemo(() => {
    const sel = props.selection
    if (!sel) return undefined
    const id = sel.providerID
    return getSupportedProviderLabel(id) ?? provider()?.name ?? id
  })

  const modelName = createMemo(() => {
    const sel = props.selection
    if (!sel) return undefined
    const p = provider()
    const m = p?.models[sel.modelID]
    return m ? m.name.replace("(latest)", "").trim() : sel.modelID
  })

  const accountLabel = createMemo(() => {
    const sel = props.selection
    if (!sel?.accountID || !props.accountFamilies) return undefined
    const family = props.accountFamilies[sel.providerID]
    if (!family?.accounts) return sel.accountID
    const acc = family.accounts[sel.accountID] as Record<string, unknown> | undefined
    return (typeof acc?.name === "string" && acc.name) || (typeof acc?.email === "string" && acc.email) || sel.accountID
  })

  return (
    <button
      onClick={props.onOpen}
      class="inline-flex items-center gap-2 rounded border border-border-base px-3 py-2 hover:border-accent-base transition-colors cursor-pointer bg-background-input"
    >
      <Show
        when={props.selection}
        fallback={<span class="text-13-medium text-color-dimmed flex-1 text-left">Default (system rotation)</span>}
      >
        {/* Provider badge */}
        <Show when={providerLabel()}>
          <span
            class="shrink-0 text-12-medium px-1.5 py-0.5 rounded"
            style={{
              color: "var(--icon-success-base)",
              "font-weight": "600",
              "background-color": "var(--surface-success-base)",
            }}
          >
            {providerLabel()}
          </span>
        </Show>

        {/* Provider icon + model name */}
        <span class="flex items-center gap-1.5 min-w-0 flex-1">
          <Show when={props.selection?.providerID}>
            <ProviderIcon id={props.selection!.providerID} class="size-4 shrink-0" />
          </Show>
          <span class="text-13-medium text-color-primary truncate">{modelName()}</span>
          <Icon name="chevron-down" size="small" class="shrink-0 text-color-dimmed" />
        </span>

        {/* Account name */}
        <Show when={accountLabel()}>
          <span class="shrink-0 text-12-medium text-color-dimmed">{accountLabel()}</span>
        </Show>
      </Show>
    </button>
  )
}

/**
 * Renders the full session conversation (CoT, tool calls, text) using SessionTurn,
 * exactly like a regular session dialog.
 */
function TaskSessionOutput(props: { sessionId: string }) {
  const sync = useSync()
  const settings = useSettings()

  // Sync session data when sessionId changes
  createEffect(() => {
    void sync.session.sync(props.sessionId)
  })

  // Get user messages — SessionTurn renders one turn per user message
  const userMessages = createMemo(() => {
    const msgs = sync.data.message[props.sessionId]
    if (!msgs) return []
    return msgs.filter((m) => m.role === "user")
  })

  const lastUserMessageId = createMemo(() => {
    const msgs = userMessages()
    return msgs.length > 0 ? msgs[msgs.length - 1].id : undefined
  })

  return (
    <Show
      when={userMessages().length > 0}
      fallback={<div class="px-3 py-4 text-color-dimmed text-center italic text-12-medium">Loading session...</div>}
    >
      <For each={userMessages()}>
        {(msg) => (
          <SessionTurn
            variant="embedded"
            sessionID={props.sessionId}
            messageID={msg.id}
            lastUserMessageID={lastUserMessageId()}
            shellToolDefaultOpen={settings.general.shellToolPartsExpanded()}
            editToolDefaultOpen={settings.general.editToolPartsExpanded()}
            showReasoningSummaries={settings.general.showReasoningSummaries()}
          />
        )}
      </For>
    </Show>
  )
}

function SessionStreamPanel(props: {
  sessionId?: string
  testing: boolean
  outputError?: string
  emptyText: string
  onClear: () => void
}) {
  const hasOutput = () => !!props.sessionId || !!props.outputError

  return (
    <div class="rounded-lg border border-border-base bg-background-base overflow-hidden">
      <div class="flex items-center justify-between px-3 py-2 border-b border-border-weak-base">
        <span class="text-11-semibold text-color-dimmed uppercase tracking-wider">Output</span>
        <Show when={hasOutput()}>
          <button
            class="text-11-medium text-color-dimmed hover:text-color-secondary cursor-pointer"
            onClick={props.onClear}
          >
            Clear
          </button>
        </Show>
      </div>
      <div class="overflow-y-auto resize-y" style={{ "min-height": "80px", height: "240px", "max-height": "600px" }}>
        <Show when={props.testing && !props.sessionId}>
          <div class="px-3 py-4 text-color-dimmed text-center italic text-12-medium">Starting test run...</div>
        </Show>
        <Show when={!props.testing && !props.sessionId && !props.outputError}>
          <div class="px-3 py-4 text-color-dimmed text-center italic text-12-medium">{props.emptyText}</div>
        </Show>
        <Show when={props.outputError}>
          {(error) => <div class="px-3 py-2 text-red-400 text-12-medium whitespace-pre-wrap">{error()}</div>}
        </Show>
        <Show when={props.sessionId}>{(sid) => <TaskSessionOutput sessionId={sid()} />}</Show>
      </div>
    </div>
  )
}
