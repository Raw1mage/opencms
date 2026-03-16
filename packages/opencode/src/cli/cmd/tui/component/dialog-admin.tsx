import {
  createEffect,
  createMemo,
  createSignal,
  createResource,
  Show,
  For,
  onMount,
  onCleanup,
  ErrorBoundary,
} from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { map, pipe, entries, filter, sortBy } from "remeda"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider } from "./dialog-provider"
import { DialogAccount } from "./dialog-account"
import { useKeybind } from "../context/keybind"
import { useTheme } from "@tui/context/theme"
import { RequestMonitor } from "@/account/monitor"
import { iife } from "@/util/iife"
import { Account } from "@/account"
import { Keybind } from "@/util/keybind"
import { ModelsDev } from "@/provider/models"
import {
  buildCanonicalProviderRows,
  resolveCanonicalRuntimeProvider,
  resolveCanonicalRuntimeProviderByKey,
} from "@/provider/canonical-family-source"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogProvider as DialogProviderList } from "./dialog-provider"
import { DialogProviderManualAdd } from "./dialog-provider-manual-add"
import { useToast } from "@tui/ui/toast"
// Account management now uses Account module exclusively (accounts.json as single source of truth)
import { useKeyboard } from "@opentui/solid"
import { TextAttributes, TextareaRenderable, type KeyEvent } from "@opentui/core"
import { useTextareaKeybindings } from "../component/textarea-keybindings"
import { selectedForeground } from "@tui/context/theme"
import { Locale } from "@/util/locale"
import { debugCheckpoint, debugSpan } from "@/util/debug"
import { useExit } from "@tui/context/exit"
import { DialogModelProbe } from "./dialog-model-probe"
import { getRateLimitTracker } from "@/account/rotation"
import { RateLimitEvent } from "@/account/rate-limit-judge"
import { Bus } from "@/bus"
import { getModelRPDLimit } from "@/account/limits"
import { Provider } from "@/provider/provider"
import { probeModelAvailability } from "../util/model-probe"
import { Auth } from "@/auth"
import { formatOpenAIQuotaDisplay, formatRequestMonitorQuotaDisplay, getQuotaHintsForAccounts } from "@/account/quota"
import { shouldAutoOpenProvidersPage } from "./dialog-admin-auto-open"
import { useRoute } from "@tui/context/route"

type DialogAdminOption = DialogSelectOption<unknown> & {
  coreId?: string
  coreProviderKey?: string
  category?: string
}

type ProviderSelectionValue = {
  providerKey: string
}

type ModelSelectionValue = {
  providerId: string
  modelID: string
  origin?: "recent" | "favorite"
}

function asDialogAdminOption(option: DialogSelectOption<unknown> | undefined): DialogAdminOption {
  return option as DialogAdminOption
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function asProviderSelectionValue(value: unknown): ProviderSelectionValue | undefined {
  if (!isObjectRecord(value)) return undefined
  // Accept legacy `family` payloads while normalizing local handling to providerKey semantics.
  const providerKey =
    typeof value.providerKey === "string"
      ? value.providerKey
      : typeof value.family === "string"
        ? value.family
        : undefined
  if (!providerKey) return undefined
  return {
    providerKey,
  }
}

function asModelSelectionValue(value: unknown): ModelSelectionValue | undefined {
  if (!isObjectRecord(value)) return undefined
  if (typeof value.providerId !== "string" || typeof value.modelID !== "string") return undefined
  const origin = value.origin === "recent" || value.origin === "favorite" ? value.origin : undefined
  return {
    providerId: value.providerId,
    modelID: value.modelID,
    origin,
  }
}

// Helper to check connectivity
function useConnected() {
  const sync = useSync()
  return createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
}

export type DialogAdminProps = {
  targetProviderID?: string
}

export function DialogAdmin(props: DialogAdminProps = {}) {
  debugCheckpoint("admin", "DialogAdmin init")
  const MIN_DIALOG_WIDTH = 85
  const route = useRoute()
  const currentSessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const keybind = useKeybind()
  const exit = useExit()
  const theme = useTheme().theme
  const [ref, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [showHidden, setShowHidden] = createSignal(false)
  const [googleModels, setGoogleModels] = createSignal<{ id: string; title: string }[]>([])
  const [googleModelsLoading, setGoogleModelsLoading] = createSignal(false)
  const [googleModelError, setGoogleModelError] = createSignal<string | null>(null)
  const [googleModelsLoaded, setGoogleModelsLoaded] = createSignal(false)
  const probePrompt = "say hi"
  const probeTimeoutMs = 10_000
  const [quotaRefresh, setQuotaRefresh] = createSignal(0)
  const configRecord = createMemo(() => (sync.data.config as Record<string, unknown> | undefined) ?? {})
  const disabledProviders = createMemo(() => {
    const raw = configRecord().disabled_providers
    if (!Array.isArray(raw)) return new Set<string>()
    return new Set(raw.filter((item): item is string => typeof item === "string"))
  })
  const [optimisticDisabledProviders, setOptimisticDisabledProviders] = createSignal<Set<string> | undefined>(undefined)
  const effectiveDisabledProviders = createMemo(() => optimisticDisabledProviders() ?? disabledProviders())
  const isProviderDisabled = (providerKey: string) => effectiveDisabledProviders().has(providerKey)
  const setProviderDisabled = (providerKey: string, disabled: boolean) => {
    const next = new Set(effectiveDisabledProviders())
    if (disabled) next.add(providerKey)
    else next.delete(providerKey)
    setOptimisticDisabledProviders(next)
    void (async () => {
      try {
        await sdk.client.global.config.update(
          {
            config: {
              disabled_providers: [...next],
            },
          },
          { throwOnError: true },
        )
        await sync.bootstrap()
      } catch (error) {
        setOptimisticDisabledProviders(undefined)
        toast.show({
          message: `Failed to update provider "${providerKey}"`,
          variant: "error",
          duration: 2000,
        })
      }
    })()
  }
  const toggleProviderEnabledVisible = (providerKey: string) => {
    const currentlyDisabled = isProviderDisabled(providerKey)
    if (!currentlyDisabled) {
      setProviderDisabled(providerKey, true)
      toast.show({
        message: `Provider "${providerKey}" disabled`,
        variant: "info",
        duration: 2000,
      })
      return
    }
    setProviderDisabled(providerKey, false)
    toast.show({
      message: `Provider "${providerKey}" enabled`,
      variant: "info",
      duration: 2000,
    })
  }
  const toggleProviderFromOption = (option: DialogSelectOption<unknown> | undefined) => {
    const adminOption = asDialogAdminOption(option)
    const providerSelection = asProviderSelectionValue(adminOption.value)
    if (!providerSelection || adminOption.category !== "Providers") {
      toast.show({
        message: "Select a provider first",
        variant: "warning",
        duration: 2000,
      })
      return
    }
    toggleProviderEnabledVisible(providerSelection.providerKey)
  }

  // Navigation State
  // steps: root -> account_select -> model_select
  const [step, setStep] = createSignal<"root" | "account_select" | "model_select">("root")
  const pages = ["activities", "providers"] as const
  type Page = (typeof pages)[number]
  const [page, setPage] = createSignal<Page>("activities")
  const [selectedProviderKey, setSelectedProviderKey] = createSignal<string | null>(null)
  const [selectedAccountID, setSelectedAccountID] = createSignal<string | null>(null)

  // This tracks the provider ID that models.ts/sync system naturally understands.
  const [selectedProviderID, setSelectedProviderID] = createSignal<string | null>(null)
  const [lockBack, setLockBack] = createSignal(false)
  const [prevStep, setPrevStep] = createSignal(step())

  // Track when a sub-dialog was recently closed to prevent goBack from triggering
  // Use both a flag and timestamp for maximum reliability
  let dialogClosedFlag = false
  let dialogClosedAt = 0
  const DIALOG_CLOSE_DEBOUNCE_MS = 200 // Increased from 100ms for reliability

  const markDialogClosed = () => {
    dialogClosedFlag = true
    dialogClosedAt = Date.now()
    // Reset flag after longer delay to handle any edge cases
    setTimeout(() => {
      dialogClosedFlag = false
    }, DIALOG_CLOSE_DEBOUNCE_MS + 50)
  }

  const wasDialogRecentlyClosed = () => {
    // Check both the flag and the timestamp for maximum reliability
    if (dialogClosedFlag) return true
    return Date.now() - dialogClosedAt < DIALOG_CLOSE_DEBOUNCE_MS
  }
  const [currentOption, setCurrentOption] = createSignal<DialogSelectOption<unknown> | null>(null)
  const [activitySort, setActivitySort] = createSignal<"usage" | "provider" | "model">("usage")
  const [didAutoOpenProviders, setDidAutoOpenProviders] = createSignal(false)

  const menuLabel = () => {
    const s = step()
    if (s === "root") return "root"
    if (s === "account_select") return "account_select"
    if (s === "model_select") return "model_select"
    return s
  }

  const formatKey = (evt: KeyEvent) => Keybind.toString(keybind.parse(evt))

  const logKey = (evt: KeyEvent, action: string, result: string) => {
    const option = currentOption()
    debugCheckpoint("admin.keytrace", "key", {
      tui: "/admin",
      page: page(),
      menu: menuLabel(),
      option: option?.title ?? "",
      key: formatKey(evt),
      action,
      result,
    })
  }

  const setStepLogged = (next: Parameters<typeof setStep>[0], reason: string) => {
    const from = step()
    debugCheckpoint("admin", "set step", { from, to: next, reason })
    setStep(next)
    debugCheckpoint("admin", "set step done", { now: step(), reason })
  }

  const setPageLogged = (next: Page, reason: string) => {
    const from = page()
    if (from === next) return
    debugCheckpoint("admin", "set page", { from, to: next, reason })
    setPage(next)
    setStep("root")
    setSelectedProviderKey(null)
    setSelectedProviderID(null)
  }

  onMount(() => {
    dialog.setSize("xlarge")
    debugCheckpoint("admin", "mount", { step: step(), providerKey: selectedProviderKey() })
    setQuotaRefresh((v) => v + 1)
  })

  onCleanup(() => {
    debugCheckpoint("admin", "cleanup", { step: step(), providerKey: selectedProviderKey() })
  })

  createEffect(() => {
    const next = step()
    const prev = prevStep()
    if (next === prev) return
    debugCheckpoint("admin", "step change", {
      from: prev,
      to: next,
      providerKey: selectedProviderKey(),
      provider: selectedProviderID(),
    })
    setPrevStep(next)
  })

  createEffect(() => {
    const stats = activityData().stats
    if (
      !shouldAutoOpenProvidersPage({
        didAutoOpenProviders: didAutoOpenProviders(),
        targetProviderID: props.targetProviderID,
        page: page(),
        step: step(),
        activityTotal: stats.total,
      })
    )
      return
    debugCheckpoint("admin", "auto open providers page", { reason: "empty activities" })
    setDidAutoOpenProviders(true)
    setPageLogged("providers", "empty activities auto-open")
  })

  const openGoogleAdd = () => {
    debugCheckpoint("admin", "open google add dialog")
    dialog.push(
      () => (
        <DialogGoogleApiAdd
          onCancel={() => {
            markDialogClosed()
            debugCheckpoint("admin", "google add cancel")
            dialog.pop()
            forceRefresh()
          }}
          onSaved={() => {
            markDialogClosed()
            debugCheckpoint("admin", "google add saved")
            dialog.pop()
            forceRefresh()
          }}
        />
      ),
      markDialogClosed,
    )
  }

  useKeyboard((evt: KeyEvent) => {
    if (keybind.match("app_exit", evt)) {
      debugCheckpoint("admin", "exit", { key: Keybind.toString(keybind.parse(evt)) })
      evt.preventDefault()
      evt.stopPropagation()
      exit()
      return
    }
    const s = step()
    if (evt.name === "return") {
      logKey(evt, "select option", "attempted")
    } else if (evt.name === "left" || evt.name === "escape" || evt.name === "esc") {
      logKey(evt, "goBack", "attempted")
    } else if (Keybind.match(Keybind.parse("a")[0], keybind.parse(evt))) {
      logKey(evt, "add", "attempted")
    } else if (Keybind.match(Keybind.parse("delete")[0], keybind.parse(evt))) {
      logKey(evt, "delete", "attempted")
    } else if (Keybind.match(Keybind.parse("insert")[0], keybind.parse(evt))) {
      logKey(evt, "unhide", "attempted")
    } else if (Keybind.match(Keybind.parse("f")[0], keybind.parse(evt))) {
      logKey(evt, "favorite", "attempted")
    } else if (Keybind.match(Keybind.parse("s")[0], keybind.parse(evt))) {
      logKey(evt, "show hidden", "attempted")
    } else {
      logKey(evt, "none", "ignored")
    }

    if (s === "account_select" && selectedProviderKey() === "google-api") {
      const parsed = keybind.parse(evt)
      debugCheckpoint("admin.key", "event", {
        name: evt.name,
        ctrl: evt.ctrl,
        meta: evt.meta,
        shift: evt.shift,
        super: evt.super,
        parsed,
        step: step(),
        providerKey: selectedProviderKey(),
      })
    }
    if (evt.name !== "a") return
    if (evt.ctrl || evt.meta || evt.super) return
    if (step() !== "account_select") return
    if (selectedProviderKey() !== "google-api") return
    evt.preventDefault()
    evt.stopPropagation()
    debugCheckpoint("admin", "google add keybind", { step: step(), providerKey: selectedProviderKey() })
    openGoogleAdd()
  })

  createEffect(() => {
    if (step() !== "account_select") return
    if (selectedProviderKey() !== "google-api") return
    debugCheckpoint("admin", "enter google account list")
  })

  const lockBackOnce = () => {
    setLockBack(true)
    setTimeout(() => setLockBack(false), 200)
  }

  const [refreshSignal, setRefreshSignal] = createSignal(0)
  const forceRefresh = () => setRefreshSignal((s) => s + 1)

  const [coreAll] = createResource(refreshSignal, async () => {
    try {
      // Refresh from disk to get latest account data
      await Account.refresh()
      return await Account.listAll()
    } catch (e) {
      return {}
    }
  })
  // Load all providers from models.dev for Show All mode
  const [modelsDevData] = createResource(async () => {
    try {
      return await ModelsDev.get()
    } catch (e) {
      return {}
    }
  })

  const [activityTick, setActivityTick] = createSignal(0)
  const activityInterval = setInterval(() => {
    RequestMonitor.get()
      .sync()
      .catch(() => {})
    setActivityTick((t) => t + 1)
  }, 1000)
  onCleanup(() => clearInterval(activityInterval))

  // @event_20260216_phase5 — Bus-driven instant rate limit updates
  // Subscribe to RateLimitEvent so the activity panel refreshes immediately
  // when a rate limit is detected or cleared, instead of waiting for the 1s poll.
  const unsubDetected = Bus.subscribe(RateLimitEvent.Detected, () => {
    setActivityTick((t) => t + 1)
    // Also trigger quota refresh so cockpit/Codex data stays current
    setQuotaRefresh((t) => t + 1)
  })
  const unsubCleared = Bus.subscribe(RateLimitEvent.Cleared, () => {
    setActivityTick((t) => t + 1)
  })
  onCleanup(() => {
    unsubDetected()
    unsubCleared()
  })

  const [activityProviders] = createResource<Record<string, Provider.Info>>(() => Provider.list().catch(() => ({})))
  const [activityAccounts] = createResource(refreshSignal, async () => {
    try {
      await Account.refresh()
      return await Account.listAll()
    } catch (e) {
      return {}
    }
  })
  const [codexQuota] = createResource(quotaRefresh, async () => {
    try {
      const accounts = await Account.list("openai")
      const ids = Object.entries(accounts)
        .filter(([, info]) => info.type === "subscription")
        .map(([id]) => id)
      return await getQuotaHintsForAccounts({ providerId: "openai", accountIds: ids, format: "admin" })
    } catch (error) {
      debugCheckpoint("admin.quota", "codex fetch error", { error: String(error) })
      return {}
    }
  })

  const connected = useConnected()
  createEffect(() => {
    const optimistic = optimisticDisabledProviders()
    if (!optimistic) return
    const persisted = disabledProviders()
    if (optimistic.size !== persisted.size) return
    for (const id of optimistic) {
      if (!persisted.has(id)) return
    }
    setOptimisticDisabledProviders(undefined)
  })
  createEffect(() => {
    const currentStep = step()
    const pid = selectedProviderID()
    refreshSignal()
    if (currentStep !== "model_select" || !pid) return
    if (providerKeyFromId(pid) !== "google-api") return
    if (googleModelsLoaded()) return
    loadGoogleModels()
  })

  const providerKeyFromId = (id: string) => {
    const parsed = Account.parseProvider(id)
    if (parsed) return parsed
    if (id === "opencode" || id.startsWith("opencode-")) return "opencode"
    return undefined
  }

  onMount(() => {
    if (!props.targetProviderID) return
    const targetProviderKey = providerKeyFromId(props.targetProviderID)
    if (targetProviderKey) setSelectedProviderKey(targetProviderKey)
    setSelectedProviderID(props.targetProviderID)
    setPage("providers")
    setStep("model_select")
  })

  const label = (name: string, id: string) => {
    return Account.getProviderLabel(providerKeyFromId(id) || id)
  }

  function isFreeCost(info: { cost?: { input?: number; output?: number } }) {
    const cost = info.cost
    if (!cost) return false
    const input = cost.input ?? 0
    const output = cost.output ?? 0
    return input === 0 && output === 0
  }

  // Check if a model should show "Free" label
  // Subscription-based accounts (OpenAI Plus, Anthropic Pro/Max) are NOT free
  // even if the API cost is 0 - they're part of a paid subscription with quotas
  function shouldShowFree(providerId: string, modelInfo: { cost?: { input?: number; output?: number } }): boolean {
    // Only opencode provider models are truly free
    if (providerId === "opencode") {
      return isFreeCost(modelInfo)
    }

    // For other providers, check if the active account is subscription-based
    const providerKey = Account.parseFamily(providerId)
    if (!providerKey) return false

    const providerData = coreAll()?.[providerKey]
    const activeAccountId = providerData?.activeAccount
    const activeAccountInfo = activeAccountId ? providerData?.accounts?.[activeAccountId] : undefined

    // If using a subscription account, models are NOT free (quota-based)
    if (activeAccountInfo?.type === "subscription") {
      return false
    }

    // For API accounts, check the actual cost
    return isFreeCost(modelInfo)
  }

  // @event_20260216_quota_consolidation — Codex helpers moved to @/account/quota/openai.ts
  // clampPercentage, CodexTokenResponse, parseCodexJwtClaims, extractAccountIdFromClaims,
  // extractAccountIdFromTokens, refreshCodexAccessToken now imported from @/account/quota

  /**
   * Format the Status column for a model row.
   *
   * @event_20260216_phase5 — Priority-based status display
   *
   * Decision tree (first match wins):
   *
   *   Priority 1: Cooldown (rate-limited)
   *   ├── isRateLimited + waitMs > 0  → "⏳ Xm"       (from RateLimitTracker 3D entry)
   *   ├── isRateLimited (no waitMs)   → "0%"           (rate-limited but no ETA)
   *   └── cockpit resetTime (AG only) → "⏳ Xm"        (quota exhausted, real reset from cockpit)
   *
   *   Priority 2: Usage info (provider-specific)
   *   ├── OpenAI (Codex)              → "5H:XX% WK:XX%" (hourly + weekly remaining)
   *   ├── Antigravity (cockpit)       → "XX%"           (remainingFraction from quota group)
   *   ├── Gemini (RequestMonitor)     → "XX% (used/rpd)" (RPD remaining percentage)
   *   └── Others                      → "--" or undefined
   *
   * Called from:
   *   - activityData memo    → isRateLimited=false (cooldown already handled by 3D check)
   *   - modelSelectItems     → isRateLimited=true/false (carries provider-level rate limit info)
   */
  function formatQuotaFooter(
    accountId: string,
    providerId: string,
    modelID: string,
    displayName: string | undefined,
    fallbackFree: boolean,
    isRateLimited?: boolean,
    waitMs?: number,
  ): string | undefined {
    const providerKey = providerKeyFromId(providerId)

    // ──────────────────────────────────────────────────────────
    // Priority 1: Cooldown display (rate-limited state)
    // ──────────────────────────────────────────────────────────

    if (isRateLimited) {
      if (providerKey === "openai" || providerId === "openai") {
        if (waitMs && waitMs > 0) return `⏳ ${formatWait(waitMs)}`
        return "5H:0% WK:0%"
      }
      if (waitMs && waitMs > 0) return `⏳ ${formatWait(waitMs)}`
      return "0%"
    }

    // ──────────────────────────────────────────────────────────
    // Priority 2: Usage info (provider-specific)
    // ──────────────────────────────────────────────────────────

    // OpenAI: Codex 5-hour + weekly usage from chatgpt.com/backend-api/wham/usage
    if (providerKey === "openai" || providerId === "openai") {
      const quotaMap = codexQuota()
      return quotaMap?.[accountId] ?? formatOpenAIQuotaDisplay(undefined, "admin")
    }

    // Gemini: RPD remaining from local RequestMonitor
    if (providerKey === "google-api" || providerKey === "gemini-cli") {
      const monitor = RequestMonitor.get()
      const stats = monitor.getStats(providerId, accountId || "unknown", modelID)
      const limits = monitor.getModelLimits(providerId, modelID)
      return formatRequestMonitorQuotaDisplay(stats, limits)
    }

    // Unknown provider — no quota info available
    return undefined
  }

  const owner = (provider: { id: string; name: string; email?: string }) => {
    const providerKey = providerKeyFromId(provider.id)
    if (!providerKey) return undefined

    // Agnostic owner fallback
    const info = {
      type: "subscription",
      name: provider.name,
      email: provider.email,
    }
    const display = Account.getDisplayName(provider.id, info as any, providerKey as string)
    return display || undefined
  }

  const currentSessionModel = createMemo(() => local.model.current(currentSessionID()))
  const currentSessionAccountId = createMemo(() => local.model.currentAccountId(currentSessionID()))
  const currentSessionProviderKey = createMemo(() => {
    const providerId = currentSessionModel()?.providerId
    if (!providerId) return undefined
    return providerKeyFromId(providerId) ?? providerId
  })

  const effectiveAccountIdForProviderKey = (providerKey?: string | null) => {
    if (!providerKey) return undefined
    const selected = selectedAccountID()
    if (selected) return selected
    if (currentSessionProviderKey() === providerKey && currentSessionAccountId()) return currentSessionAccountId()
    return coreAll()?.[providerKey]?.activeAccount
  }

  const resolveGoogleApiKey = async () => {
    return debugSpan("admin.google", "resolve api key", {}, async () => {
      try {
        const accounts = await Account.list("google-api")
        const activeId = await Account.getActive("google-api")
        const pickKey = (id?: string) => {
          if (!id) return null
          const info = accounts[id]
          if (info?.type === "api") return info.apiKey
          return null
        }
        const activeKey = pickKey(activeId)
        if (activeKey) return activeKey
        for (const info of Object.values(accounts)) {
          if (info.type === "api") return info.apiKey
        }
        return null
      } catch (error) {
        console.error("Failed to resolve Google API key", error)
        return null
      }
    })
  }

  const probeAndSelectModel = (providerId: string, modelID: string, accountId?: string, origin?: string) => {
    // Skip probe - directly select the model
    debugCheckpoint("admin", "model selected (probe skipped)", {
      provider: providerId,
      model: modelID,
      accountId,
      origin,
    })
    local.model.set(
      { providerId: providerId, modelID: modelID, accountId },
      { recent: true, skipValidation: true, announce: true, interrupt: true, syncSessionExecution: true },
      currentSessionID(),
    )
    dialog.clear()
  }

  // Whitelist of Google API models to show (exact model IDs)
  // User-specified list from AI Studio (official model IDs)
  const GOOGLE_MODEL_WHITELIST = [
    // Gemini 3 (Latest)
    "gemini-3-pro",
    "gemini-3-flash",
    // Gemini 2.5 (Stable)
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-image",
    // Gemini 2.0
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    // Gemini 1.5
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    // Latest Aliases
    "gemini-1.5-pro-latest",
    "gemini-1.5-flash-latest",
    // Specialized
    "text-embedding-004",
    "aqa",
    "gemini-1.0-pro",
  ]

  const isGoogleModelWhitelisted = (id: string) => {
    const lower = id.toLowerCase()
    return GOOGLE_MODEL_WHITELIST.some((pattern) => lower.includes(pattern.toLowerCase()))
  }

  const loadGoogleModels = async (force = false) => {
    if (googleModelsLoading()) return
    if (!force && googleModelsLoaded()) return
    setGoogleModelsLoaded(true)
    return debugSpan("admin.google", "load models", {}, async () => {
      const key = await resolveGoogleApiKey()
      if (!key) {
        setGoogleModels([])
        setGoogleModelError(null)
        return
      }
      setGoogleModelError(null)
      setGoogleModelsLoading(true)
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
          {
            signal: AbortSignal.timeout(15_000),
          },
        )
        if (!response.ok) {
          setGoogleModelError(`HTTP ${response.status}`)
          return
        }
        const data = await response.json()
        const modelList = Array.isArray(data.models) ? data.models : []
        const normalized = modelList
          .map((model: unknown) => {
            const item = isObjectRecord(model) ? model : {}
            const rawName = typeof item.name === "string" ? item.name : ""
            const id = rawName.replace(/^models\//, "")
            const title = typeof item.displayName === "string" ? item.displayName : id || rawName
            if (!id) return null
            return { id, title }
          })
          .filter(Boolean)
          .filter((m: { id: string; title: string }) => isGoogleModelWhitelisted(m.id)) as {
          id: string
          title: string
        }[]
        setGoogleModels(normalized)
      } catch (error) {
        setGoogleModelError(error instanceof Error ? error.message : String(error))
      } finally {
        setGoogleModelsLoading(false)
      }
    })
  }

  // Group providers by provider key from SYNC data (for Level 1 list)
  const groupedProviders = createMemo(() => {
    const groups = new Map<string, any[]>()
    for (const p of sync.data.provider) {
      const providerKey = providerKeyFromId(p.id)
      if (!providerKey) continue
      if (!groups.has(providerKey)) groups.set(providerKey, [])
      groups.get(providerKey)!.push(p)
    }
    return groups
  })

  const canonicalProviders = createMemo(() =>
    buildCanonicalProviderRows({
      accountFamilies: coreAll() ?? {},
      connectedProviderIds: sync.data.provider.map((provider) => provider.id),
      modelsDevProviderIds: Object.keys(modelsDevData() ?? {}),
      disabledProviderIds: Array.from(effectiveDisabledProviders()),
      excludedFamilies: ["google"],
    }),
  )

  const syncProvidersForProviderKey = (providerKey: string) =>
    sync.data.provider.filter((provider) => providerKeyFromId(provider.id) === providerKey)

  const selectedRuntimeProvider = createMemo(() => {
    const currentProviderId = selectedProviderID()
    const providerKey = selectedProviderKey() ?? (currentProviderId ? providerKeyFromId(currentProviderId) : undefined)
    if (!providerKey) return undefined
    return resolveCanonicalRuntimeProvider({
      family: providerKey,
      activeAccountId: effectiveAccountIdForProviderKey(providerKey),
      providers: syncProvidersForProviderKey(providerKey),
    })
  })

  const activityData = createMemo(() => {
    activityTick()
    debugCheckpoint("admin.activities", "snapshot", { tick: activityTick() })

    const rateLimitTracker = getRateLimitTracker()
    const rateLimits3D = rateLimitTracker.getSnapshot3D()

    const providerMap = activityProviders() ?? {}
    const accountMap = activityAccounts() ?? {}
    const favorites = connected() ? local.model.favorite() : []
    const recentList = local.model.recent()
    const recentRanks = new Map<string, number>()
    for (let i = 0; i < recentList.length; i += 1) {
      const item = recentList[i]
      recentRanks.set(`${item.providerId}:${item.modelID}`, i)
    }
    const getRecentRank = (providerId: string, modelId: string) => {
      const rank = recentRanks.get(`${providerId}:${modelId}`)
      return typeof rank === "number" ? rank : Number.MAX_SAFE_INTEGER
    }

    const items: Array<{
      value: string
      title: string
      description: string
      category: string
      footer: string
      truncate?: "none" | "ellipsis"
    }> = []

    const modelLimits = new Map<string, { waitMs: number; reason: string }>()
    const providerLimits = new Map<string, { waitMs: number; reason: string }>()
    for (const entry of rateLimits3D) {
      const hasModel = entry.modelID && entry.modelID.length > 0
      if (hasModel) {
        modelLimits.set(`${entry.accountId}:${entry.providerId}:${entry.modelID}`, {
          waitMs: entry.waitMs,
          reason: entry.reason,
        })
      }
      if (!hasModel) {
        providerLimits.set(`${entry.accountId}:${entry.providerId}`, {
          waitMs: entry.waitMs,
          reason: entry.reason,
        })
      }
    }

    let ready = 0
    let limited = 0

    const modelEntries = new Map<string, { providerId: string; modelId: string }>()

    // @event_2026-02-06:fix-model-activities - Only show favorites in Model Activities
    for (const favorite of favorites) {
      const key = `${favorite.providerId}:${favorite.modelID}`
      modelEntries.set(key, { providerId: favorite.providerId, modelId: favorite.modelID })
    }

    const sortedModels = Array.from(modelEntries.values()).sort((a, b) => {
      const mode = activitySort()
      const labelA = Account.getProviderLabel(providerKeyFromId(a.providerId) || a.providerId)
      const labelB = Account.getProviderLabel(providerKeyFromId(b.providerId) || b.providerId)
      if (mode === "provider") {
        if (labelA !== labelB) return labelA.localeCompare(labelB)
        return a.modelId.localeCompare(b.modelId)
      }
      if (mode === "model") {
        if (a.modelId !== b.modelId) return a.modelId.localeCompare(b.modelId)
        return labelA.localeCompare(labelB)
      }
      const rankA = getRecentRank(a.providerId, a.modelId)
      const rankB = getRecentRank(b.providerId, b.modelId)
      if (rankA !== rankB) return rankA - rankB
      if (labelA !== labelB) return labelA.localeCompare(labelB)
      return a.modelId.localeCompare(b.modelId)
    })

    const branchWidth = 2
    const ACTIVITY_PROVIDER_COL_MAX = 16
    const ACTIVITY_MODEL_COL_MAX = 20
    const ACTIVITY_ACCOUNT_COL_MAX = 24
    const fitColumn = (value: string, width: number) => {
      if (value.length <= width) return value.padEnd(width)
      if (width <= 1) return value.slice(0, width)
      return `${value.slice(0, width - 1)}…`
    }
    const widths = sortedModels.reduce(
      (acc, entry) => {
        const providerLabel = Account.getProviderLabel(providerKeyFromId(entry.providerId) || entry.providerId) || "-"
        acc.provider = Math.max(acc.provider, providerLabel.length)
        acc.model = Math.max(acc.model, (entry.modelId || "-").length)
        const providerBucket = providerKeyFromId(entry.providerId) ?? entry.providerId
        const accountData = accountMap[entry.providerId] ?? accountMap[providerBucket]
        const accountIds = accountData ? Object.keys(accountData.accounts) : []
        const list = accountIds.length > 0 ? accountIds : ["-"]
        for (const accountId of list) {
          const info = accountId === "-" ? undefined : accountData?.accounts[accountId]
          const display = info ? Account.getDisplayName(accountId, info, entry.providerId) : accountId
          acc.account = Math.max(acc.account, (display || "-").length)
        }
        return acc
      },
      { provider: 8, model: 12, account: 12 },
    )
    widths.provider = Math.min(widths.provider, ACTIVITY_PROVIDER_COL_MAX)
    widths.model = Math.min(widths.model, ACTIVITY_MODEL_COL_MAX)
    widths.account = Math.min(widths.account, ACTIVITY_ACCOUNT_COL_MAX)

    const currentModel = currentSessionModel()
    const currentAccountId = currentSessionAccountId()

    for (const entryModel of sortedModels) {
      const providerId = entryModel.providerId
      const modelId = entryModel.modelId
      const isCurrentModel = currentModel?.providerId === providerId && currentModel?.modelID === modelId
      const providerBucket = providerKeyFromId(providerId) ?? providerId
      const accountData = accountMap[providerId] ?? accountMap[providerBucket]
      const activeAccountId = accountData?.activeAccount
      const accountIds = accountData ? Object.keys(accountData.accounts) : []
      const list = accountIds.length > 0 ? accountIds : ["-"]
      const providerLabel = Account.getProviderLabel(providerKeyFromId(providerId) || providerId)
      const providerCol = fitColumn(providerLabel || "-", widths.provider)
      const modelCol = fitColumn(modelId || "-", widths.model)
      const modelInfo = providerMap[providerId]?.models?.[modelId]
      const modelDisplayName = modelInfo?.name ?? modelId
      const fallbackFree = modelInfo ? shouldShowFree(providerId, modelInfo) : false

      for (let i = 0; i < list.length; i += 1) {
        const accountId = list[i]
        const info = accountId === "-" ? undefined : accountData?.accounts[accountId]
        const display = info ? Account.getDisplayName(accountId, info, providerId) : accountId
        const isLast = i === list.length - 1
        const branchMarker = list.length === 1 ? "" : i === 0 ? "┬─" : isLast ? "└─" : "├─"
        const branchColValue = branchMarker.padEnd(branchWidth)
        const accountCol = fitColumn(`${display || "-"}`, widths.account)
        const titleProviderCol = i === 0 ? providerCol : "".padEnd(widths.provider)
        const titleModelCol = i === 0 ? modelCol : "".padEnd(widths.model)
        const isCurrentAccount =
          isCurrentModel && (currentAccountId ? currentAccountId === accountId : activeAccountId === accountId)
        const rowSuffix = isCurrentAccount ? " ✅" : ""

        // @event_20260216_phase5 — Gemini RPD display moved to formatQuotaFooter
        let displayStatus = "--"

        const modelKey = `${providerId}:${modelId}`
        const modelEntry = modelLimits.get(`${accountId}:${providerId}:${modelId}`)
        if (modelEntry && modelEntry.waitMs > 0) {
          limited += 1
          const waitTime = `⏳ ${formatWait(modelEntry.waitMs)}`
          const statusText = `${waitTime.padStart(16)}${rowSuffix}`
          items.push({
            value: `${accountId}:${providerId}:${modelId}`,
            title: `${titleProviderCol}  ${titleModelCol}  ${branchColValue}${accountCol}  ${statusText}`,
            description: "",
            category: "",
            footer: "",
            truncate: "none",
          })
          continue
        }

        const providerLimit = providerLimits.get(`${accountId}:${providerId}`)
        if (providerLimit && providerLimit.waitMs > 0) {
          limited += 1
          const waitTime = `⏳ ${formatWait(providerLimit.waitMs)}`
          const statusText = `${waitTime.padStart(16)}${rowSuffix}`
          items.push({
            value: `${accountId}:${providerId}:${modelId}`,
            title: `${titleProviderCol}  ${titleModelCol}  ${branchColValue}${accountCol}  ${statusText}`,
            description: "",
            category: "",
            footer: "",
            truncate: "none",
          })
          continue
        }

        // @event_2026-02-06:rotation_unify - Show quota for all models with quota data
        // Previously required state2d.available, now shows quota regardless of rate limit history
        const quotaFooter = formatQuotaFooter(accountId, providerId, modelId, modelDisplayName, fallbackFree, false, 0)

        if (quotaFooter) {
          displayStatus = quotaFooter
        }

        const statusColumn = displayStatus.padStart(16)

        if (quotaFooter) {
          ready += 1
          const readyFooter = `${statusColumn}${rowSuffix}`
          items.push({
            value: `${accountId}:${providerId}:${modelId}`,
            title: `${titleProviderCol}  ${titleModelCol}  ${branchColValue}${accountCol}  ${readyFooter}`,
            description: "",
            category: "",
            footer: "",
            truncate: "none",
          })
          continue
        }

        items.push({
          value: `${accountId}:${providerId}:${modelId}`,
          title: `${titleProviderCol}  ${titleModelCol}  ${branchColValue}${accountCol}  ${statusColumn}${rowSuffix}`,
          description: "",
          category: "",
          footer: "",
          truncate: "none",
        })
      }
    }

    if (items.length === 0) {
      items.push({
        value: "empty",
        title: "No models tracked yet",
        description: "Rate limits will appear here when encountered",
        category: "",
        footer: "",
      })
    } else {
      const headerProvider = fitColumn("Provider", widths.provider)
      const headerModel = fitColumn("Model", widths.model)
      const headerBranch = "".padEnd(branchWidth)
      const headerAccount = fitColumn("Account", widths.account)
      items.unshift({
        value: "_header",
        title: `${headerProvider}  ${headerModel}  ${headerBranch}${headerAccount}  Status`,
        description: "",
        category: "",
        footer: "",
        truncate: "none",
      })
    }

    return { items, stats: { ready, limited, total: ready + limited } }
  })

  const selectActivity = async (value: string) => {
    if (!value || value === "_header" || value === "empty") return
    const [accountId, providerId, ...rest] = value.split(":")
    const modelID = rest.join(":")
    if (!providerId || !modelID) return
    const resolvedProvider = Account.parseProvider(providerId) || providerId

    // Check if selecting an already-selected model (triggers auto-exit)
    // @event_20260208_double_enter_model_exit
    const providerKey = providerKeyFromId(providerId) || providerId
    const current = local.model.current(route.data.type === "session" ? route.data.sessionID : undefined)
    const currentAccountId = local.model.currentAccountId(
      route.data.type === "session" ? route.data.sessionID : undefined,
    )
    const isAlreadySelected =
      current?.providerId === resolvedProvider && current?.modelID === modelID && currentAccountId === accountId

    debugCheckpoint("admin.activities", "select model", {
      accountId,
      providerId: resolvedProvider,
      modelID,
      isAlreadySelected,
    })

    // FIX: In multi-account mode, local.model announce can read stale account cache.
    // Build toast from the selected row/accountId to avoid misleading account labels.
    local.model.set(
      { providerId: resolvedProvider, modelID, accountId: accountId !== "-" ? accountId : undefined },
      { recent: true, announce: false, interrupt: true, syncSessionExecution: true },
      route.data.type === "session" ? route.data.sessionID : undefined,
    )
    try {
      const providerInfo = sync.data.provider.find((x) => x.id === resolvedProvider)
      const providerLabel = providerInfo?.name ?? resolvedProvider
      const modelLabel = providerInfo?.models?.[modelID]?.name ?? modelID
      let selectedAccountLabel = "default account"
      if (accountId && accountId !== "-") {
        const info = await Account.get(providerKey, accountId)
        selectedAccountLabel = info ? Account.getDisplayName(accountId, info, resolvedProvider) : accountId
      }
      toast.show({
        variant: "info",
        message: `《${providerLabel}, ${selectedAccountLabel}, ${modelLabel}》`,
        duration: 3000,
      })
    } catch {
      // Best-effort toast rendering only
    }
    setActivityTick((tick) => tick + 1)

    // If selecting an already-selected model, auto-exit the admin panel
    // This creates a "double-enter" effect: first Enter selects, second Enter on same model exits
    if (isAlreadySelected) {
      debugCheckpoint("admin.activities", "double-enter auto-exit", {
        providerId: resolvedProvider,
        modelID,
      })
      setTimeout(() => {
        dialog.clear()
      }, 100)
    }
  }

  const activityValue = createMemo(() => {
    const cur = currentSessionModel()
    if (!cur) return undefined
    const currentAccountId = currentSessionAccountId()
    // @event_20260217_cursor_follow_fix - Fallback to "-" account if none active
    return `${currentAccountId ?? "-"}:${cur.providerId}:${cur.modelID}`
  })

  // ---- OPTION GENERATION ----
  const handleAddProvider = (providerKey: string) => {
    if (!providerKey) return
    const normalizedProviderKey = providerKey
    if (isProviderDisabled(normalizedProviderKey)) {
      toast.show({
        variant: "warning",
        message: `Provider "${normalizedProviderKey}" is disabled. Press Insert in Show All to enable it.`,
      })
      return
    }
    if (normalizedProviderKey === "google-api") {
      debugCheckpoint("admin", "add provider google", { providerKey: normalizedProviderKey })
      openGoogleAdd()
      return
    }

    // Check if provider has OAuth methods available
    const authMethods = sync.data.provider_auth[normalizedProviderKey]
    const hasOAuth = authMethods?.some((m) => m.type === "oauth")
    if (hasOAuth) {
      debugCheckpoint("admin", "add provider with oauth", {
        providerKey: normalizedProviderKey,
        methods: authMethods?.map((m) => m.label),
      })
      dialog.push(() => <DialogProviderList providerId={normalizedProviderKey} />, markDialogClosed)
      return
    }

    // Check if this is a models.dev provider (needs API key)
    const providerData = modelsDevData()?.[normalizedProviderKey]
    if (providerData && providerData.env && providerData.env.length > 0) {
      const envVar = providerData.env[0]
      const providerName = providerData.name || normalizedProviderKey
      debugCheckpoint("admin", "add provider models.dev", { providerKey: normalizedProviderKey, envVar })
      dialog.push(
        () => (
          <DialogApiKeyAdd
            providerId={normalizedProviderKey}
            providerName={providerName}
            envVar={envVar}
            onCancel={() => {
              markDialogClosed()
              debugCheckpoint("admin", "apikey add cancel")
              dialog.pop()
              forceRefresh()
            }}
            onSaved={() => {
              markDialogClosed()
              debugCheckpoint("admin", "apikey add saved")
              dialog.pop()
              forceRefresh()
            }}
          />
        ),
        markDialogClosed,
      )
      return
    }

    // Fallback: Generic Provider List
    debugCheckpoint("admin", "add provider list fallback", { providerKey: normalizedProviderKey })
    dialog.replace(() => <DialogProviderList providerId={normalizedProviderKey} />)
  }

  const options = createMemo(() => {
    const s = step()
    const currentPage = page()
    const triggers = refreshSignal() // Dependency to force re-calc

    const favorites = connected() ? local.model.favorite() : []

    const formatProviderModelTitle = (
      providerId: string,
      modelTitle: string,
      widths: { provider: number; model: number },
    ) => {
      const providerCol = label(providerId, providerId).padEnd(widths.provider)
      const modelCol = modelTitle.padEnd(widths.model)
      return `${providerCol} ${modelCol}`
    }

    const getModelOptions = (
      modelList: { providerId: string; modelID: string }[],
      origin: "favorite",
    ): DialogSelectOption<unknown>[] => {
      const resolved = modelList.flatMap((item) => {
        const p = sync.data.provider.find((x) => x.id === item.providerId)
        if (!p) return []
        const m = p.models[item.modelID]
        if (!m) return []
        return [
          {
            providerId: item.providerId,
            modelID: item.modelID,
            disabled: p.id === "opencode" && m.id.includes("-nano"),
          },
        ]
      })

      const widths = resolved.reduce(
        (acc, item) => {
          acc.provider = Math.max(acc.provider, item.providerId.length)
          acc.model = Math.max(acc.model, item.modelID.length)
          return acc
        },
        { provider: 0, model: 0 },
      )

      return resolved.map((item) => {
        return {
          value: { providerId: item.providerId, modelID: item.modelID, origin },
          title: formatProviderModelTitle(item.providerId, item.modelID, widths),
          description: undefined,
          footer: undefined,
          disabled: item.disabled,
          onSelect: () => {
            debugCheckpoint("admin", "select favorite model", {
              origin,
              provider: item.providerId,
              model: item.modelID,
            })
            probeAndSelectModel(item.providerId, item.modelID, undefined, origin)
          },
        }
      })
    }

    if (currentPage === "activities") {
      return activityData().items.map((item) => {
        const disabled = item.value === "_header" || item.value === "empty"
        return {
          ...item,
          disabled,
          onSelect: disabled ? undefined : () => selectActivity(item.value),
        }
      })
    }

    // LEVEL 1: ROOT
    if (s === "root") {
      const list = []
      list.push({
        title: "Add Custom Provider",
        value: "__add_custom__",
        category: "Actions",
        icon: "+",
        onSelect: () => {
          dialog.push(() => <DialogProviderManualAdd onSelect={(id) => handleAddProvider(id)} />, markDialogClosed)
        },
      })

      // Kill-Switch actions
      list.push({
        title: "Kill-Switch Status",
        value: "__ks_status__",
        category: "Kill-Switch",
        icon: () => <text>⚡</text>,
        onSelect: async () => {
          try {
            const res = await fetch(`${sdk.url}/api/v2/admin/kill-switch/status`, {
              method: "GET",
              headers: { "content-type": "application/json" },
            })
            if (!res.ok) {
              toast.show({ message: `Status failed (${res.status})`, variant: "error" })
              return
            }
            const data = (await res.json()) as { active?: boolean; state?: string; request_id?: string; snapshot_url?: string | null }
            const label = data.active ? `ACTIVE — ${data.state ?? "unknown"} (${data.request_id ?? "-"})` : "Inactive"
            toast.show({ message: `Kill-Switch: ${label}`, variant: data.active ? "error" : "info" })
          } catch (err) {
            toast.show({ message: `Error: ${err instanceof Error ? err.message : String(err)}`, variant: "error" })
          }
        },
      })
      list.push({
        title: "Trigger Kill-Switch",
        value: "__ks_trigger__",
        category: "Kill-Switch",
        icon: () => <text>🛑</text>,
        onSelect: async () => {
          const reason = await DialogPrompt.show(dialog, "Trigger Kill-Switch", {
            description: () => <text>Enter a reason for triggering the kill-switch. This will pause/cancel ongoing work.</text>,
            placeholder: "Reason (required)",
          })
          if (!reason?.trim()) return
          const confirmed = await DialogConfirm.show(dialog, "Confirm Kill-Switch", `Trigger kill-switch with reason: "${reason.trim()}"?`)
          if (!confirmed) return
          try {
            const res = await fetch(`${sdk.url}/api/v2/admin/kill-switch/trigger`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ reason: reason.trim() }),
            })
            if (res.status === 202) {
              const challenge = (await res.json()) as { mfa_required?: boolean; request_id?: string; dev_code?: string }
              if (challenge?.mfa_required && challenge.request_id) {
                const hint = challenge.dev_code ? ` (dev code: ${challenge.dev_code})` : ""
                const mfaCode = await DialogPrompt.show(dialog, "MFA Required", {
                  description: () => <text>Enter MFA code for request {challenge.request_id}{hint}</text>,
                  placeholder: "MFA code",
                })
                if (!mfaCode?.trim()) return
                const second = await fetch(`${sdk.url}/api/v2/admin/kill-switch/trigger`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ reason: reason.trim(), requestID: challenge.request_id, mfaCode: mfaCode.trim() }),
                })
                if (!second.ok) {
                  toast.show({ message: `Trigger failed (${second.status})`, variant: "error" })
                  return
                }
                const done = (await second.json()) as { request_id?: string }
                toast.show({ message: `Kill-switch triggered. request_id=${done.request_id ?? challenge.request_id}`, variant: "success" })
                return
              }
              toast.show({ message: "MFA required but challenge payload is invalid.", variant: "error" })
              return
            }
            if (!res.ok) {
              toast.show({ message: `Trigger failed (${res.status})`, variant: "error" })
              return
            }
            const done = (await res.json()) as { request_id?: string; snapshot_url?: string | null }
            toast.show({ message: `Kill-switch triggered. request_id=${done.request_id ?? "n/a"}`, variant: "success" })
          } catch (err) {
            toast.show({ message: `Error: ${err instanceof Error ? err.message : String(err)}`, variant: "error" })
          }
        },
      })
      list.push({
        title: "Cancel Kill-Switch",
        value: "__ks_cancel__",
        category: "Kill-Switch",
        icon: () => <text>✅</text>,
        onSelect: async () => {
          const confirmed = await DialogConfirm.show(dialog, "Cancel Kill-Switch", "Cancel the active kill-switch and resume task scheduling?")
          if (!confirmed) return
          try {
            const res = await fetch(`${sdk.url}/api/v2/admin/kill-switch/cancel`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({}),
            })
            if (!res.ok) {
              toast.show({ message: `Cancel failed (${res.status})`, variant: "error" })
              return
            }
            toast.show({ message: "Kill-switch canceled. Scheduling resumed.", variant: "success" })
          } catch (err) {
            toast.show({ message: `Error: ${err instanceof Error ? err.message : String(err)}`, variant: "error" })
          }
        },
      })

      for (const providerRow of canonicalProviders()) {
        const providerKey = providerRow.family
        const providerEntries = groupedProviders().get(providerKey) || []
        const providerData = coreAll()?.[providerKey]
        const allIds = providerData ? Object.keys(providerData.accounts || {}) : []
        // Show all accounts that have real data — don't hide "generic" IDs
        // (legacy accounts created before the unified identity fix may have generic IDs
        //  like `${providerKey}-subscription-${providerKey}` but still contain valid credentials)
        const filteredIds = allIds.filter((id) => {
          if (!providerData?.accounts[id]) return false
          return true
        })
        const accountTotal = providerData ? filteredIds.length : providerRow.accountCount
        const providerDisabled = !providerRow.enabled

        // Show All/Filtered share the same provider-key universe.
        // The only difference is whether disabled providers are filtered out.
        const shouldShow = showHidden() ? true : !providerDisabled
        if (!shouldShow) continue

        const activeCount = providerRow.activeCount || providerEntries.filter((p) => p.active).length

        const enabled = providerRow.enabled

        list.push({
          value: { providerKey },
          title: showHidden() ? `${providerRow.label} · ${enabled ? "enabled" : "disabled"}` : providerRow.label,
          category: "Providers",
          icon: "📂",
          description: accountTotal >= 1 ? `${accountTotal} account${accountTotal === 1 ? "" : "s"}` : undefined,
          gutter: providerDisabled ? (
            <text fg={theme.error}>⊘</text>
          ) : activeCount > 0 ? (
            <text fg={theme.success}>●</text>
          ) : undefined,
          onSelect: () => {
            debugCheckpoint("admin", "select provider key", { providerKey })
            setSelectedProviderKey(providerKey)
            setSelectedAccountID(effectiveAccountIdForProviderKey(providerKey) ?? null)
            setSelectedProviderID(providerKey)
            setStepLogged("account_select", "select provider key")
            forceRefresh()
          },
        })
      }

      return list
    }

    // LEVEL 2: ACCOUNT MANAGEMENT
    if (s === "account_select") {
      const providerKey = selectedProviderKey()
      if (!providerKey) return []

      const accountMap = new Map<string, any>()
      const providerData = coreAll()?.[providerKey]
      const accountsWithProvider: Array<{ id: string; info: Account.Info; coreProviderKey: string }> = []
      if (providerData?.accounts) {
        for (const [id, info] of Object.entries(providerData.accounts)) {
          accountsWithProvider.push({ id, info, coreProviderKey: providerKey })
        }
      }

      const activeId = effectiveAccountIdForProviderKey(providerKey)

      for (const { id, info, coreProviderKey } of accountsWithProvider) {
        const displayName = Account.getDisplayName(id, info, providerKey) || info?.name || id
        accountMap.set(id, {
          id,
          coreId: id,
          coreProviderKey,
          name: displayName,
          active: activeId === id,
          email: info.type === "subscription" ? info.email : undefined,
        })
      }

      const accountList = Array.from(accountMap.values())

      const accountOptions = pipe(
        accountList,
        map((p) => {
          const title = p.name || p.id

          return {
            value: p.id,
            coreId: p.coreId,
            coreProviderKey: p.coreProviderKey || providerKey,
            title: title,
            category: label(providerKey, providerKey),
            icon: "👤",
            disabled: false,
            onSelect: async () => {
              debugCheckpoint("admin", "select account", {
                providerKey,
                id: p.id,
                coreId: p.coreId,
                coreProviderKey: p.coreProviderKey,
              })
              await handleSetActive(p.coreProviderKey || providerKey, p.coreId || p.id, p.id)
              setStepLogged("model_select", "select account")
            },
          }
        }),
      )

      const result = [...accountOptions]

      if (result.length === 0 && accountList.length === 0) {
        // Prepend a dummy if list is empty
        return [
          {
            title: "No accounts configured",
            value: "__none__",
            disabled: true,
            category: label(providerKey, providerKey),
            icon: "⚠️",
          },
        ]
      }

      return result
    }

    // LEVEL 3: MODEL SELECTION
    if (s === "model_select") {
      const pid = selectedProviderID()
      if (!pid) return []

      const resolved = selectedRuntimeProvider()
      if (!resolved) return []
      const p = resolved.provider
      const providerId = resolved.id

      const showAll = showHidden()
      const isGoogleProvider = providerKeyFromId(providerId) === "google-api"
      // Use canonical provider key for favorites/hidden checks (they expect provider boundary IDs like "google-api")
      const providerKey = providerKeyFromId(providerId) || providerId
      // Use the actual provider ID (account-specific when selected) for model selection
      // This ensures getSDK() uses the correct API key for the selected account
      const runtimeProviderId = providerId
      const hiddenCheck = (mid: string) => {
        if (showAll) return true
        return !local.model.hidden().some((h) => h.providerId === providerKey && h.modelID === mid)
      }

      const quotaAccountId = effectiveAccountIdForProviderKey(providerKey) ?? pid

      const baseEntries = pipe(
        p.models,
        entries(),
        filter(([_, info]) => info.status !== "deprecated"),
        filter(([mid]) => hiddenCheck(mid)),
        map(([mid, info]) => {
          const isFav = favorites.some((f) => f.providerId === providerKey && f.modelID === mid)
          const providerRateLimit = p as unknown as { coolingDownUntil?: number; cooldownReason?: string }

          const isRateLimited =
            typeof providerRateLimit.coolingDownUntil === "number" && providerRateLimit.coolingDownUntil > Date.now()
          const isBlocked = Boolean(providerRateLimit.cooldownReason)
          const isActionable = isRateLimited || isBlocked

          return {
            value: { providerId: providerKey, modelID: mid },
            modelTitle: info.name ?? mid,
            category: "Models",
            gutter: isFav ? <text fg={theme.accent}>⭐</text> : undefined,
            description: iife(() => {
              if (isRateLimited) {
                const remaining = Math.ceil(
                  ((providerRateLimit.coolingDownUntil ?? Date.now()) - Date.now()) / 1000 / 60,
                )
                return `⏳ Rate limited (${remaining}m)`
              }
              if (isBlocked) return `⛔ ${providerRateLimit.cooldownReason}`
              return undefined
            }),
            disabled: (providerId === "opencode" && mid.includes("-nano")) || (isBlocked && !isRateLimited),
            footer: formatQuotaFooter(
              quotaAccountId,
              providerId,
              mid,
              info.name ?? mid,
              shouldShowFree(providerId, info),
              isActionable,
              isRateLimited ? Math.max(0, (providerRateLimit.coolingDownUntil ?? Date.now()) - Date.now()) : 0,
            ),
            onSelect: () => {
              const accountId = effectiveAccountIdForProviderKey(providerKey)
              debugCheckpoint("admin", "select model", { provider: runtimeProviderId, model: mid, accountId })
              probeAndSelectModel(providerKey, mid, accountId)
            },
          }
        }),
        sortBy((entry) => entry.modelTitle),
      )

      const existingIds = new Set(baseEntries.map((entry) => entry.value.modelID))
      const dynamicEntries = isGoogleProvider
        ? googleModels()
            .filter((model) => hiddenCheck(model.id) && !existingIds.has(model.id))
            .map((model) => {
              const isFav = favorites.some((f) => f.providerId === providerKey && f.modelID === model.id)
              return {
                value: { providerId: providerKey, modelID: model.id },
                modelTitle: model.title,
                category: "Models",
                gutter: isFav ? <text fg={theme.accent}>⭐</text> : undefined,
                description: "Google AI Studio list",
                footer: undefined,
                onSelect: () => {
                  const accountId = effectiveAccountIdForProviderKey(providerKey)
                  debugCheckpoint("admin", "select dynamic model", {
                    provider: runtimeProviderId,
                    model: model.id,
                    accountId,
                  })
                  probeAndSelectModel(providerKey, model.id, accountId)
                },
              }
            })
        : []

      const combined = sortBy([...baseEntries, ...dynamicEntries], (entry) => entry.modelTitle)

      const widths = combined.reduce(
        (acc, entry) => {
          acc.provider = Math.max(acc.provider, providerKey.length)
          acc.model = Math.max(acc.model, entry.modelTitle.length)
          return acc
        },
        { provider: providerKey.length, model: 0 },
      )

      const formattedCombined = combined.map((entry) => {
        return {
          ...entry,
          title: formatProviderModelTitle(providerKey, entry.modelTitle, widths),
        }
      })

      const extras: DialogSelectOption<unknown>[] = []
      if (isGoogleProvider) {
        if (googleModelsLoading()) {
          extras.push({
            title: "Refreshing Google AI Studio models…",
            value: "__google_loading__",
            disabled: true,
            category: "Models",
          })
        } else if (googleModelError()) {
          extras.push({
            title: `Google refresh failed: ${googleModelError()}`,
            value: "__google_error__",
            disabled: true,
            category: "Models",
          })
        }
      }

      if (formattedCombined.length === 0) {
        extras.push({
          title: "No models found",
          value: "__empty__",
          disabled: true,
          category: "Models",
        })
        return extras
      }

      return extras.concat(formattedCombined)
    }

    return []
  })

  // ---- ACTIONS ----

  const handleSetActive = async (providerKey: string, accountId: string, displayId?: string) => {
    debugCheckpoint("admin", "set active start", { providerKey, accountId, displayId })
    return debugSpan("admin", "set active", { providerKey, accountId, displayId }, async () => {
      setSelectedAccountID(accountId)
      const nextProviderId = resolveCanonicalRuntimeProviderByKey({
        family: providerKey,
        activeAccountId: accountId,
        availableProviderIds: syncProvidersForProviderKey(providerKey).map((provider) => provider.id),
      })
      setSelectedProviderID(nextProviderId ?? providerKey)
      const current = currentSessionModel()
      const currentProviderKey = current ? (providerKeyFromId(current.providerId) ?? current.providerId) : undefined
      if (current && currentProviderKey === providerKey) {
        local.model.set(
          { providerId: providerKey, modelID: current.modelID, accountId },
          { skipValidation: true, announce: false, interrupt: true, syncSessionExecution: true },
          currentSessionID(),
        )
      }
      forceRefresh()
      debugCheckpoint("admin", "set active end", { providerKey, accountId, displayId })
    })
  }

  // ---- TITLES ----
  const title = createMemo(() => {
    const showAllIndicator = showHidden() ? " [Show All]" : ""
    const currentPage = page()
    if (currentPage === "activities") {
      const stats = activityData().stats
      if (stats.total === 0) return "Model Activities"
      return `Model Activities (${stats.ready}✓ ${stats.limited}⏳)`
    }
    if (currentPage === "providers") {
      if (step() === "root") return `Providers${showAllIndicator}`
      if (step() === "account_select")
        return `Manage Accounts (${label(selectedProviderKey() || "", selectedProviderKey() || "")})`
      if (step() === "model_select") {
        const resolved = selectedRuntimeProvider()
        if (resolved) {
          const who = owner(resolved.provider)
          if (who) return `Select Model - ${who}${showAllIndicator}`
          return `Select Model - ${resolved.provider.name}${showAllIndicator}`
        }
        return `Select Model${showAllIndicator}`
      }
    }
    return "Admin"
  })

  // ---- NAVIGATION ----
  const goBack = () => {
    // Skip if there's a sub-dialog on top (like View/Edit dialogs)
    // The main dialog (DialogAdmin itself) is NOT counted - only pushed sub-dialogs
    // When a sub-dialog is open, dialog.stack.length > 1
    if (dialog.stack.length > 1) {
      debugCheckpoint("admin", "goBack skipped - sub-dialog open", { stackLength: dialog.stack.length })
      return
    }
    // Skip if a sub-dialog was just closed (the same key event that closed it might trigger goBack)
    if (wasDialogRecentlyClosed()) {
      debugCheckpoint("admin", "goBack skipped - dialog recently closed", {
        flag: dialogClosedFlag,
        elapsed: Date.now() - dialogClosedAt,
      })
      return
    }
    if (lockBack() && step() === "account_select") return
    if (step() === "root") {
      if (page() === "providers") {
        setPageLogged("activities", "left to activities")
        return
      }
      debugCheckpoint("admin", "back exit", { step: step() })
      dialog.clear()
      return
    }
    if (step() === "account_select") {
      debugCheckpoint("admin", "back to root", { step: step(), providerKey: selectedProviderKey() })
      setStepLogged("root", "back to root")
      setSelectedProviderKey(null)
      return
    }
    if (step() === "model_select") {
      debugCheckpoint("admin", "back to account_select", {
        step: step(),
        providerKey: selectedProviderKey(),
        provider: selectedProviderID(),
      })
      setStepLogged("account_select", "back from model_select")
      // Keep provider ID selected? Or clear?
      // Maybe clear to reset state, but keeping it is fine.
      // Actually, account list doesn't depend on selectedProviderID, it depends on selectedProviderKey.
      return
    }
  }

  const goForward = (option: DialogSelectOption<unknown> | undefined) => {
    if (dialog.stack.length > 1) return
    if (page() === "activities") {
      setPageLogged("providers", "right to providers")
      return
    }
    // Deep layers in providers page
    if (option && option.onSelect) {
      option.onSelect(dialog)
    }
  }

  const selectCurrent = createMemo(() => {
    // @event_20260212_activity_cursor_follow - Return activityValue for activities page
    // This enables automatic cursor following when sorting changes
    if (page() === "activities") return activityValue()
    if (step() === "account_select") {
      const selectedAccount = selectedAccountID() ?? effectiveAccountIdForProviderKey(selectedProviderKey())
      if (selectedAccount) return selectedAccount
      const first = options().find((option) => {
        if (!("disabled" in option)) return true
        return option.disabled !== true
      })
      if (first) return first.value
    }
    if (step() === "model_select") {
      const current = currentSessionModel()
      if (!current) return undefined
      return { providerId: current.providerId, modelID: current.modelID }
    }
    return currentSessionModel()
  })

  onMount(() => {
    dialog.setSize("xlarge")
    // Keep a stable initial width so the panel doesn't collapse before data arrives.
    dialog.setWidth(MIN_DIALOG_WIDTH)
  })

  onCleanup(() => dialog.setWidth(undefined))

  createEffect(() => {
    const currentPage = page()
    if (currentPage !== "activities") {
      dialog.setWidth(MIN_DIALOG_WIDTH)
      return
    }
    const activityItems = activityData().items
    const maxTitle = activityItems.reduce((max, item) => Math.max(max, item.title.length), 0)
    const headerTitle = `Model Activities (${activityData().stats.ready}/${activityData().stats.total})`
    const baseWidth = Math.max(maxTitle, headerTitle.length)
    const desired = Math.max(baseWidth + 9, MIN_DIALOG_WIDTH)
    dialog.setWidth(desired)
  })

  return (
    <ErrorBoundary
      fallback={(error) => {
        const msg = error instanceof Error ? error.stack || error.message : String(error)
        debugCheckpoint("admin", "error", { error: msg })
        return (
          <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
            <text fg={theme.error}>Admin error: {msg}</text>
          </box>
        )
      }}
    >
      <DialogSelect
        keybind={[
          // MODEL STEP KEYBINDS
          {
            keybind: Keybind.parse("f")[0],
            title: "Favorites",
            label: "F",
            disabled: !connected() || step() !== "model_select",
            onTrigger: (option) => {
              const model = asModelSelectionValue(option?.value)
              if (model) {
                debugCheckpoint("admin", "toggle favorite", { provider: model.providerId, model: model.modelID })
                local.model.toggleFavorite(model, { skipValidation: true })
              }
            },
          },
          ...(page() === "providers"
            ? [
                {
                  keybind: Keybind.parse("s")[0],
                  title: showHidden() ? "Hide" : "Showall",
                  label: "S",
                  disabled: !connected() || (step() !== "model_select" && step() !== "root"),
                  onTrigger: () => {
                    const next = !showHidden()
                    debugCheckpoint("admin", "toggle show hidden", { enabled: next, step: step() })
                    setShowHidden(next)
                    toast.show({
                      message: next ? "Show All enabled" : "Show All disabled",
                      variant: "info",
                      duration: 1500,
                    })
                  },
                },
                {
                  keybind: Keybind.parse("space")[0],
                  title: "Enable/Disable",
                  label: "Space",
                  disabled: step() !== "root",
                  onTrigger: toggleProviderFromOption,
                },
              ]
            : []),
          ...(page() === "activities"
            ? [
                {
                  keybind: Keybind.parse("s")[0],
                  title: "(S)ort",
                  label: activitySort() === "usage" ? "Usage" : activitySort() === "provider" ? "Provider" : "Model",
                  disabled: false,
                  onTrigger: () => {
                    const next =
                      activitySort() === "usage" ? "provider" : activitySort() === "provider" ? "model" : "usage"
                    debugCheckpoint("admin.activities", "sort", { mode: next })
                    setActivitySort(next)
                  },
                },
                {
                  keybind: Keybind.parse("delete")[0],
                  title: "(D)elete",
                  label: "",
                  disabled: false,
                  // @event_2026-02-06:fix-model-activities - Add delete key to remove from favorites in activities page
                  onTrigger: (option: DialogSelectOption<unknown> | undefined) => {
                    const val = option?.value
                    if (val && typeof val === "string") {
                      const parts = val.split(":")
                      if (parts.length >= 3) {
                        const providerId = parts[1]
                        const modelID = parts[2]
                        debugCheckpoint("admin.activities", "delete favorite", { providerId, modelID })
                        local.model.toggleFavorite({ providerId, modelID }, { skipValidation: true })
                      }
                    }
                  },
                },
              ]
            : []),
          {
            keybind: Keybind.parse("r")[0],
            title: "(R)efresh",
            label: "",
            disabled:
              page() === "activities"
                ? false
                : !connected() ||
                  step() !== "model_select" ||
                  providerKeyFromId(selectedProviderID() ?? "") !== "google-api",
            onTrigger: () => {
              if (page() === "activities") {
                debugCheckpoint("admin.activities", "refresh")
                setActivityTick((tick) => tick + 1)
                setQuotaRefresh((n) => n + 1) // Trigger API quota fetch
                return
              }
              debugCheckpoint("admin", "refresh google models", { provider: selectedProviderID() })
              loadGoogleModels(true)
            },
          },
          // ACCOUNT STEP KEYBINDS
          {
            keybind: Keybind.parse("a")[0],
            title: "(A)dd",
            label: "",
            disabled: step() !== "account_select",
            onTrigger: () => {
              const providerKey = selectedProviderKey()
              if (!providerKey) return
              if (isProviderDisabled(providerKey)) {
                toast.show({
                  variant: "warning",
                  message: `Provider "${providerKey}" is disabled. Press S for Show All, then Space to enable it.`,
                })
                return
              }
              if (providerKey === "google-api") {
                debugCheckpoint("admin", "add keybind google", { providerKey })
                openGoogleAdd()
                return
              }

              // Check if provider has OAuth methods available (e.g., Anthropic Claude Pro/Max)
              const authMethods = sync.data.provider_auth[providerKey]
              const hasOAuth = authMethods?.some((m) => m.type === "oauth")
              if (hasOAuth) {
                // Provider has OAuth support - use DialogProviderList which handles OAuth flow
                debugCheckpoint("admin", "add keybind provider with oauth", {
                  providerKey,
                  methods: authMethods?.map((m) => m.label),
                })
                dialog.push(() => <DialogProviderList providerId={providerKey} />, markDialogClosed)
                return
              }

              // Check if this is a models.dev provider (needs API key)
              const providerData = modelsDevData()?.[providerKey]
              if (providerData && providerData.env && providerData.env.length > 0) {
                // models.dev provider with env var requirement
                const envVar = providerData.env[0] // Use first env var
                const providerName = providerData.name || providerKey
                debugCheckpoint("admin", "add keybind models.dev provider", { providerKey, envVar })
                dialog.push(
                  () => (
                    <DialogApiKeyAdd
                      providerId={providerKey}
                      providerName={providerName}
                      envVar={envVar}
                      onCancel={() => {
                        markDialogClosed()
                        debugCheckpoint("admin", "apikey add cancel")
                        dialog.pop()
                        forceRefresh()
                      }}
                      onSaved={() => {
                        markDialogClosed()
                        debugCheckpoint("admin", "apikey add saved")
                        dialog.pop()
                        forceRefresh()
                      }}
                    />
                  ),
                  markDialogClosed,
                )
                return
              }

              debugCheckpoint("admin", "add keybind provider list", { providerKey })
              dialog.replace(() => <DialogProviderList providerId={providerKey} />)
            },
          },
          // EDIT ACCOUNT NAME
          {
            keybind: Keybind.parse("e")[0],
            title: "(E)dit",
            label: "",
            disabled: step() !== "account_select",
            onTrigger: async (option) => {
              const adminOption = asDialogAdminOption(option)
              const val = adminOption.value
              if (typeof val !== "string" || val.startsWith("__")) return
              const providerKey = selectedProviderKey()
              if (!providerKey) return

              // Use coreProviderKey for account lookup (accounts may be stored in different provider bucket than displayed)
              const accountId = adminOption.coreId || val
              const lookupProviderKey = adminOption.coreProviderKey || providerKey
              const accountInfo = await Account.get(lookupProviderKey, accountId)
              if (!accountInfo) {
                toast.show({ message: "Account not found", variant: "error", duration: 2000 })
                return
              }

              debugCheckpoint("admin", "edit account", { providerKey: lookupProviderKey, id: accountId })
              // Pass markDialogClosed as onClose to dialog.push so it's called
              // when dialog.tsx's escape handler pops the stack (before our keybinds run)
              dialog.push(
                () => (
                  <DialogAccountEdit
                    providerKey={lookupProviderKey}
                    accountId={accountId}
                    currentName={accountInfo.name}
                    onCancel={() => {
                      markDialogClosed()
                      dialog.pop()
                    }}
                    onSaved={() => {
                      markDialogClosed()
                      dialog.pop()
                      forceRefresh()
                    }}
                  />
                ),
                markDialogClosed, // Called by dialog.tsx on escape BEFORE stack pop
              )
            },
          },
          // VIEW ACCOUNT JSON
          {
            keybind: Keybind.parse("v")[0],
            title: "(V)iew",
            label: "",
            disabled: step() !== "account_select",
            onTrigger: async (option) => {
              const adminOption = asDialogAdminOption(option)
              const val = adminOption.value
              if (typeof val !== "string" || val.startsWith("__")) return
              const providerKey = selectedProviderKey()
              if (!providerKey) return

              // Use coreProviderKey for account lookup (accounts may be stored in different provider bucket than displayed)
              const accountId = adminOption.coreId || val
              const lookupProviderKey = adminOption.coreProviderKey || providerKey
              const accountInfo = await Account.get(lookupProviderKey, accountId)
              if (!accountInfo) {
                toast.show({ message: "Account not found", variant: "error", duration: 2000 })
                return
              }

              debugCheckpoint("admin", "view account", { providerKey: lookupProviderKey, id: accountId })
              // Pass markDialogClosed as onClose to dialog.push so it's called
              // when dialog.tsx's escape handler pops the stack (before our keybinds run)
              dialog.push(
                () => (
                  <DialogAccountView
                    providerKey={lookupProviderKey}
                    accountId={accountId}
                    accountInfo={accountInfo}
                    onClose={() => {
                      markDialogClosed()
                      dialog.pop()
                    }}
                  />
                ),
                markDialogClosed, // Called by dialog.tsx on escape BEFORE stack pop
              )
            },
          },
          // SHARED / DELETE / HIDE
          ...(page() === "activities"
            ? []
            : [
                {
                  keybind: Keybind.parse("delete")[0],
                  title: step() === "model_select" ? "Hide" : "(Del)ete",
                  label: "",
                  disabled: step() === "root" || (step() === "model_select" ? !connected() : false),
                  hidden: step() === "root",
                  onTrigger: async (option: DialogSelectOption<unknown> | undefined) => {
                    const adminOption = asDialogAdminOption(option)
                    const val = adminOption.value

                    if (step() === "account_select" && typeof val === "string" && val !== "__add_account__") {
                      const providerKey = selectedProviderKey()
                      if (providerKey) {
                        // Use coreProviderKey for account operations (accounts may be stored in different provider bucket than displayed)
                        const lookupProviderKey = adminOption.coreProviderKey || providerKey
                        debugCheckpoint("admin", "delete account prompt", {
                          providerKey: lookupProviderKey,
                          id: val,
                        })
                        const confirmed = await DialogConfirm.show(
                          dialog,
                          "Delete Account",
                          `Are you sure you want to delete this account?`,
                        )

                        if (confirmed) {
                          try {
                            // Remove from core Account module (single source of truth)
                            // Use the mapped coreId and coreProviderKey for correct lookup
                            const coreId = adminOption.coreId || val
                            await Account.remove(lookupProviderKey, coreId)
                            await Account.refresh()

                            debugCheckpoint("admin", "delete account success", {
                              providerKey: lookupProviderKey,
                              id: coreId,
                            })
                            toast.show({ message: "Account deleted successfully", variant: "success" })
                            setSelectedProviderKey(providerKey)
                            forceRefresh()
                            lockBackOnce()
                          } catch (e: unknown) {
                            debugCheckpoint("admin", "delete account error", {
                              providerKey,
                              error: String(e instanceof Error ? e.stack || e.message : e),
                            })
                            toast.error(e)
                          }
                        }
                      }
                      return
                    }

                    if (step() === "model_select") {
                      // Only handle model values (objects)
                      const modelVal = asModelSelectionValue(val)
                      if (modelVal) {
                        debugCheckpoint("admin", "delete model action", {
                          origin: modelVal.origin,
                          provider: modelVal.providerId,
                          model: modelVal.modelID,
                        })
                        if (modelVal.origin === "recent") local.model.removeFromRecent(modelVal)
                        else if (step() !== "root") local.model.toggleHidden(modelVal)
                      }
                    }
                  },
                },
              ]),
          {
            keybind: Keybind.parse("insert")[0],
            title: "Unhide",
            label: "Ins",
            disabled: step() !== "model_select" || !showHidden(),
            hidden: step() === "root",
            onTrigger: async (option) => {
              const adminOption = asDialogAdminOption(option)
              const val = adminOption.value

              // Unhide model
              const model = asModelSelectionValue(val)
              if (model) {
                debugCheckpoint("admin", "unhide model", { provider: model.providerId, model: model.modelID })
                const isHidden = local.model
                  .hidden()
                  .some((h) => h.providerId === model.providerId && h.modelID === model.modelID)
                if (!isHidden) {
                  toast.show({
                    message: `Model "${model.modelID}" is already visible`,
                    variant: "warning",
                    duration: 2000,
                  })
                  return
                }
                local.model.toggleHidden(model)
                return
              }
              toast.show({
                message: "Select a provider or model first",
                variant: "warning",
                duration: 2000,
              })
            },
          },
          {
            keybind: Keybind.parse("left")[0],
            title: "(←)Back",
            label: "",
            hidden: false,
            onTrigger: goBack,
          },
          {
            keybind: Keybind.parse("right")[0],
            title: "(→)Next",
            label: "",
            hidden: false,
            onTrigger: goForward,
          },
          {
            keybind: Keybind.parse("backspace")[0],
            title: "",
            hidden: true,
            onTrigger: goBack,
          },
          {
            keybind: Keybind.parse("esc")[0],
            title: "",
            hidden: true,
            onTrigger: goBack,
          },
        ]}
        ref={setRef}
        onMove={(option) => setCurrentOption(option)}
        skipFilter={true}
        hideInput={true}
        title={title()}
        current={selectCurrent()}
        hideCurrentIndicator={page() === "activities"}
        options={options()}
        keybindLayout="inline"
      />
    </ErrorBoundary>
  )
}

function DialogGoogleApiAdd(props: { onCancel: () => void; onSaved: () => void }) {
  const dialog = useDialog()
  const toast = useToast()
  const keybind = useKeybind()
  const theme = useTheme().theme
  const [cursor, setCursor] = createSignal(0)
  const [mode, setMode] = createSignal<"name" | "key" | null>(null)
  const [draft, setDraft] = createSignal("")
  const [name, setName] = createSignal("")
  const [key, setKey] = createSignal("")
  const [nameErr, setNameErr] = createSignal("")
  const [keyErr, setKeyErr] = createSignal("")
  const [saveErr, setSaveErr] = createSignal("")
  const [tick, setTick] = createSignal(0)
  const [inputRef, setInputRef] = createSignal<TextareaRenderable | null>(null)
  const bindings = createMemo(() => {
    const all = useTextareaKeybindings()()
    if (!all) return []
    return all.filter((item) => item.action !== "submit")
  })

  onMount(() => {
    debugCheckpoint("admin.google_add", "mount")
  })

  onCleanup(() => {
    debugCheckpoint("admin.google_add", "cleanup")
  })

  const items = createMemo(() => [
    { id: "name", label: "Account name" },
    { id: "key", label: "API key" },
    { id: "save", label: "Save" },
    { id: "cancel", label: "Cancel" },
  ])

  const value = (id: string) => {
    if (id === "name") return name()
    if (id === "key") return key()
    return ""
  }

  const placeholder = (id: string) => {
    if (id === "name") return "Enter email or account name"
    if (id === "key") return "Enter API key"
    return ""
  }

  const error = (id: string) => {
    if (id === "name") return nameErr()
    if (id === "key") return keyErr()
    if (id === "save") return saveErr()
    return ""
  }

  const resetErrors = () => {
    setNameErr("")
    setKeyErr("")
    setSaveErr("")
  }

  const startEdit = (target: "name" | "key") => {
    resetErrors()
    const next = target === "name" ? name() : key()
    debugCheckpoint("admin.google_add", "start edit", { target, value: next })
    setDraft(next)
    setMode(target)
    setTick((val) => val + 1)
    setTimeout(() => {
      const input = inputRef()
      if (!input) return
      if (input.isDestroyed) return
      input.focus()
      input.gotoLineEnd()
    }, 10)
  }

  const commitEdit = () => {
    const active = mode()
    if (!active) return
    const raw = inputRef()?.plainText ?? draft()
    const next = raw.trim()
    debugCheckpoint("admin.google_add", "commit edit", { target: active, value: next })
    if (active === "name") setName(next)
    if (active === "key") setKey(next)
    setMode(null)
  }

  const cancelEdit = () => {
    debugCheckpoint("admin.google_add", "cancel edit", { target: mode() })
    setDraft("")
    setMode(null)
  }

  const save = async () => {
    return debugSpan("admin.google_add", "save", {}, async () => {
      resetErrors()
      const nextName = name().trim()
      const nextKey = key().trim()
      debugCheckpoint("admin.google_add", "save attempt", { name: nextName, key: nextKey })
      if (!nextName) setNameErr("Account name is required")
      if (!nextKey) setKeyErr("API key is required")
      if (!nextName || !nextKey) {
        debugCheckpoint("admin.google_add", "save blocked missing fields", { name: !!nextName, key: !!nextKey })
        return
      }

      const id = Account.generateId("google-api", "api", nextName)
      const existing = await Account.list("google-api")
        .then((list) => list[id])
        .catch((err) => {
          const msg = String(err instanceof Error ? err.stack || err.message : err)
          setSaveErr(msg)
          debugCheckpoint("admin.google_add", "list accounts failed", { error: msg })
          return undefined
        })
      if (existing) {
        const ok = await DialogConfirm.show(
          dialog,
          "Overwrite account?",
          `Account "${nextName}" already exists. Overwrite it?`,
        )
        debugCheckpoint("admin.google_add", "overwrite prompt", { name: nextName, ok })
        if (!ok) {
          setNameErr("Account name already exists")
          return
        }
      }

      const info: Account.ApiAccount = {
        type: "api",
        name: nextName,
        apiKey: nextKey,
        addedAt: Date.now(),
      }
      const wrote = await Account.add("google-api", id, info)
        .then(() => true)
        .catch((err) => {
          const msg = String(err instanceof Error ? err.stack || err.message : err)
          setSaveErr(msg)
          debugCheckpoint("admin.google_add", "save failed", { error: msg })
          return false
        })
      if (!wrote) return
      debugCheckpoint("admin.google_add", "save success", { id })
      toast.show({ message: "Google-API account saved", variant: "success" })
      props.onSaved()
    })
  }

  const logKey = (evt: KeyEvent, action: string, result: string) => {
    const item = items()[cursor()]
    debugCheckpoint("admin.keytrace", "key", {
      tui: "/admin",
      menu: "google_add",
      option: item?.label ?? "",
      key: Keybind.toString(keybind.parse(evt)),
      action,
      result,
    })
  }

  useKeyboard((evt: KeyEvent) => {
    if (evt.name === "return") {
      logKey(evt, "select option", "attempted")
    } else if (evt.name === "left" || evt.name === "escape" || evt.name === "esc") {
      logKey(evt, "cancel/back", "attempted")
    } else if (evt.name === "up" || evt.name === "down") {
      logKey(evt, "move cursor", "attempted")
    } else {
      logKey(evt, "none", "ignored")
    }
    if (mode()) {
      if (evt.name === "return" || evt.name === "enter") {
        evt.preventDefault()
        evt.stopPropagation()
        commitEdit()
        return
      }
      if (evt.name === "left" || evt.name === "esc") {
        evt.preventDefault()
        evt.stopPropagation()
        cancelEdit()
        return
      }
      return
    }

    if (evt.name === "up") {
      evt.preventDefault()
      setCursor((idx) => Math.max(0, idx - 1))
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      setCursor((idx) => Math.min(items().length - 1, idx + 1))
      return
    }
    if (evt.name === "left" || evt.name === "esc") {
      evt.preventDefault()
      props.onCancel()
      return
    }
    if (evt.name !== "return" && evt.name !== "enter") return
    evt.preventDefault()
    const picked = items()[cursor()]
    if (!picked) return
    if (picked.id === "name") {
      startEdit("name")
      return
    }
    if (picked.id === "key") {
      startEdit("key")
      return
    }
    if (picked.id === "save") {
      void save()
      return
    }
    if (picked.id === "cancel") {
      props.onCancel()
    }
  })

  createEffect(() => {
    dialog.setSize("medium")
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Add Google-API Account
        </text>
        <text fg={theme.textMuted}>left/esc</text>
      </box>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <For each={items()}>
          {(item, index) => {
            const active = createMemo(() => index() === cursor())
            const fg = createMemo(() => (active() ? selectedForeground(theme) : theme.text))
            const val = createMemo(() => value(item.id))
            const placeholderText = createMemo(() => placeholder(item.id))
            const err = createMemo(() => error(item.id))
            const isSave = createMemo(() => item.id === "save")
            const isCancel = createMemo(() => item.id === "cancel")
            const cancelIndex = createMemo(() => index() + 1)
            const isPair = createMemo(() => isSave() && items()[cancelIndex()]?.id === "cancel")
            const saveActive = createMemo(() => cursor() === index())
            const cancelActive = createMemo(() => cursor() === cancelIndex())
            const isEditing = createMemo(() => mode() === item.id)

            return (
              <Show when={!isCancel()}>
                <box flexDirection="column" paddingBottom={1}>
                  <Show
                    when={isPair()}
                    fallback={
                      <box
                        flexDirection="column"
                        paddingLeft={2}
                        paddingRight={2}
                        backgroundColor={active() ? theme.primary : undefined}
                      >
                        <box flexDirection="row">
                          <text fg={fg()} attributes={active() ? TextAttributes.BOLD : undefined}>
                            {item.label}
                          </text>
                          <Show when={(item.id === "name" || item.id === "key") && !isEditing()}>
                            <text fg={val() ? fg() : theme.textMuted}>
                              {" "}
                              {Locale.truncate(val() || placeholderText(), 48)}
                            </text>
                          </Show>
                        </box>
                        <Show when={isEditing()}>
                          <box paddingTop={1} paddingBottom={1}>
                            <textarea
                              height={1}
                              keyBindings={bindings()}
                              placeholder={placeholderText()}
                              ref={(val: TextareaRenderable) => setInputRef(val)}
                              initialValue={draft()}
                              onContentChange={(val) => {
                                if (typeof val === "string") {
                                  setDraft(val)
                                  return
                                }
                                if (val && typeof val === "object" && "text" in val) {
                                  const text = (val as { text?: unknown }).text
                                  setDraft(typeof text === "string" ? text : "")
                                  return
                                }
                                setDraft("")
                              }}
                              onKeyDown={(e) => {
                                if (e.name === "return" || e.name === "enter") {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  commitEdit()
                                }
                                if (e.name === "esc" || e.name === "escape") {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  cancelEdit()
                                }
                              }}
                              focused
                            />
                          </box>
                        </Show>
                      </box>
                    }
                  >
                    <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2}>
                      <box backgroundColor={saveActive() ? theme.primary : undefined} paddingLeft={1} paddingRight={1}>
                        <text
                          fg={saveActive() ? selectedForeground(theme) : theme.text}
                          attributes={saveActive() ? TextAttributes.BOLD : undefined}
                        >
                          Save
                        </text>
                      </box>
                      <box
                        backgroundColor={cancelActive() ? theme.primary : undefined}
                        paddingLeft={1}
                        paddingRight={1}
                      >
                        <text
                          fg={cancelActive() ? selectedForeground(theme) : theme.text}
                          attributes={cancelActive() ? TextAttributes.BOLD : undefined}
                        >
                          Cancel
                        </text>
                      </box>
                    </box>
                  </Show>
                  <Show when={err()}>
                    <box paddingLeft={4} paddingTop={0}>
                      <text fg={theme.error}>{err()}</text>
                    </box>
                  </Show>
                </box>
              </Show>
            )
          }}
        </For>
      </box>
    </box>
  )
}

/**
 * Generic API Key Add Dialog for models.dev providers
 */
function DialogApiKeyAdd(props: {
  providerId: string
  providerName: string
  envVar: string
  onCancel: () => void
  onSaved: () => void
}) {
  const dialog = useDialog()
  const toast = useToast()
  const keybind = useKeybind()
  const theme = useTheme().theme
  const [cursor, setCursor] = createSignal(0)
  const [mode, setMode] = createSignal<"name" | "key" | null>(null)
  const [draft, setDraft] = createSignal("")
  const [name, setName] = createSignal("")
  const [key, setKey] = createSignal("")
  const [nameErr, setNameErr] = createSignal("")
  const [keyErr, setKeyErr] = createSignal("")
  const [saveErr, setSaveErr] = createSignal("")
  const [tick, setTick] = createSignal(0)
  const [inputRef, setInputRef] = createSignal<TextareaRenderable | null>(null)
  const bindings = createMemo(() => {
    const all = useTextareaKeybindings()()
    if (!all) return []
    return all.filter((item) => item.action !== "submit")
  })

  onMount(() => {
    debugCheckpoint("admin.apikey_add", "mount", { provider: props.providerId })
  })

  onCleanup(() => {
    debugCheckpoint("admin.apikey_add", "cleanup", { provider: props.providerId })
  })

  const items = createMemo(() => [
    { id: "name", label: "Account name" },
    { id: "key", label: props.envVar },
    { id: "save", label: "Save" },
    { id: "cancel", label: "Cancel" },
  ])

  const value = (id: string) => {
    if (id === "name") return name()
    if (id === "key") return key()
    return ""
  }

  const placeholder = (id: string) => {
    if (id === "name") return "Enter email or account name"
    if (id === "key") return `Enter ${props.envVar}`
    return ""
  }

  const error = (id: string) => {
    if (id === "name") return nameErr()
    if (id === "key") return keyErr()
    if (id === "save") return saveErr()
    return ""
  }

  const resetErrors = () => {
    setNameErr("")
    setKeyErr("")
    setSaveErr("")
  }

  const startEdit = (target: "name" | "key") => {
    resetErrors()
    const next = target === "name" ? name() : key()
    debugCheckpoint("admin.apikey_add", "start edit", { target, value: next })
    setDraft(next)
    setMode(target)
    setTick((val) => val + 1)
    setTimeout(() => {
      const input = inputRef()
      if (!input) return
      if (input.isDestroyed) return
      input.focus()
      input.gotoLineEnd()
    }, 10)
  }

  const commitEdit = () => {
    const active = mode()
    if (!active) return
    const raw = inputRef()?.plainText ?? draft()
    const next = raw.trim()
    debugCheckpoint("admin.apikey_add", "commit edit", { target: active, value: next })
    if (active === "name") setName(next)
    if (active === "key") setKey(next)
    setMode(null)
  }

  const cancelEdit = () => {
    debugCheckpoint("admin.apikey_add", "cancel edit", { target: mode() })
    setDraft("")
    setMode(null)
  }

  const save = async () => {
    resetErrors()
    const nextName = name().trim()
    const nextKey = key().trim()
    debugCheckpoint("admin.apikey_add", "save attempt", { name: nextName, provider: props.providerId })
    if (!nextName) setNameErr("Account name is required")
    if (!nextKey) setKeyErr(`${props.envVar} is required`)
    if (!nextName || !nextKey) {
      debugCheckpoint("admin.apikey_add", "save blocked missing fields", { name: !!nextName, key: !!nextKey })
      return
    }

    const id = Account.generateId(props.providerId, "api", nextName)
    const existing = await Account.list(props.providerId)
      .then((list) => list[id])
      .catch((err) => {
        const msg = String(err instanceof Error ? err.stack || err.message : err)
        setSaveErr(msg)
        debugCheckpoint("admin.apikey_add", "list accounts failed", { error: msg })
        return undefined
      })
    if (existing) {
      const ok = await DialogConfirm.show(
        dialog,
        "Overwrite account?",
        `Account "${nextName}" already exists. Overwrite it?`,
      )
      debugCheckpoint("admin.apikey_add", "overwrite prompt", { name: nextName, ok })
      if (!ok) {
        setNameErr("Account name already exists")
        return
      }
    }

    const info: Account.ApiAccount = {
      type: "api",
      name: nextName,
      apiKey: nextKey,
      addedAt: Date.now(),
    }
    const wrote = await Account.add(props.providerId, id, info)
      .then(() => true)
      .catch((err) => {
        const msg = String(err instanceof Error ? err.stack || err.message : err)
        setSaveErr(msg)
        debugCheckpoint("admin.apikey_add", "save failed", { error: msg })
        return false
      })
    if (!wrote) return
    debugCheckpoint("admin.apikey_add", "save success", { id, provider: props.providerId })
    toast.show({ message: `${props.providerName} account saved`, variant: "success" })
    props.onSaved()
  }

  const logKey = (evt: KeyEvent, action: string, result: string) => {
    const item = items()[cursor()]
    debugCheckpoint("admin.keytrace", "key", {
      tui: "/admin",
      menu: "apikey_add",
      option: item?.label ?? "",
      key: Keybind.toString(keybind.parse(evt)),
      action,
      result,
    })
  }

  useKeyboard((evt: KeyEvent) => {
    if (evt.name === "return") {
      logKey(evt, "select option", "attempted")
    } else if (evt.name === "left" || evt.name === "escape" || evt.name === "esc") {
      logKey(evt, "cancel/back", "attempted")
    } else if (evt.name === "up" || evt.name === "down") {
      logKey(evt, "move cursor", "attempted")
    } else {
      logKey(evt, "none", "ignored")
    }
    if (mode()) {
      if (evt.name === "return" || evt.name === "enter") {
        evt.preventDefault()
        evt.stopPropagation()
        commitEdit()
        return
      }
      if (evt.name === "left" || evt.name === "esc") {
        evt.preventDefault()
        evt.stopPropagation()
        cancelEdit()
        return
      }
      return
    }

    if (evt.name === "up") {
      evt.preventDefault()
      setCursor((idx) => Math.max(0, idx - 1))
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      setCursor((idx) => Math.min(items().length - 1, idx + 1))
      return
    }
    if (evt.name === "left" || evt.name === "esc") {
      evt.preventDefault()
      props.onCancel()
      return
    }
    if (evt.name !== "return" && evt.name !== "enter") return
    evt.preventDefault()
    const picked = items()[cursor()]
    if (!picked) return
    if (picked.id === "name") {
      startEdit("name")
      return
    }
    if (picked.id === "key") {
      startEdit("key")
      return
    }
    if (picked.id === "save") {
      void save()
      return
    }
    if (picked.id === "cancel") {
      props.onCancel()
    }
  })

  createEffect(() => {
    dialog.setSize("medium")
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Add {props.providerName} Account
        </text>
        <text fg={theme.textMuted}>left/esc</text>
      </box>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <For each={items()}>
          {(item, index) => {
            const active = createMemo(() => index() === cursor())
            const fg = createMemo(() => (active() ? selectedForeground(theme) : theme.text))
            const val = createMemo(() => value(item.id))
            const placeholderText = createMemo(() => placeholder(item.id))
            const err = createMemo(() => error(item.id))
            const isSave = createMemo(() => item.id === "save")
            const isCancel = createMemo(() => item.id === "cancel")
            const cancelIndex = createMemo(() => index() + 1)
            const isPair = createMemo(() => isSave() && items()[cancelIndex()]?.id === "cancel")
            const saveActive = createMemo(() => cursor() === index())
            const cancelActive = createMemo(() => cursor() === cancelIndex())
            const isEditing = createMemo(() => mode() === item.id)

            return (
              <Show when={!isCancel()}>
                <box flexDirection="column" paddingBottom={1}>
                  <Show
                    when={isPair()}
                    fallback={
                      <box
                        flexDirection="column"
                        paddingLeft={2}
                        paddingRight={2}
                        backgroundColor={active() ? theme.primary : undefined}
                      >
                        <box flexDirection="row">
                          <text fg={fg()} attributes={active() ? TextAttributes.BOLD : undefined}>
                            {item.label}
                          </text>
                          <Show when={(item.id === "name" || item.id === "key") && !isEditing()}>
                            <text fg={val() ? fg() : theme.textMuted}>
                              {" "}
                              {Locale.truncate(val() || placeholderText(), 48)}
                            </text>
                          </Show>
                        </box>
                        <Show when={isEditing()}>
                          <box paddingTop={1} paddingBottom={1}>
                            <textarea
                              height={1}
                              keyBindings={bindings()}
                              placeholder={placeholderText()}
                              ref={(val: TextareaRenderable) => setInputRef(val)}
                              initialValue={draft()}
                              onContentChange={(val) => {
                                if (typeof val === "string") {
                                  setDraft(val)
                                  return
                                }
                                if (val && typeof val === "object" && "text" in val) {
                                  const text = (val as { text?: unknown }).text
                                  setDraft(typeof text === "string" ? text : "")
                                  return
                                }
                                setDraft("")
                              }}
                              onKeyDown={(e) => {
                                if (e.name === "return" || e.name === "enter") {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  commitEdit()
                                }
                                if (e.name === "esc" || e.name === "escape") {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  cancelEdit()
                                }
                              }}
                              focused
                            />
                          </box>
                        </Show>
                      </box>
                    }
                  >
                    <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2}>
                      <box backgroundColor={saveActive() ? theme.primary : undefined} paddingLeft={1} paddingRight={1}>
                        <text
                          fg={saveActive() ? selectedForeground(theme) : theme.text}
                          attributes={saveActive() ? TextAttributes.BOLD : undefined}
                        >
                          Save
                        </text>
                      </box>
                      <box
                        backgroundColor={cancelActive() ? theme.primary : undefined}
                        paddingLeft={1}
                        paddingRight={1}
                      >
                        <text
                          fg={cancelActive() ? selectedForeground(theme) : theme.text}
                          attributes={cancelActive() ? TextAttributes.BOLD : undefined}
                        >
                          Cancel
                        </text>
                      </box>
                    </box>
                  </Show>
                  <Show when={err()}>
                    <box paddingLeft={4} paddingTop={0}>
                      <text fg={theme.error}>{err()}</text>
                    </box>
                  </Show>
                </box>
              </Show>
            )
          }}
        </For>
      </box>
    </box>
  )
}

function formatReason(reason: string): string {
  if (!reason) return "Unknown"
  // If the reason already contains an HTTP code or looks like a status code, return it as is
  // e.g. "HTTP 429", "503 Service Unavailable"
  if (reason.startsWith("HTTP") || /^\d{3}/.test(reason)) {
    return reason
  }

  switch (reason) {
    case "QUOTA_EXHAUSTED":
      return "Quota (429)"
    case "RATE_LIMIT_EXCEEDED":
      return "Rate Limit (429)"
    case "MODEL_CAPACITY_EXHAUSTED":
      return "Overloaded (503)"
    case "SERVER_ERROR":
      return "Server Error (500)"
    case "TIMEOUT":
      return "Timeout (408)"
    default:
      return reason
  }
}

function formatWait(waitMs: number): string {
  const totalSec = Math.ceil(waitMs / 1000)
  const days = Math.floor(totalSec / (3600 * 24))
  const hours = Math.floor((totalSec % (3600 * 24)) / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60

  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${pad(days)}:${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

/**
 * Dialog to edit account name
 * Uses cursor-based navigation with inline editing (same pattern as DialogGoogleApiAdd)
 */
function DialogAccountEdit(props: {
  providerKey: string
  accountId: string
  currentName: string
  onCancel: () => void
  onSaved: () => void
}) {
  const dialog = useDialog()
  const toast = useToast()
  const theme = useTheme().theme
  const [cursor, setCursor] = createSignal(0) // 0=name, 1=save, 2=cancel
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [name, setName] = createSignal(props.currentName)
  const [nameErr, setNameErr] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [tick, setTick] = createSignal(0)
  const [inputRef, setInputRef] = createSignal<TextareaRenderable | null>(null)
  const bindings = createMemo(() => {
    const all = useTextareaKeybindings()()
    if (!all) return []
    return all.filter((item) => item.action !== "submit")
  })

  onMount(() => {
    debugCheckpoint("admin.account_edit", "mount", { providerKey: props.providerKey, id: props.accountId })
  })

  const startEdit = () => {
    setNameErr("")
    setDraft(name())
    setEditing(true)
    setTick((t) => t + 1)
    setTimeout(() => {
      const input = inputRef()
      if (input && !input.isDestroyed) {
        input.focus()
        input.gotoLineEnd()
      }
    }, 50)
  }

  const commitEdit = () => {
    const raw = inputRef()?.plainText ?? draft()
    const newName = raw.trim()
    debugCheckpoint("admin.account_edit", "commit edit", { newName })
    setName(newName)
    setEditing(false)
  }

  const cancelEdit = () => {
    debugCheckpoint("admin.account_edit", "cancel edit")
    setDraft("")
    setEditing(false)
  }

  const save = async () => {
    setNameErr("")
    const newName = name().trim()
    if (!newName) {
      setNameErr("Name is required")
      return
    }
    if (newName === props.currentName) {
      props.onCancel()
      return
    }

    setSaving(true)
    try {
      const info = await Account.get(props.providerKey, props.accountId)
      if (!info) {
        setNameErr("Account not found")
        setSaving(false)
        return
      }

      // Update the account with new name
      await Account.update(props.providerKey, props.accountId, { ...info, name: newName })
      await Account.refresh()

      debugCheckpoint("admin.account_edit", "save success", {
        providerKey: props.providerKey,
        id: props.accountId,
        newName,
      })
      toast.show({ message: "Account name updated", variant: "success", duration: 2000 })
      props.onSaved()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setNameErr(msg)
      debugCheckpoint("admin.account_edit", "save failed", { error: msg })
    } finally {
      setSaving(false)
    }
  }

  useKeyboard((evt: KeyEvent) => {
    // When editing, handle textarea-specific keys
    if (editing()) {
      if (evt.name === "return" || evt.name === "enter") {
        evt.preventDefault()
        evt.stopPropagation()
        commitEdit()
        return
      }
      if (evt.name === "esc" || evt.name === "escape") {
        evt.preventDefault()
        evt.stopPropagation()
        cancelEdit()
        return
      }
      // Let other keys pass through to textarea
      return
    }

    // Navigation mode
    if (evt.name === "up") {
      evt.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      setCursor((c) => Math.min(2, c + 1))
      return
    }
    if (evt.name === "left" || evt.name === "esc" || evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      props.onCancel()
      return
    }
    if (evt.name === "return" || evt.name === "enter") {
      evt.preventDefault()
      evt.stopPropagation()
      if (cursor() === 0) {
        startEdit()
      } else if (cursor() === 1) {
        void save()
      } else if (cursor() === 2) {
        props.onCancel()
      }
      return
    }
  })

  createEffect(() => {
    dialog.setSize("medium")
  })

  const items = [
    { id: "name", label: "Account name" },
    { id: "save", label: "Save" },
    { id: "cancel", label: "Cancel" },
  ]

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Edit Account Name
        </text>
        <text fg={theme.textMuted}>left/esc</text>
      </box>
      <box paddingLeft={1} paddingRight={1}>
        <text fg={theme.textMuted}>Account ID: {props.accountId}</text>
      </box>
      <box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <For each={items}>
          {(item, index) => {
            const active = createMemo(() => index() === cursor())
            const fg = createMemo(() => (active() ? selectedForeground(theme) : theme.text))
            const isNameField = item.id === "name"
            const isSave = item.id === "save"
            const isCancel = item.id === "cancel"

            return (
              <Show when={!isCancel}>
                <box flexDirection="column" paddingBottom={1}>
                  <Show
                    when={isSave}
                    fallback={
                      <box
                        flexDirection="column"
                        paddingLeft={2}
                        paddingRight={2}
                        backgroundColor={active() ? theme.primary : undefined}
                      >
                        <box flexDirection="row">
                          <text fg={fg()} attributes={active() ? TextAttributes.BOLD : undefined}>
                            {item.label}
                          </text>
                          <Show when={isNameField && !editing()}>
                            <text fg={name() ? fg() : theme.textMuted}>
                              {" "}
                              {Locale.truncate(name() || "Enter email or account name", 48)}
                            </text>
                          </Show>
                        </box>
                        <Show when={isNameField && editing()}>
                          <box paddingTop={1} paddingBottom={1}>
                            <textarea
                              height={1}
                              keyBindings={bindings()}
                              placeholder="Enter email or account name"
                              ref={(val: TextareaRenderable) => setInputRef(val)}
                              initialValue={draft()}
                              onContentChange={(val) => {
                                if (typeof val === "string") {
                                  setDraft(val)
                                  return
                                }
                                if (val && typeof val === "object" && "text" in val) {
                                  const text = (val as { text?: unknown }).text
                                  setDraft(typeof text === "string" ? text : "")
                                  return
                                }
                                setDraft("")
                              }}
                              onKeyDown={(e) => {
                                if (e.name === "return" || e.name === "enter") {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  commitEdit()
                                }
                                if (e.name === "esc" || e.name === "escape") {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  cancelEdit()
                                }
                              }}
                              focused
                            />
                          </box>
                        </Show>
                      </box>
                    }
                  >
                    <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2}>
                      <box
                        backgroundColor={cursor() === 1 ? theme.primary : undefined}
                        paddingLeft={1}
                        paddingRight={1}
                      >
                        <text
                          fg={cursor() === 1 ? selectedForeground(theme) : theme.text}
                          attributes={cursor() === 1 ? TextAttributes.BOLD : undefined}
                        >
                          Save
                        </text>
                      </box>
                      <box
                        backgroundColor={cursor() === 2 ? theme.primary : undefined}
                        paddingLeft={1}
                        paddingRight={1}
                      >
                        <text
                          fg={cursor() === 2 ? selectedForeground(theme) : theme.text}
                          attributes={cursor() === 2 ? TextAttributes.BOLD : undefined}
                        >
                          Cancel
                        </text>
                      </box>
                    </box>
                  </Show>
                  <Show when={isNameField && nameErr()}>
                    <box paddingLeft={4} paddingTop={0}>
                      <text fg={theme.error}>{nameErr()}</text>
                    </box>
                  </Show>
                </box>
              </Show>
            )
          }}
        </For>
      </box>
    </box>
  )
}

/**
 * Dialog to view account JSON
 */
function DialogAccountView(props: {
  providerKey: string
  accountId: string
  accountInfo: Account.Info
  onClose: () => void
}) {
  const dialog = useDialog()
  const theme = useTheme().theme
  const [scrollOffset, setScrollOffset] = createSignal(0)

  // Mask sensitive fields
  const maskedInfo = createMemo(() => {
    const info: Record<string, unknown> = { ...props.accountInfo }
    const maskToken = (token: string) => {
      if (token.length <= 12) return token
      return token.slice(0, 8) + "..." + token.slice(-4)
    }
    // Mask sensitive fields
    if (typeof info.apiKey === "string") info.apiKey = maskToken(info.apiKey)
    if (typeof info.refreshToken === "string") info.refreshToken = maskToken(info.refreshToken)
    if (typeof info.accessToken === "string") info.accessToken = maskToken(info.accessToken)
    return info
  })

  const jsonStr = createMemo(() => JSON.stringify(maskedInfo(), null, 2))
  const lines = createMemo(() => jsonStr().split("\n"))
  const visibleLines = 15

  onMount(() => {
    debugCheckpoint("admin.account_view", "mount", { providerKey: props.providerKey, id: props.accountId })
  })

  useKeyboard((evt: KeyEvent) => {
    if (
      evt.name === "left" ||
      evt.name === "esc" ||
      evt.name === "escape" ||
      evt.name === "return" ||
      evt.name === "enter"
    ) {
      evt.preventDefault()
      evt.stopPropagation()
      props.onClose()
      return
    }
    if (evt.name === "up") {
      evt.preventDefault()
      setScrollOffset(Math.max(0, scrollOffset() - 1))
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      setScrollOffset(Math.min(Math.max(0, lines().length - visibleLines), scrollOffset() + 1))
      return
    }
  })

  createEffect(() => {
    dialog.setSize("large")
  })

  const displayLines = createMemo(() => {
    return lines().slice(scrollOffset(), scrollOffset() + visibleLines)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          View Account: {props.accountId}
        </text>
        <text fg={theme.textMuted}>any key to close</text>
      </box>
      <box paddingLeft={1} paddingRight={1} flexDirection="column">
        <For each={displayLines()}>{(line) => <text fg={theme.text}>{line}</text>}</For>
      </box>
      <Show when={lines().length > visibleLines}>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>
            Lines {scrollOffset() + 1}-{Math.min(scrollOffset() + visibleLines, lines().length)} of {lines().length} (↑↓
            to scroll)
          </text>
        </box>
      </Show>
    </box>
  )
}
