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
import { map, pipe, entries, filter, sortBy } from "remeda"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider } from "./dialog-provider"
import { DialogAccount } from "./dialog-account"
import { useKeybind } from "../context/keybind"
import { useTheme } from "@tui/context/theme"
import { iife } from "@/util/iife"
import { Account } from "@/account"
import { Keybind } from "@/util/keybind"
import { AccountManager } from "../../../../plugin/antigravity/plugin/accounts"
import { ModelsDev } from "@/provider/models"
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
import { getModelHealthRegistry, getRateLimitTracker } from "@/account/rotation"
import { Provider } from "@/provider/provider"
import { probeModelAvailability } from "../util/model-probe"
import { Auth } from "@/auth"
import { checkAccountsQuota, type QuotaGroup, type QuotaGroupSummary } from "@/plugin/antigravity/plugin/quota"
import { loadAccounts, saveAccounts } from "@/plugin/antigravity/plugin/storage"
import { getModelFamily } from "@/plugin/antigravity/plugin/transform/model-resolver"

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
  const local = useLocal()
  const sync = useSync()
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
  const CODEX_ISSUER = "https://auth.openai.com"
  const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
  const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

  // Navigation State
  // steps: root -> account_select -> model_select
  const [step, setStep] = createSignal<"root" | "account_select" | "model_select">("root")
  const pages = ["activities", "providers"] as const
  type Page = (typeof pages)[number]
  const [page, setPage] = createSignal<Page>("activities")
  const [selectedFamily, setSelectedFamily] = createSignal<string | null>(null)

  // This tracks the "provider ID" that models.ts/sync system naturally understands
  // For Antigravity, it's the generic "antigravity". For others, it might be specific IDs.
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
    setSelectedFamily(null)
    setSelectedProviderID(null)
  }

  onMount(() => {
    dialog.setSize("xlarge")
    debugCheckpoint("admin", "mount", { step: step(), family: selectedFamily() })
    setQuotaRefresh((v) => v + 1)
  })

  onCleanup(() => {
    debugCheckpoint("admin", "cleanup", { step: step(), family: selectedFamily() })
  })

  createEffect(() => {
    const next = step()
    const prev = prevStep()
    if (next === prev) return
    debugCheckpoint("admin", "step change", {
      from: prev,
      to: next,
      family: selectedFamily(),
      provider: selectedProviderID(),
    })
    setPrevStep(next)
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

    if (s === "account_select" && selectedFamily() === "google-api") {
      const parsed = keybind.parse(evt)
      debugCheckpoint("admin.key", "event", {
        name: evt.name,
        ctrl: evt.ctrl,
        meta: evt.meta,
        shift: evt.shift,
        super: evt.super,
        parsed,
        step: step(),
        family: selectedFamily(),
      })
    }
    if (evt.name !== "a") return
    if (evt.ctrl || evt.meta || evt.super) return
    if (step() !== "account_select") return
    if (selectedFamily() !== "google-api") return
    evt.preventDefault()
    evt.stopPropagation()
    debugCheckpoint("admin", "google add keybind", { step: step(), family: selectedFamily() })
    openGoogleAdd()
  })

  createEffect(() => {
    if (step() !== "account_select") return
    if (selectedFamily() !== "google-api") return
    debugCheckpoint("admin", "enter google account list")
  })

  const lockBackOnce = () => {
    setLockBack(true)
    setTimeout(() => setLockBack(false), 200)
  }

  // Load Antigravity Manager for accurate account listing
  // To trigger UI updates when we change active account (since sync might lag)
  const [refreshSignal, setRefreshSignal] = createSignal(0)
  const forceRefresh = () => setRefreshSignal((s) => s + 1)

  const [agManager] = createResource(refreshSignal, async () => {
    try {
      return await AccountManager.loadFromDisk()
    } catch (e) {
      return null
    }
  })
  const [coreAll] = createResource(refreshSignal, async () => {
    try {
      // Refresh from disk to get latest account data
      await Account.refresh()
      return await Account.listAll()
    } catch (e) {
      return {}
    }
  })
  const refreshAntigravity = async () => {
    try {
      const mod = await import("../../../../plugin/antigravity")
      if (mod.refreshGlobalAccountManager) {
        await mod.refreshGlobalAccountManager()
      }
    } catch {}
  }
  const [coreAg] = createResource(refreshSignal, async () => {
    try {
      // Refresh from disk to get latest account data
      await Account.refresh()
      return await Account.list("antigravity")
    } catch (e) {
      return {}
    }
  })
  const [coreActive] = createResource(refreshSignal, async () => {
    try {
      return await Account.getActive("antigravity")
    } catch (e) {
      return undefined
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
  const activityInterval = setInterval(() => setActivityTick((t) => t + 1), 1000)
  onCleanup(() => clearInterval(activityInterval))

  const [activityProviders] = createResource<Record<string, Provider.Info>>(() => Provider.list().catch(() => ({})))
  const [activityAccounts] = createResource<Record<string, Account.ProviderData>>(() =>
    Account.listAll().catch(() => ({})),
  )
  const [quotaGroups] = createResource(quotaRefresh, async () => {
    try {
      const storage = await loadAccounts()
      if (!storage || storage.accounts.length === 0) return null
      const results = await checkAccountsQuota(storage.accounts, {} as any)

      let shouldSave = false
      for (const res of results) {
        if (res.updatedAccount) {
          storage.accounts[res.index] = res.updatedAccount
          shouldSave = true
        }
      }
      if (shouldSave) {
        await saveAccounts(storage)
      }

      const coreAccounts = await Account.list("antigravity").catch(() => ({}))
      const coreByToken = new Map<string, string>()
      const coreByEmail = new Map<string, string>()
      for (const [id, info] of Object.entries(coreAccounts)) {
        if (info.type !== "subscription") continue
        if (info.refreshToken) coreByToken.set(info.refreshToken, id)
        if (info.email) coreByEmail.set(info.email, id)
      }

      const groupsByAccount: Record<string, Partial<Record<QuotaGroup, QuotaGroupSummary>>> = {}
      for (const res of results) {
        const account = storage.accounts[res.index]
        if (!account) continue
        const token = account.refreshToken
        const email = account.email
        const coreId = (token && coreByToken.get(token)) ?? (email && coreByEmail.get(email))
        if (!coreId) continue
        groupsByAccount[coreId] = res.quota?.groups ?? {}
      }

      return groupsByAccount
    } catch (error) {
      debugCheckpoint("admin.quota", "fetch error", { error: String(error) })
      return null
    }
  })
  const [codexQuota] = createResource(quotaRefresh, async () => {
    try {
      const accounts = await Account.list("openai")
      const results: Record<string, { hourlyRemaining: number; weeklyRemaining: number } | null> = {}

      for (const [id, info] of Object.entries(accounts)) {
        if (info.type !== "subscription") continue

        let access = info.accessToken
        let expires = info.expiresAt
        let refresh = info.refreshToken
        let accountId = info.accountId

        if (!access || !expires || expires < Date.now()) {
          try {
            const tokens = await refreshCodexAccessToken(refresh)
            access = tokens.access_token
            refresh = tokens.refresh_token ?? refresh
            expires = Date.now() + (tokens.expires_in ?? 3600) * 1000
            accountId = accountId ?? extractAccountIdFromTokens(tokens)

            await Account.update("openai", id, {
              refreshToken: refresh,
              accessToken: access,
              expiresAt: expires,
              accountId,
            })
          } catch (e) {
            debugCheckpoint("admin.quota", "token refresh failed", { id, error: String(e) })
            results[id] = null
            continue
          }
        }

        try {
          const headers = new Headers({ Authorization: `Bearer ${access}`, Accept: "application/json" })
          if (accountId) headers.set("ChatGPT-Account-Id", accountId)

          const response = await fetch(CODEX_USAGE_URL, { headers })
          if (!response.ok) {
            debugCheckpoint("admin.quota", "codex usage error", { id, status: response.status })
            results[id] = null
            continue
          }
          const usage = (await response.json()) as any
          const hourlyUsed = usage?.rate_limit?.primary_window?.used_percent ?? 0
          const weeklyUsed = usage?.rate_limit?.secondary_window?.used_percent ?? 0
          const hourlyRemaining = clampPercentage(100 - hourlyUsed)
          const weeklyRemaining = clampPercentage(100 - weeklyUsed)
          results[id] = { hourlyRemaining, weeklyRemaining }
        } catch (e) {
          debugCheckpoint("admin.quota", "fetch usage failed", { id, error: String(e) })
          results[id] = null
        }
      }
      return results
    } catch (error) {
      debugCheckpoint("admin.quota", "codex fetch error", { error: String(error) })
      return {}
    }
  })

  const connected = useConnected()
  createEffect(() => {
    const currentStep = step()
    const pid = selectedProviderID()
    refreshSignal()
    if (currentStep !== "model_select" || !pid) return
    if (family(pid) !== "google-api") return
    if (googleModelsLoaded()) return
    loadGoogleModels()
  })

  const family = (id: string) => {
    const parsed = Account.parseProvider(id)
    if (parsed) return parsed
    if (id === "opencode" || id.startsWith("opencode-")) return "opencode"
    return undefined
  }

  onMount(() => {
    if (!props.targetProviderID) return
    const targetFamily = family(props.targetProviderID)
    if (targetFamily) setSelectedFamily(targetFamily)
    setSelectedProviderID(props.targetProviderID)
    setPage("providers")
    setStep("model_select")
  })

  const label = (name: string, id: string) => {
    return Account.getProviderLabel(family(id) || id)
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
    const fam = Account.parseFamily(providerId)
    if (!fam) return false

    const familyData = coreAll()?.[fam]
    const activeAccountId = familyData?.activeAccount
    const activeAccountInfo = activeAccountId ? familyData?.accounts?.[activeAccountId] : undefined

    // If using a subscription account, models are NOT free (quota-based)
    if (activeAccountInfo?.type === "subscription") {
      return false
    }

    // For API accounts, check the actual cost
    return isFreeCost(modelInfo)
  }

  function clampPercentage(value: number): number {
    if (!Number.isFinite(value)) return 0
    if (value < 0) return 0
    if (value > 100) return 100
    return Math.round(value)
  }

  type CodexTokenResponse = {
    id_token?: string
    access_token: string
    refresh_token?: string
    expires_in?: number
  }

  type CodexIdTokenClaims = {
    chatgpt_account_id?: string
    organizations?: Array<{ id: string }>
    "https://api.openai.com/auth"?: {
      chatgpt_account_id?: string
    }
  }

  function parseCodexJwtClaims(token: string): CodexIdTokenClaims | undefined {
    const parts = token.split(".")
    if (parts.length !== 3) return undefined
    try {
      return JSON.parse(Buffer.from(parts[1], "base64url").toString())
    } catch {
      return undefined
    }
  }

  function extractAccountIdFromClaims(claims: CodexIdTokenClaims): string | undefined {
    return (
      claims.chatgpt_account_id ||
      claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
      claims.organizations?.[0]?.id
    )
  }

  function extractAccountIdFromTokens(tokens: CodexTokenResponse): string | undefined {
    if (tokens.id_token) {
      const claims = parseCodexJwtClaims(tokens.id_token)
      if (claims) {
        const accountId = extractAccountIdFromClaims(claims)
        if (accountId) return accountId
      }
    }
    const claims = parseCodexJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }

  async function refreshCodexAccessToken(refreshToken: string): Promise<CodexTokenResponse> {
    const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }).toString(),
    })
    if (!response.ok) {
      throw new Error(`Codex token refresh failed: ${response.status}`)
    }
    return response.json()
  }

  function resolveQuotaGroup(modelID: string, displayName?: string): QuotaGroup | null {
    const combined = `${modelID} ${displayName ?? ""}`.toLowerCase()
    if (combined.includes("claude")) return "claude"
    const isGemini3 = combined.includes("gemini-3") || combined.includes("gemini 3")
    if (!isGemini3) return null
    const family = getModelFamily(modelID)
    return family === "gemini-flash" ? "gemini-flash" : "gemini-pro"
  }

  function getQuotaPercent(
    accountId: string | undefined,
    providerId: string,
    modelID: string,
    displayName?: string,
  ): number | undefined {
    if (family(providerId) !== "antigravity") return undefined
    if (!accountId) return undefined
    const groups = quotaGroups()?.[accountId]
    if (!groups) return undefined
    const group = resolveQuotaGroup(modelID, displayName)
    if (!group) return undefined
    const remaining = groups[group]?.remainingFraction
    if (typeof remaining !== "number") return undefined
    return Math.round(remaining * 100)
  }

  function formatQuotaFooter(
    accountId: string,
    providerId: string,
    modelID: string,
    displayName: string | undefined,
    fallbackFree: boolean,
    isRateLimited?: boolean,
    waitMs?: number,
  ): string | undefined {
    if (family(providerId) === "openai" || providerId === "openai") {
      if (isRateLimited && waitMs && waitMs > 0) return `0% ⏳ ${formatWait(waitMs)}`
      if (isRateLimited) return "5H:0% WK:0%"
      const quotaMap = codexQuota()
      const quota = quotaMap?.[accountId]
      if (!quota) return "5H:-- WK:--"
      return `5H:${quota.hourlyRemaining}% WK:${quota.weeklyRemaining}%`
    }
    if (isRateLimited && waitMs && waitMs > 0) return `0% ⏳ ${formatWait(waitMs)}`
    if (isRateLimited) return "0%"
    const percent = getQuotaPercent(accountId, providerId, modelID, displayName)
    if (typeof percent === "number") return `${percent}%`
    if (fallbackFree) return "100%"
    if (family(providerId) === "antigravity") return "--"
    return undefined
  }

  const owner = (provider: { id: string; name: string; email?: string }) => {
    const fam = family(provider.id)
    if (!fam) return undefined

    // Agnostic owner fallback
    const info = {
      type: "subscription",
      name: provider.name,
      email: provider.email,
    }
    const display = Account.getDisplayName(provider.id, info as any, fam as string)
    return display || undefined
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

  const probeAndSelectModel = (providerId: string, modelID: string, origin?: string) => {
    // Skip probe - directly select the model
    debugCheckpoint("admin", "model selected (probe skipped)", { provider: providerId, model: modelID, origin })
    local.model.set(
      { providerId: providerId, modelID: modelID },
      { recent: true, skipValidation: true, announce: true },
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
          .map((model: any) => {
            const rawName = typeof model.name === "string" ? model.name : ""
            const id = rawName.replace(/^models\//, "")
            const title = model.displayName || id || rawName
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

  // Group providers by family from SYNC data (for Level 1 list)
  const groupedProviders = createMemo(() => {
    const groups = new Map<string, any[]>()
    for (const p of sync.data.provider) {
      const fam = family(p.id)
      if (!fam) continue
      if (!groups.has(fam)) groups.set(fam, [])
      groups.get(fam)!.push(p)
    }
    return groups
  })

  const activityData = createMemo(() => {
    activityTick()
    debugCheckpoint("admin.activities", "snapshot", { tick: activityTick() })

    const rateLimitTracker = getRateLimitTracker()
    const rateLimits3D = rateLimitTracker.getSnapshot3D()

    const registry = getModelHealthRegistry()
    const snapshot2D = registry.getSnapshot()

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
      const labelA = Account.getProviderLabel(family(a.providerId) || a.providerId)
      const labelB = Account.getProviderLabel(family(b.providerId) || b.providerId)
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
    const widths = sortedModels.reduce(
      (acc, entry) => {
        const providerLabel = Account.getProviderLabel(family(entry.providerId) || entry.providerId) || "-"
        acc.provider = Math.max(acc.provider, providerLabel.length)
        acc.model = Math.max(acc.model, (entry.modelId || "-").length)
        const accountFamily = family(entry.providerId) ?? entry.providerId
        const accountData = accountMap[entry.providerId] ?? accountMap[accountFamily]
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

    const currentModel = local.model.current()

    for (const entryModel of sortedModels) {
      const providerId = entryModel.providerId
      const modelId = entryModel.modelId
      const isCurrentModel = currentModel?.providerId === providerId && currentModel?.modelID === modelId
      const accountFamily = family(providerId) ?? providerId
      const accountData = accountMap[providerId] ?? accountMap[accountFamily]
      const activeAccountId = accountData?.activeAccount
      const accountIds = accountData ? Object.keys(accountData.accounts) : []
      const list = accountIds.length > 0 ? accountIds : ["-"]
      const providerLabel = Account.getProviderLabel(family(providerId) || providerId)
      const providerCol = (providerLabel || "-").padEnd(widths.provider)
      const modelCol = (modelId || "-").padEnd(widths.model)
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
        const accountCol = `${display || "-"}`.padEnd(widths.account)
        const titleProviderCol = i === 0 ? providerCol : "".padEnd(widths.provider)
        const titleModelCol = i === 0 ? modelCol : "".padEnd(widths.model)
        const isCurrentAccount = isCurrentModel && activeAccountId && activeAccountId === accountId
        const rowSuffix = isCurrentAccount ? " ✅" : ""

        const modelKey = `${providerId}:${modelId}`
        const modelEntry = modelLimits.get(`${accountId}:${providerId}:${modelId}`)
        if (modelEntry && modelEntry.waitMs > 0) {
          limited += 1
          const statusText = `⏳ ${formatWait(modelEntry.waitMs)}${rowSuffix}`
          items.push({
            value: `${accountId}:${providerId}:${modelId}`,
            title: `${titleProviderCol} ${titleModelCol} ${branchColValue}${accountCol}  ${statusText}`,
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
          const statusText = `⏳ ${formatWait(providerLimit.waitMs)}${rowSuffix}`
          items.push({
            value: `${accountId}:${providerId}:${modelId}`,
            title: `${titleProviderCol} ${titleModelCol} ${branchColValue}${accountCol}  ${statusText}`,
            description: "",
            category: "",
            footer: "",
            truncate: "none",
          })
          continue
        }

        const state2d = snapshot2D.get(modelKey)
        if (state2d && state2d.waitMs > 0) {
          limited += 1
          const statusText = `⏳ ${formatWait(state2d.waitMs)}${rowSuffix}`
          items.push({
            value: `${accountId}:${providerId}:${modelId}`,
            title: `${titleProviderCol} ${titleModelCol} ${branchColValue}${accountCol}  ${statusText}`,
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
        if (quotaFooter || (state2d && state2d.available)) {
          ready += 1
          const readyFooter = (quotaFooter ?? "✓ Ready") + rowSuffix
          items.push({
            value: `${accountId}:${providerId}:${modelId}`,
            title: `${titleProviderCol} ${titleModelCol} ${branchColValue}${accountCol}  ${readyFooter}`,
            description: "",
            category: "",
            footer: "",
            truncate: "none",
          })
          continue
        }

        items.push({
          value: `${accountId}:${providerId}:${modelId}`,
          title: `${titleProviderCol} ${titleModelCol} ${branchColValue}${accountCol}  -${rowSuffix}`,
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
      const headerProvider = "Provider".padEnd(widths.provider)
      const headerModel = "Model".padEnd(widths.model)
      const headerBranch = "".padEnd(branchWidth)
      const headerAccount = "Account".padEnd(widths.account)
      items.unshift({
        value: "_header",
        title: `${headerProvider} ${headerModel} ${headerBranch}${headerAccount}  Status`,
        description: "",
        category: "",
        footer: "",
        truncate: "none",
      })
    }

    return { items, stats: { ready, limited, total: ready + limited } }
  })

  const selectActivity = (value: string) => {
    if (!value || value === "_header" || value === "empty") return
    const [accountId, providerId, ...rest] = value.split(":")
    const modelID = rest.join(":")
    if (!providerId || !modelID) return
    const resolvedProvider = Account.parseProvider(providerId) || providerId
    debugCheckpoint("admin.activities", "select model", { accountId, providerId: resolvedProvider, modelID })
    local.model.set({ providerId: resolvedProvider, modelID }, { recent: true, announce: true })
    setActivityTick((tick) => tick + 1)
  }

  const activityValue = createMemo(() => {
    const cur = local.model.current()
    if (!cur) return undefined
    const accountData =
      activityAccounts()?.[cur.providerId] ?? activityAccounts()?.[family(cur.providerId) ?? cur.providerId]
    const activeAccountId = accountData?.activeAccount
    if (!activeAccountId) return undefined
    return `${activeAccountId}:${cur.providerId}:${cur.modelID}`
  })

  // ---- OPTION GENERATION ----
  const handleAddProvider = (fam: string) => {
    if (!fam) return
    const normalizedFam = fam
    if (normalizedFam === "google-api") {
      debugCheckpoint("admin", "add provider google", { family: normalizedFam })
      openGoogleAdd()
      return
    }

    // Check if provider has OAuth methods available
    const authMethods = sync.data.provider_auth[normalizedFam]
    const hasOAuth = authMethods?.some((m) => m.type === "oauth")
    if (hasOAuth) {
      debugCheckpoint("admin", "add provider with oauth", {
        family: normalizedFam,
        methods: authMethods?.map((m) => m.label),
      })
      dialog.push(() => <DialogProviderList providerId={normalizedFam} />, markDialogClosed)
      return
    }

    // Check if this is a models.dev provider (needs API key)
    const providerData = modelsDevData()?.[normalizedFam]
    if (providerData && providerData.env && providerData.env.length > 0) {
      const envVar = providerData.env[0]
      const providerName = providerData.name || normalizedFam
      debugCheckpoint("admin", "add provider models.dev", { family: normalizedFam, envVar })
      dialog.push(
        () => (
          <DialogApiKeyAdd
            providerId={normalizedFam}
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
    debugCheckpoint("admin", "add provider list fallback", { family: normalizedFam })
    dialog.replace(() => <DialogProviderList providerId={normalizedFam} />)
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
            probeAndSelectModel(item.providerId, item.modelID, origin)
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

      // 1. Families - WYSIWYG: No hidden whitelists
      // Configured = has accounts in storage OR has providers from sync
      const coreFamilies = Object.keys(coreAll() ?? {})
      const syncFamilies = [...groupedProviders().keys()]

      // Build set of all configured providers (has accounts or sync data)
      const configuredProviders = new Set([...coreFamilies, ...syncFamilies])
      configuredProviders.delete("google")

      // Get all models.dev providers that aren't already configured
      const allModelsDevProviders = Object.keys(modelsDevData() ?? {}).filter((id) => {
        const fam = Account.parseFamily(id)
        // Only include if not already in configured providers
        return !configuredProviders.has(id) && (!fam || !configuredProviders.has(fam))
      })

      // Explicitly access hiddenProviders for reactivity tracking
      const hiddenProvidersList = local.model.hiddenProviders()

      // In Show All mode, include all models.dev providers
      // In normal mode, only include models.dev providers that were explicitly unhidden
      // (For unconfigured providers, being in hiddenProviders means "shown")
      const modelsDevProviders = showHidden()
        ? allModelsDevProviders
        : allModelsDevProviders.filter((id) => hiddenProvidersList.includes(id))

      const families = Array.from(new Set([...configuredProviders, ...modelsDevProviders])).sort((a, b) => {
        if (a === "antigravity") return -1
        if (b === "antigravity") return 1
        return a.localeCompare(b)
      })

      for (const fam of families) {
        const providers = groupedProviders().get(fam) || []

        const displayName = fam
        const familyData = coreAll()?.[fam]
        const allIds = familyData ? Object.keys(familyData.accounts || {}) : []
        const isFamilySuffix = (id: string) => id === `${fam}-subscription-${fam}` || id === `${fam}-api-${fam}`
        const isGeneric = (id: string) =>
          id === fam || id === "google-api" || id === "gemini-cli" || id === "antigravity" || isFamilySuffix(id)
        const hasSpecific = allIds.some((id) => !isGeneric(id))
        const filteredIds = allIds.filter((id) => (hasSpecific ? !isGeneric(id) : true))
        const accountTotal = familyData ? filteredIds.length : providers.length
        const hasAccounts = filteredIds.length > 0
        const hasProviders = providers.some((p) => Object.keys(p.models).length > 0 || p.active)

        // WYSIWYG Logic:
        // - Configured provider = has accounts OR has sync data
        // - Unconfigured provider = models.dev provider without accounts/sync
        const isConfigured = hasAccounts || hasProviders
        const isModelsDevProvider = !!modelsDevData()?.[fam]
        const isUnconfigured = isModelsDevProvider && !isConfigured

        const isInHiddenList = hiddenProvidersList.includes(fam)

        // For unconfigured providers: default hidden, shown if in hiddenProviders list (inverted)
        // For configured providers: default shown, hidden if in hiddenProviders list (normal)
        const effectivelyHidden = isUnconfigured ? !isInHiddenList : isInHiddenList

        // Show All mode: show everything (configured + all models.dev providers)
        // Normal mode: show configured (non-hidden) + explicitly unhidden unconfigured
        const shouldShow = showHidden()
          ? isConfigured || isModelsDevProvider
          : (isConfigured && !effectivelyHidden) || (isUnconfigured && !effectivelyHidden)
        if (!shouldShow) continue

        const activeCount = familyData?.activeAccount ? 1 : providers.filter((p) => p.active).length

        list.push({
          value: { family: fam, isUnconfigured },
          title: effectivelyHidden ? `${displayName} (hidden)` : displayName,
          category: "Providers",
          icon: "📂",
          description: accountTotal >= 1 ? `${accountTotal} account${accountTotal === 1 ? "" : "s"}` : undefined,
          gutter:
            activeCount > 0 ? (
              <text fg={theme.success as any}>●</text>
            ) : effectivelyHidden ? (
              <text fg={theme.textMuted as any}>○</text>
            ) : undefined,
          onSelect: () => {
            debugCheckpoint("admin", "select family", { family: fam })
            setSelectedFamily(fam)
            setStepLogged("account_select", "select family")
            forceRefresh()
          },
        })
      }

      return list
    }

    // LEVEL 2: ACCOUNT MANAGEMENT
    if (s === "account_select") {
      const fam = selectedFamily()
      if (!fam) return []

      if (agManager.loading) {
        return [
          {
            title: "Loading accounts...",
            value: "__loading__",
            disabled: true,
            category: "Status",
            icon: "⏳",
          },
        ]
      }

      // Combine sources for robustness
      const manager = agManager()
      const agAccounts = manager?.getAccountsSnapshot() || []
      const syncProviders = groupedProviders().get(fam) || []

      const accountMap = new Map<string, any>()

      // Level 2 strategy:
      // - Use core accounts for most providers.
      // - Use agManager for antigravity.

      if (fam !== "antigravity") {
        const familyData = coreAll()?.[fam]
        const accountsWithFamily: Array<{ id: string; info: any; coreFamily: string }> = []
        if (familyData?.accounts) {
          for (const [id, info] of Object.entries(familyData.accounts)) {
            accountsWithFamily.push({ id, info, coreFamily: fam })
          }
        }

        const activeId = familyData?.activeAccount

        const isFamilySuffix = (id: string) => id === `${fam}-subscription-${fam}` || id === `${fam}-api-${fam}`
        const isGeneric = (id: string) =>
          id === fam || id === "google-api" || id === "gemini-cli" || id === "antigravity" || isFamilySuffix(id)
        const hasSpecific = accountsWithFamily.some((a) => !isGeneric(a.id))

        for (const { id, info, coreFamily } of accountsWithFamily) {
          if (hasSpecific && isGeneric(id)) continue

          const displayName = Account.getDisplayName(id, info, fam) || info?.name || id
          accountMap.set(id, {
            id: id,
            coreId: id,
            coreFamily: coreFamily,
            name: displayName,
            active: activeId === id,
            email: info?.email,
          })
        }
      }

      if (fam === "antigravity") {
        const core = coreAg() || {}
        const coreByToken = new Map<string, string>()
        const coreByEmail = new Map<string, string>()

        for (const entry of Object.entries(core)) {
          const id = entry[0]
          const info = entry[1] as any
          if (info?.type !== "subscription") continue
          if (info.refreshToken) coreByToken.set(info.refreshToken, id)
          if (info.email) coreByEmail.set(info.email, id)
        }

        // Only fallback to syncProviders if they have real account data (email or refreshToken)
        // This prevents showing phantom "antigravity" entries when no accounts exist
        if (!manager || agAccounts.length === 0) {
          for (const p of syncProviders) {
            // Skip generic provider entries that don't represent real accounts
            const pAny = p as any
            if (!pAny.email && !pAny.refreshToken && p.id === "antigravity") {
              continue
            }
            accountMap.set(p.id, {
              id: p.id,
              coreId: p.id,
              name: owner(p as any) || p.name || p.id,
              active: p.active,
              email: p.email,
            })
          }
        }

        const activeId = coreActive()
        for (const acc of agAccounts) {
          const id = `antigravity-subscription-${acc.index + 1}`

          const token = acc.parts?.refreshToken
          const byToken = token ? coreByToken.get(token) : undefined
          const byEmail = acc.email ? coreByEmail.get(acc.email) : undefined
          const mapped = byToken || byEmail
          const coreId = mapped || id

          const syncMatch = syncProviders.find((p) => p.id === id)
          const name =
            acc.email ||
            (syncMatch ? owner(syncMatch as any) || syncMatch.name : null) ||
            (acc.parts.projectId ? `Project: ${acc.parts.projectId}` : `Account ${acc.index + 1}`)

          const isActive = activeId ? activeId === coreId : manager?.getActiveIndex() === acc.index
          accountMap.set(id, {
            id: id,
            coreId: coreId,
            name: name,
            active: isActive,
            email: acc.email,
          })
        }
      }

      const accountList = Array.from(accountMap.values())

      const accountOptions = pipe(
        accountList,
        map((p) => {
          const title = p.name || p.id

          return {
            value: p.id,
            coreId: p.coreId,
            coreFamily: p.coreFamily || fam,
            title: title,
            category: label(fam, fam),
            icon: "👤",
            disabled: false,
            onSelect: async () => {
              debugCheckpoint("admin", "select account", {
                family: fam,
                id: p.id,
                coreId: p.coreId,
                coreFamily: p.coreFamily,
              })
              await handleSetActive(p.coreFamily || fam, p.coreId || p.id, p.id)
              await refreshAntigravity()
              setSelectedProviderID(fam)
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
            category: label(fam, fam),
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

      const resolved = iife(() => {
        const direct = sync.data.provider.find((x) => x.id === pid)
        if (direct) return { id: pid, provider: direct }

        const fam = selectedFamily() || family(pid)
        if (!fam) return undefined

        const byFamily = sync.data.provider.find((x) => x.id === fam)
        if (byFamily) return { id: fam, provider: byFamily }

        const byPrefix = sync.data.provider.find((x) => x.id.startsWith(`${fam}-`))
        if (byPrefix) return { id: byPrefix.id, provider: byPrefix }

        return undefined
      })
      if (!resolved) return []
      const p = resolved.provider
      const providerId = resolved.id

      const showAll = showHidden()
      const isGoogleProvider = family(providerId) === "google-api"
      // Use base family ID for model values (favorites, validation expect base provider ID like "google-api", not account-specific "google-api-xxx")
      const baseProviderID = family(providerId) || providerId
      const hiddenCheck = (mid: string) => {
        if (showAll) return true
        return !local.model.hidden().some((h) => h.providerId === baseProviderID && h.modelID === mid)
      }

      const quotaAccountId = iife(() => {
        if (family(providerId) !== "antigravity") return pid
        return coreActive() || pid
      })

      const baseEntries = pipe(
        p.models,
        entries(),
        filter(([_, info]) => info.status !== "deprecated"),
        filter(([mid]) => hiddenCheck(mid)),
        map(([mid, info]) => {
          const isFav = favorites.some((f) => f.providerId === baseProviderID && f.modelID === mid)
          const pAny = p as any

          const isRateLimited = pAny.coolingDownUntil && pAny.coolingDownUntil > Date.now()
          const isBlocked = !!pAny.cooldownReason
          const isActionable = isRateLimited || isBlocked

          return {
            value: { providerId: baseProviderID, modelID: mid },
            modelTitle: info.name ?? mid,
            category: "Models",
            gutter: isFav ? <text fg={theme.accent}>⭐</text> : undefined,
            description: iife(() => {
              if (isRateLimited) {
                const remaining = Math.ceil((pAny.coolingDownUntil - Date.now()) / 1000 / 60)
                return `⏳ Rate limited (${remaining}m)`
              }
              if (isBlocked) return `⛔ ${pAny.cooldownReason}`
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
              isRateLimited ? Math.max(0, pAny.coolingDownUntil - Date.now()) : 0,
            ),
            onSelect: () => {
              debugCheckpoint("admin", "select model", { provider: baseProviderID, model: mid })
              probeAndSelectModel(baseProviderID, mid)
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
              const isFav = favorites.some((f) => f.providerId === baseProviderID && f.modelID === model.id)
              return {
                value: { providerId: baseProviderID, modelID: model.id },
                modelTitle: model.title,
                category: "Models",
                gutter: isFav ? <text fg={theme.accent}>⭐</text> : undefined,
                description: "Google AI Studio list",
                footer: undefined,
                onSelect: () => {
                  debugCheckpoint("admin", "select dynamic model", { provider: baseProviderID, model: model.id })
                  probeAndSelectModel(baseProviderID, model.id)
                },
              }
            })
        : []

      const combined = sortBy([...baseEntries, ...dynamicEntries], (entry) => entry.modelTitle)

      const widths = combined.reduce(
        (acc, entry) => {
          acc.provider = Math.max(acc.provider, baseProviderID.length)
          acc.model = Math.max(acc.model, entry.modelTitle.length)
          return acc
        },
        { provider: baseProviderID.length, model: 0 },
      )

      const formattedCombined = combined.map((entry) => {
        return {
          ...entry,
          title: formatProviderModelTitle(baseProviderID, entry.modelTitle, widths),
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

  const handleSetActive = async (fam: string, accountId: string, displayId?: string) => {
    debugCheckpoint("admin", "set active start", { family: fam, accountId, displayId })
    // 1. Set Active in Backend
    return debugSpan("admin", "set active", { family: fam, accountId, displayId }, async () => {
      if (fam === "antigravity") {
        try {
          // Update Core - this is the single source of truth
          await Account.setActive(fam, accountId)
          await Account.refresh()

          // Reload AccountManager from Account module to sync in-memory state
          const manager = agManager()
          if (manager) {
            await manager.reloadFromAccountModule()
          }
        } catch (e) {
          debugCheckpoint("admin", "set active error", {
            family: fam,
            error: String(e instanceof Error ? e.stack || e.message : e),
          })
          console.error(e)
        }
        // Use generic ID for model lookup
        setSelectedProviderID("antigravity")
      } else if (fam === "anthropic") {
        try {
          await Account.setActive(fam, accountId)
          await Account.refresh()
        } catch (e) {
          debugCheckpoint("admin", "set active error", {
            family: fam,
            error: String(e instanceof Error ? e.stack || e.message : e),
          })
        }
        // FORCE generic ID for Anthropic model lookup
        setSelectedProviderID("anthropic")
      } else if (fam === "github-copilot" || fam === "github-copilot-enterprise") {
        try {
          await Account.setActive(fam, accountId)
          await Account.refresh()
        } catch (e) {
          debugCheckpoint("admin", "set active error", {
            family: fam,
            error: String(e instanceof Error ? e.stack || e.message : e),
          })
        }
        // FORCE generic ID for GitHub Copilot model lookup
        setSelectedProviderID(fam)
      } else {
        try {
          // Set active account for any provider with multi-account
          await Account.setActive(fam, accountId)
          await Account.refresh()
        } catch (e) {
          debugCheckpoint("admin", "set active error", {
            family: fam,
            error: String(e instanceof Error ? e.stack || e.message : e),
          })
        }
        setSelectedProviderID(accountId)
      }
      forceRefresh() // Trigger UI redraw to show updated green dot
      debugCheckpoint("admin", "set active end", { family: fam, accountId, displayId })
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
        return `Manage Accounts (${label(selectedFamily() || "", selectedFamily() || "")})`
      if (step() === "model_select") {
        const pid = selectedProviderID()
        if (pid) {
          const p = sync.data.provider.find((x) => x.id === pid)
          if (p) {
            const who = owner(p)
            if (who) return `Select Model - ${who}${showAllIndicator}`
            return `Select Model - ${p.name}${showAllIndicator}`
          }
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
      debugCheckpoint("admin", "back to root", { step: step(), family: selectedFamily() })
      setStepLogged("root", "back to root")
      setSelectedFamily(null)
      return
    }
    if (step() === "model_select") {
      debugCheckpoint("admin", "back to account_select", {
        step: step(),
        family: selectedFamily(),
        provider: selectedProviderID(),
      })
      setStepLogged("account_select", "back from model_select")
      // Keep provider ID selected? Or clear?
      // Maybe clear to reset state, but keeping it is fine.
      // Actually, account list doesn't depend on selectedProviderID, it depends on selectedFamily.
      return
    }
  }

  const goForward = (option: DialogSelectOption<any>) => {
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
    if (page() === "activities") return activityValue()
    if (step() === "account_select") {
      const first = options().find((option) => {
        if (!("disabled" in option)) return true
        return option.disabled !== true
      })
      if (first) return first.value
    }
    return local.model.current()
  })

  onMount(() => dialog.setSize("xlarge"))
  onCleanup(() => dialog.setWidth(undefined))

  createEffect(() => {
    const currentPage = page()
    if (currentPage !== "activities") {
      dialog.setWidth(undefined)
      return
    }
    const activityItems = activityData().items
    const maxTitle = activityItems.reduce((max, item) => Math.max(max, item.title.length), 0)
    const headerTitle = `Model Activities (${activityData().stats.ready}/${activityData().stats.total})`
    const baseWidth = Math.max(maxTitle, headerTitle.length)
    const desired = baseWidth + 8
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
            onTrigger: (option: any) => {
              const val = option.value
              if (val && typeof val === "object" && val.providerId && val.modelID) {
                debugCheckpoint("admin", "toggle favorite", { provider: val.providerId, model: val.modelID })
                local.model.toggleFavorite(val, { skipValidation: true })
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
                  },
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
                  keybind: Keybind.parse("d")[0],
                  title: "(D)elete",
                  label: "D",
                  disabled: false,
                  // @event_2026-02-06:fix-model-activities - Add d key to remove from favorites in activities page
                  onTrigger: (option: any) => {
                    const val = option.value
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
            label: "R",
            disabled:
              page() === "activities"
                ? false
                : !connected() || step() !== "model_select" || family(selectedProviderID() ?? "") !== "google-api",
            onTrigger: () => {
              if (page() === "activities") {
                debugCheckpoint("admin.activities", "refresh")
                setActivityTick((tick) => tick + 1)
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
              const fam = selectedFamily()
              if (!fam) return
              if (fam === "google-api") {
                debugCheckpoint("admin", "add keybind google", { family: fam })
                openGoogleAdd()
                return
              }

              // Check if provider has OAuth methods available (e.g., Anthropic Claude Pro/Max)
              const authMethods = sync.data.provider_auth[fam]
              const hasOAuth = authMethods?.some((m) => m.type === "oauth")
              if (hasOAuth) {
                // Provider has OAuth support - use DialogProviderList which handles OAuth flow
                debugCheckpoint("admin", "add keybind provider with oauth", {
                  family: fam,
                  methods: authMethods?.map((m) => m.label),
                })
                dialog.push(() => <DialogProviderList providerId={fam} />, markDialogClosed)
                return
              }

              // Check if this is a models.dev provider (needs API key)
              const providerData = modelsDevData()?.[fam]
              if (providerData && providerData.env && providerData.env.length > 0) {
                // models.dev provider with env var requirement
                const envVar = providerData.env[0] // Use first env var
                const providerName = providerData.name || fam
                debugCheckpoint("admin", "add keybind models.dev provider", { family: fam, envVar })
                dialog.push(
                  () => (
                    <DialogApiKeyAdd
                      providerId={fam}
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

              debugCheckpoint("admin", "add keybind provider list", { family: fam })
              dialog.replace(() => <DialogProviderList providerId={fam} />)
            },
          },
          // EDIT ACCOUNT NAME
          {
            keybind: Keybind.parse("e")[0],
            title: "(E)dit",
            label: "",
            disabled: step() !== "account_select",
            onTrigger: async (option: any) => {
              const val = option.value
              if (typeof val !== "string" || val.startsWith("__")) return
              const fam = selectedFamily()
              if (!fam) return

              // Use coreFamily for account lookup (accounts may be stored in different family than displayed)
              const accountId = option.coreId || val
              const lookupFamily = option.coreFamily || fam
              const accountInfo = await Account.get(lookupFamily, accountId)
              if (!accountInfo) {
                toast.show({ message: "Account not found", variant: "error", duration: 2000 })
                return
              }

              debugCheckpoint("admin", "edit account", { family: lookupFamily, id: accountId })
              // Pass markDialogClosed as onClose to dialog.push so it's called
              // when dialog.tsx's escape handler pops the stack (before our keybinds run)
              dialog.push(
                () => (
                  <DialogAccountEdit
                    family={lookupFamily}
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
            onTrigger: async (option: any) => {
              const val = option.value
              if (typeof val !== "string" || val.startsWith("__")) return
              const fam = selectedFamily()
              if (!fam) return

              // Use coreFamily for account lookup (accounts may be stored in different family than displayed)
              const accountId = option.coreId || val
              const lookupFamily = option.coreFamily || fam
              const accountInfo = await Account.get(lookupFamily, accountId)
              if (!accountInfo) {
                toast.show({ message: "Account not found", variant: "error", duration: 2000 })
                return
              }

              debugCheckpoint("admin", "view account", { family: lookupFamily, id: accountId })
              // Pass markDialogClosed as onClose to dialog.push so it's called
              // when dialog.tsx's escape handler pops the stack (before our keybinds run)
              dialog.push(
                () => (
                  <DialogAccountView
                    family={lookupFamily}
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
                  title: step() === "model_select" ? "Hide" : step() === "root" ? "Hide" : "(Del)ete",
                  label: "",
                  disabled: !connected(),
                  onTrigger: async (option: any) => {
                    const val = option.value

                    // Hide provider on root step
                    if (step() === "root" && val && typeof val === "object" && val.family) {
                      // Provider entry with { family, isUnconfigured }
                      const optionObj = option as any
                      if (optionObj.category === "Providers") {
                        const fam = val.family
                        const isUnconfigured = val.isUnconfigured
                        // Check if not already hidden
                        const isInHiddenList = local.model.isProviderHidden(fam)
                        const effectivelyHidden = isUnconfigured ? !isInHiddenList : isInHiddenList
                        if (!effectivelyHidden) {
                          debugCheckpoint("admin", "hide provider", { family: fam, isUnconfigured })
                          // For unconfigured: toggle removes from list (makes it hidden again)
                          // For configured: toggle adds to list (makes it hidden)
                          local.model.toggleHiddenProvider(fam)
                          toast.show({ message: `Provider "${fam}" hidden`, variant: "info", duration: 2000 })
                        }
                        return
                      }
                    }

                    if (step() === "account_select" && typeof val === "string" && val !== "__add_account__") {
                      const fam = selectedFamily()
                      if (fam) {
                        // Use coreFamily for account operations (accounts may be stored in different family than displayed)
                        const lookupFamily = option.coreFamily || fam
                        debugCheckpoint("admin", "delete account prompt", { family: lookupFamily, id: val })
                        const confirmed = await DialogConfirm.show(
                          dialog,
                          "Delete Account",
                          `Are you sure you want to delete this account?`,
                        )

                        if (confirmed) {
                          try {
                            // Remove from core Account module (single source of truth)
                            // Use the mapped coreId and coreFamily for correct lookup
                            const coreId = option.coreId || val
                            await Account.remove(lookupFamily, coreId)
                            await Account.refresh()

                            // Reload AccountManager to sync in-memory state
                            if (lookupFamily === "antigravity") {
                              const manager = agManager()
                              if (manager) {
                                await manager.reloadFromAccountModule()
                              }
                            }

                            debugCheckpoint("admin", "delete account success", { family: lookupFamily, id: coreId })
                            toast.show({ message: "Account deleted successfully", variant: "success" })
                            await refreshAntigravity()
                            setSelectedFamily(fam)
                            forceRefresh()
                            lockBackOnce()
                          } catch (e: any) {
                            debugCheckpoint("admin", "delete account error", {
                              family: fam,
                              error: String(e instanceof Error ? e.stack || e.message : e),
                            })
                            toast.error(e)
                          }
                        }
                      }
                      return
                    }

                    if (step() === "model_select" || step() === "root") {
                      // Only handle model values (objects)
                      if (typeof val === "object" && val.providerId && val.modelID) {
                        const modelVal = val as any
                        debugCheckpoint("admin", "delete model action", {
                          origin: modelVal.origin,
                          provider: modelVal.providerId,
                          model: modelVal.modelID,
                        })
                        if (modelVal.origin === "recent") local.model.removeFromRecent(modelVal)
                        else if (modelVal.origin === "favorite") {
                          local.model.toggleFavorite(modelVal, { skipValidation: true })
                        } else if (step() !== "root") local.model.toggleHidden(modelVal)
                      }
                    }
                  },
                },
              ]),
          {
            keybind: Keybind.parse("insert")[0],
            title: "Unhide",
            label: "Ins",
            disabled: !showHidden(),
            onTrigger: (option: any) => {
              const val = option.value as any

              // Unhide provider on root step
              if (step() === "root" && val && typeof val === "object" && val.family) {
                const optionObj = option as any
                if (optionObj.category === "Providers") {
                  const fam = val.family
                  const isUnconfigured = val.isUnconfigured
                  // Check if effectively hidden
                  const isInHiddenList = local.model.isProviderHidden(fam)
                  const effectivelyHidden = isUnconfigured ? !isInHiddenList : isInHiddenList
                  if (effectivelyHidden) {
                    debugCheckpoint("admin", "unhide provider", { family: fam, isUnconfigured })
                    // For unconfigured: toggle adds to list (makes it shown)
                    // For configured: toggle removes from list (makes it shown)
                    local.model.toggleHiddenProvider(fam)
                    toast.show({ message: `Provider "${fam}" unhidden`, variant: "info", duration: 2000 })
                  }
                  return
                }
              }

              // Unhide model
              if (val && typeof val === "object" && val.providerId && val.modelID) {
                debugCheckpoint("admin", "unhide model", { provider: val.providerId, model: val.modelID })
                local.model.toggleHidden(val)
              }
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
            return (
              <Show when={!isCancel()}>
                <box flexDirection="column" paddingBottom={1}>
                  <Show
                    when={isPair()}
                    fallback={
                      <box
                        flexDirection="row"
                        paddingLeft={2}
                        paddingRight={2}
                        backgroundColor={active() ? theme.primary : undefined}
                      >
                        <text fg={fg()} attributes={active() ? TextAttributes.BOLD : undefined}>
                          {item.label}
                        </text>
                        <Show when={item.id === "name" || item.id === "key"}>
                          <text fg={val() ? fg() : theme.textMuted}>
                            {" "}
                            {Locale.truncate(val() || placeholderText(), 48)}
                          </text>
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
      <Show when={mode()}>
        <box paddingLeft={1} paddingRight={1} gap={1}>
          <text fg={theme.textMuted}>{mode() === "name" ? "Account name" : "API key"}</text>
          <Show when={`edit-${mode()}-${tick()}`} keyed>
            {(key) => (
              <textarea
                height={3}
                keyBindings={bindings()}
                placeholder={mode() === "name" ? "Enter account name" : "Enter API key"}
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
                focused
                textColor={theme.text}
                focusedTextColor={theme.text}
                cursorColor={theme.text}
              />
            )}
          </Show>
          <text fg={theme.textMuted}>enter save · left/esc cancel</text>
        </box>
      </Show>
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
            return (
              <Show when={!isCancel()}>
                <box flexDirection="column" paddingBottom={1}>
                  <Show
                    when={isPair()}
                    fallback={
                      <box
                        flexDirection="row"
                        paddingLeft={2}
                        paddingRight={2}
                        backgroundColor={active() ? theme.primary : undefined}
                      >
                        <text fg={fg()} attributes={active() ? TextAttributes.BOLD : undefined}>
                          {item.label}
                        </text>
                        <Show when={item.id === "name" || item.id === "key"}>
                          <text fg={val() ? fg() : theme.textMuted}>
                            {" "}
                            {Locale.truncate(val() || placeholderText(), 48)}
                          </text>
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
      <Show when={mode()}>
        <box paddingLeft={1} paddingRight={1} gap={1}>
          <text fg={theme.textMuted}>{mode() === "name" ? "Account name" : props.envVar}</text>
          <Show when={`edit-${mode()}-${tick()}`} keyed>
            {(key) => (
              <textarea
                height={3}
                keyBindings={bindings()}
                placeholder={mode() === "name" ? "Enter account name" : `Enter ${props.envVar}`}
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
                focused
                textColor={theme.text}
                focusedTextColor={theme.text}
                cursorColor={theme.text}
              />
            )}
          </Show>
          <text fg={theme.textMuted}>enter save · left/esc cancel</text>
        </box>
      </Show>
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
  family: string
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
    debugCheckpoint("admin.account_edit", "mount", { family: props.family, id: props.accountId })
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
      const info = await Account.get(props.family, props.accountId)
      if (!info) {
        setNameErr("Account not found")
        setSaving(false)
        return
      }

      // Update the account with new name
      await Account.update(props.family, props.accountId, { ...info, name: newName })
      await Account.refresh()

      debugCheckpoint("admin.account_edit", "save success", { family: props.family, id: props.accountId, newName })
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
                        flexDirection="row"
                        paddingLeft={2}
                        paddingRight={2}
                        backgroundColor={active() ? theme.primary : undefined}
                      >
                        <text fg={fg()} attributes={active() ? TextAttributes.BOLD : undefined}>
                          {item.label}
                        </text>
                        <Show when={isNameField}>
                          <text fg={name() ? fg() : theme.textMuted}>
                            {" "}
                            {Locale.truncate(name() || "Enter email or account name", 48)}
                          </text>
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
                    <box paddingLeft={4}>
                      <text fg={theme.error}>{nameErr()}</text>
                    </box>
                  </Show>
                </box>
              </Show>
            )
          }}
        </For>
      </box>
      <Show when={editing()}>
        <box paddingLeft={1} paddingRight={1} gap={1}>
          <text fg={theme.textMuted}>New name (use email for better identification):</text>
          <Show when={`edit-name-${tick()}`} keyed>
            {(key) => (
              <textarea
                height={3}
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
                focused
                textColor={theme.text}
                focusedTextColor={theme.text}
                cursorColor={theme.text}
              />
            )}
          </Show>
          <text fg={theme.textMuted}>enter confirm · esc cancel</text>
        </box>
      </Show>
    </box>
  )
}

/**
 * Dialog to view account JSON
 */
function DialogAccountView(props: {
  family: string
  accountId: string
  accountInfo: Account.Info
  onClose: () => void
}) {
  const dialog = useDialog()
  const theme = useTheme().theme
  const [scrollOffset, setScrollOffset] = createSignal(0)

  // Mask sensitive fields
  const maskedInfo = createMemo(() => {
    const info = { ...props.accountInfo } as any
    // Mask sensitive fields
    if (info.apiKey) info.apiKey = info.apiKey.slice(0, 8) + "..." + info.apiKey.slice(-4)
    if (info.refreshToken) info.refreshToken = info.refreshToken.slice(0, 8) + "..." + info.refreshToken.slice(-4)
    if (info.accessToken) info.accessToken = info.accessToken.slice(0, 8) + "..." + info.accessToken.slice(-4)
    return info
  })

  const jsonStr = createMemo(() => JSON.stringify(maskedInfo(), null, 2))
  const lines = createMemo(() => jsonStr().split("\n"))
  const visibleLines = 15

  onMount(() => {
    debugCheckpoint("admin.account_view", "mount", { family: props.family, id: props.accountId })
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
