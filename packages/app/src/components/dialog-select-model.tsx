import { Popover as Kobalte } from "@kobalte/core/popover"
import {
  Component,
  ComponentProps,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  JSX,
  onCleanup,
  Show,
  ValidComponent,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useGlobalSync } from "@/context/global-sync"
import { useSDK } from "@/context/sdk"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/tag"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { DialogSelectProvider } from "./dialog-select-provider"
import { DialogManageModels } from "./dialog-manage-models"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import type { IconName } from "@opencode-ai/ui/icons/provider"

function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(" ")
}

const BUILTIN_PROVIDER_FAMILIES = new Set([
  "opencode",
  "anthropic",
  "openai",
  "github-copilot",
  "gemini-cli",
  "google-api",
  "antigravity",
  "openrouter",
  "vercel",
  "gitlab",
])

function normalizeProviderFamily(id: string): string | undefined {
  if (!id) return undefined
  const raw = id.trim()
  if (!raw) return undefined
  const lower = raw.toLowerCase()

  if (lower.includes(":")) return lower.split(":")[0]
  if (lower === "google") return "google-api"
  if (lower.startsWith("google-")) return "google-api"
  if (lower.startsWith("opencode-")) return "opencode"
  if (lower.includes("@")) {
    if (lower.endsWith("gmail.com") || lower.endsWith("gmail.com.tw")) return "google-api"
    return undefined
  }

  if (BUILTIN_PROVIDER_FAMILIES.has(lower)) return lower
  return /^[a-z0-9][a-z0-9-]*$/i.test(lower) ? lower : undefined
}

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
}> = (props) => {
  const local = useLocal()
  const language = useLanguage()

  const models = createMemo(() =>
    local.model
      .list()
      .filter((m) => local.model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true)),
  )

  return (
    <List
      class={`flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={local.model.current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a, b) => a.name.localeCompare(b.name)}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={(a, b) => {
        const aProvider = a.items[0].provider.id
        const bProvider = b.items[0].provider.id
        if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
        if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
        return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
      }}
      itemWrapper={(item, node) => (
        <Tooltip
          class="w-full"
          placement="right-start"
          gutter={12}
          value={<ModelTooltip model={item} latest={item.latest} free={isFree(item.provider.id, item.cost)} />}
        >
          {node}
        </Tooltip>
      )}
      onSelect={(x) => {
        local.model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full flex items-center gap-x-2 text-13-regular">
          <span class="truncate">{i.name}</span>
          <Show when={isFree(i.provider.id, i.cost)}>
            <Tag>{language.t("model.tag.free")}</Tag>
          </Show>
          <Show when={i.latest}>
            <Tag>{language.t("model.tag.latest")}</Tag>
          </Show>
        </div>
      )}
    </List>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">

export function ModelSelectorPopover(props: {
  provider?: string
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: "escape" | "outside" | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()

  const handleManage = () => {
    setStore("open", false)
    dialog.show(() => <DialogManageModels />)
  }

  const handleConnectProvider = () => {
    setStore("open", false)
    dialog.show(() => <DialogSelectProvider />)
  }
  const language = useLanguage()

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={8}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          class="w-72 h-80 flex flex-col p-2 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden"
          onEscapeKeyDown={(event) => {
            setStore("dismiss", "escape")
            setStore("open", false)
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => {
            setStore("dismiss", "outside")
            setStore("open", false)
          }}
          onFocusOutside={() => {
            setStore("dismiss", "outside")
            setStore("open", false)
          }}
          onCloseAutoFocus={(event) => {
            if (store.dismiss === "outside") event.preventDefault()
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            onSelect={() => setStore("open", false)}
            class="p-1"
            action={
              <div class="flex items-center gap-1">
                <Tooltip placement="top" value={language.t("command.provider.connect")}>
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("command.provider.connect")}
                    onClick={handleConnectProvider}
                  />
                </Tooltip>
                <Tooltip placement="top" value={language.t("dialog.model.manage")}>
                  <IconButton
                    icon="sliders"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("dialog.model.manage")}
                    onClick={handleManage}
                  />
                </Tooltip>
              </div>
            }
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

const ProviderItem: Component<{
  id: string
  name: string
  icon?: string
  providerIcon?: string
  selected: boolean
  onClick: () => void
}> = (props) => {
  return (
    <button
      class={cn(
        "flex items-center gap-2 w-full px-3 py-2 text-13-regular rounded-md transition-colors text-left outline-none",
        props.selected ? "bg-surface-raised-pressed text-text-strong" : "text-text-base hover:bg-surface-raised-hover",
      )}
      onClick={props.onClick}
    >
      <Show when={props.providerIcon} fallback={<Icon name={props.icon as any} class="size-4 shrink-0" />}>
        <ProviderIcon id={props.providerIcon as IconName} class="size-4 shrink-0" />
      </Show>
      <span class="truncate flex-1">{props.name}</span>
    </button>
  )
}

const ModelItem: Component<{
  item: ReturnType<ReturnType<typeof useModels>["list"]>[number]
  selected: boolean
  enabled: boolean
  unavailableReason?: string
  onToggleEnabled: (e: MouseEvent) => void
}> = (props) => {
  const language = useLanguage()

  return (
    <div class="flex items-center gap-2 w-full group">
      <div class="flex-1 min-w-0 flex items-center gap-2">
        <span class={cn("truncate", props.selected && "text-text-strong")}>{props.item.name}</span>
        <Show when={props.item.provider.id === "opencode" && (!props.item.cost || props.item.cost?.input === 0)}>
          <Tag>{language.t("model.tag.free")}</Tag>
        </Show>
        <Show when={props.item.latest}>
          <Tag>{language.t("model.tag.latest")}</Tag>
        </Show>
        <Show when={props.unavailableReason}>
          <Tag>{language.t("dialog.model.activity.unavailable")}</Tag>
        </Show>
        <Show when={!props.enabled}>
          <Tag>{language.t("dialog.model.activity.disabled")}</Tag>
        </Show>
      </div>
      <IconButton
        icon="eye"
        variant="ghost"
        class={cn(
          "size-6 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity hover:text-icon-base",
          props.enabled ? "text-icon-weak-base" : "text-icon-warning-base opacity-100",
        )}
        onClick={props.onToggleEnabled}
      />
    </div>
  )
}

export const DialogSelectModel: Component<{ provider?: string }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const local = useLocal()
  const globalSync = useGlobalSync()
  const sdk = useSDK()

  const [search, setSearch] = createSignal("")
  const [accountInfo] = createResource(async () => {
    return sdk.client.account.listAll().then((x) => x.data)
  })

  const [selectedProviderId, setSelectedProviderId] = createSignal<string>(props.provider || "")
  const [selectedAccountId, setSelectedAccountId] = createSignal<string>("")
  const [mode, setMode] = createSignal<"favorites" | "all">("favorites")

  const providerStatus = createMemo(() => {
    const map = new Map<string, string>()
    const disabled = new Set<string>((globalSync.data.config.disabled_providers ?? []) as string[])
    for (const id of disabled) map.set(id, language.t("dialog.model.activity.providerDisabled"))

    const families = accountInfo.latest?.families
    if (!families || typeof families !== "object") return map

    for (const [family, value] of Object.entries(families as Record<string, unknown>)) {
      const row = value as { activeAccount?: unknown; accounts?: Record<string, unknown> }
      const activeAccount = typeof row?.activeAccount === "string" ? row.activeAccount : undefined
      if (!activeAccount) continue
      const account =
        row?.accounts && typeof row.accounts === "object"
          ? (row.accounts[activeAccount] as Record<string, unknown> | undefined)
          : undefined
      const until = typeof account?.coolingDownUntil === "number" ? account.coolingDownUntil : undefined
      if (!until || until <= Date.now()) continue
      const reason = typeof account?.cooldownReason === "string" ? account.cooldownReason : undefined
      const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000))
      map.set(family, reason || language.t("settings.models.recommendations.cooldown", { minutes }))
    }

    return map
  })

  const familyOf = (providerId: string) => normalizeProviderFamily(providerId) || providerId

  const activeAccountForFamily = (family: string) => {
    const families = accountInfo.latest?.families as Record<string, unknown> | undefined
    const familyRow = families?.[family] as { activeAccount?: unknown } | undefined
    return typeof familyRow?.activeAccount === "string" ? familyRow.activeAccount : undefined
  }

  const modelUnavailableReason = (providerId: string, accountId?: string) => {
    const direct = providerStatus().get(providerId)
    if (direct) return direct
    const family = familyOf(providerId)
    const familyStatus = providerStatus().get(family)
    if (familyStatus) return familyStatus

    if (!accountId) return
    const families = accountInfo.latest?.families as Record<string, unknown> | undefined
    const familyRow = families?.[family] as { accounts?: Record<string, unknown> } | undefined
    const account = familyRow?.accounts?.[accountId] as Record<string, unknown> | undefined
    const until = typeof account?.coolingDownUntil === "number" ? account.coolingDownUntil : undefined
    if (until && until > Date.now()) {
      const reason = typeof account?.cooldownReason === "string" ? account.cooldownReason : undefined
      const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000))
      return reason || language.t("settings.models.recommendations.cooldown", { minutes })
    }
  }

  const modelCountByFamily = createMemo(() => {
    const out = new Map<string, number>()
    for (const model of local.model.list()) {
      const family = familyOf(model.provider.id)
      out.set(family, (out.get(family) ?? 0) + 1)
    }
    return out
  })

  const enabledModelCountByFamily = createMemo(() => {
    const out = new Map<string, number>()
    for (const model of local.model.list()) {
      const family = familyOf(model.provider.id)
      const key = { modelID: model.id, providerID: model.provider.id }
      if (!local.model.enabled(key)) continue
      out.set(family, (out.get(family) ?? 0) + 1)
    }
    return out
  })

  const providers = createMemo(() => {
    const out = new Map<string, { id: string; family: string; name: string; models: number }>()

    const labelMap: Record<string, string> = {
      anthropic: "Anthropic",
      openai: "OpenAI",
      "google-api": "Google-API",
      antigravity: "Antigravity",
      "gemini-cli": "Gemini CLI",
      gmicloud: "GMICloud",
      "github-copilot": "GitHub Copilot",
      gitlab: "GitLab",
      opencode: "OpenCode",
      openrouter: "OpenRouter",
      vercel: "Vercel",
    }

    const disabledFamilies = new Set(
      ((globalSync.data.config.disabled_providers ?? []) as string[])
        .map((id) => normalizeProviderFamily(id))
        .filter((id): id is string => !!id),
    )

    const familyUniverse = new Set<string>()
    for (const provider of globalSync.data.provider.all ?? []) {
      const normalized = normalizeProviderFamily(provider.id)
      if (!normalized || normalized === "google") continue
      familyUniverse.add(normalized)
    }

    const families = accountInfo.latest?.families as Record<string, { accounts?: Record<string, unknown> }> | undefined
    if (families) {
      for (const [family, data] of Object.entries(families)) {
        const normalized = normalizeProviderFamily(family)
        if (!normalized) continue
        const accountCount = data?.accounts ? Object.keys(data.accounts).length : 0
        if (accountCount <= 0) continue
        familyUniverse.add(normalized)
      }
    }

    for (const family of familyUniverse) {
      const totalModels = modelCountByFamily().get(family) ?? 0
      const enabledModels = enabledModelCountByFamily().get(family) ?? 0
      if (mode() === "favorites" && enabledModels <= 0) continue
      if (mode() === "favorites" && disabledFamilies.has(family)) continue
      out.set(family, {
        id: family,
        family,
        name: labelMap[family] ?? family,
        models: mode() === "favorites" ? enabledModels : totalModels,
      })
    }

    return Array.from(out.values()).sort((a, b) => {
      const aIdx = popularProviders.indexOf(a.family)
      const bIdx = popularProviders.indexOf(b.family)
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx
      if (aIdx !== -1) return -1
      if (bIdx !== -1) return 1
      return a.name.localeCompare(b.name)
    })
  })

  createEffect(() => {
    const selected = selectedProviderId()
    if (selected && providers().some((provider) => provider.id === selected)) return
    if (providers().length > 0) {
      setSelectedProviderId(providers()[0].id)
      return
    }
    setSelectedProviderId("")
  })

  const accountsForSelectedProvider = createMemo(() => {
    const providerId = selectedProviderId()
    if (!providerId) return [] as Array<{ id: string; label: string; active: boolean; unavailable?: string }>
    const family = familyOf(providerId)
    const families = accountInfo.latest?.families as Record<string, unknown> | undefined
    const familyRow = families?.[family] as { activeAccount?: unknown; accounts?: Record<string, unknown> } | undefined
    const activeAccount = typeof familyRow?.activeAccount === "string" ? familyRow.activeAccount : undefined
    const accounts = familyRow?.accounts && typeof familyRow.accounts === "object" ? familyRow.accounts : {}
    const rows = Object.entries(accounts).map(([id, value]) => {
      const item = value as Record<string, unknown>
      const name =
        (typeof item?.name === "string" && item.name) || (typeof item?.email === "string" && item.email) || id
      const until = typeof item?.coolingDownUntil === "number" ? item.coolingDownUntil : undefined
      const reason = typeof item?.cooldownReason === "string" ? item.cooldownReason : undefined
      const unavailable =
        until && until > Date.now()
          ? reason ||
            language.t("settings.models.recommendations.cooldown", {
              minutes: Math.max(1, Math.ceil((until - Date.now()) / 60000)),
            })
          : undefined
      return {
        id,
        label: name,
        active: activeAccount === id,
        unavailable,
      }
    })
    return rows.sort((a, b) => {
      if (a.active && !b.active) return -1
      if (!a.active && b.active) return 1
      return a.label.localeCompare(b.label)
    })
  })

  createEffect(() => {
    const rows = accountsForSelectedProvider()
    if (!rows.length) {
      setSelectedAccountId("")
      return
    }
    const current = selectedAccountId()
    if (current && rows.some((row) => row.id === current)) return
    const active = rows.find((row) => row.active)
    setSelectedAccountId(active?.id ?? rows[0].id)
  })

  const filteredModels = createMemo(() => {
    const providerId = selectedProviderId()
    const query = search().toLowerCase().trim()
    if (!providerId) return [] as ReturnType<ReturnType<typeof useModels>["list"]>
    return local.model
      .list()
      .filter((m) => {
        return familyOf(m.provider.id) === providerId
      })
      .filter((m) => {
        const key = { modelID: m.id, providerID: m.provider.id }
        const enabled = local.model.enabled(key)
        if (mode() === "favorites") return enabled
        return true
      })
      .filter((m) => {
        if (!query) return true
        return m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query)
      })
  })

  return (
    <Dialog
      title={language.t("dialog.model.select.title") + " (activities)"}
      class="w-[800px] max-w-[90vw] h-[600px] max-h-[85vh] flex flex-col p-0 overflow-hidden"
    >
      <div class="flex flex-1 min-h-0 h-full overflow-hidden">
        <div class="w-56 flex-shrink-0 border-r border-border-base flex flex-col bg-surface-base">
          <div class="p-2 space-y-1 overflow-y-auto flex-1">
            <div class="px-3 py-2 text-11-medium text-text-weak uppercase tracking-wider">
              {language.t("common.providers")}
            </div>
            <For each={providers()}>
              {(provider) => (
                <ProviderItem
                  id={provider.id}
                  name={provider.models > 0 ? `${provider.name} (${provider.models})` : provider.name}
                  providerIcon={provider.id}
                  selected={selectedProviderId() === provider.id}
                  onClick={() => setSelectedProviderId(provider.id)}
                />
              )}
            </For>
          </div>

          <div class="p-2 border-t border-border-base space-y-1">
            <div class="flex items-center justify-between gap-2 pb-1 px-1">
              <span class="text-12-medium text-text-weak">{language.t("dialog.model.mode.curated")}</span>
              <Switch
                checked={mode() === "all"}
                onChange={(checked) => setMode(checked ? "all" : "favorites")}
                hideLabel
              >
                {language.t("dialog.model.mode.all")}
              </Switch>
              <span class="text-12-medium text-text-weak">{language.t("dialog.model.mode.all")}</span>
            </div>
            <Button
              variant="ghost"
              class="w-full justify-start text-text-weak hover:text-text-base h-8"
              icon="plus-small"
              onClick={() => dialog.show(() => <DialogSelectProvider />)}
            >
              {language.t("command.provider.connect")}
            </Button>
            <Button
              variant="ghost"
              class="w-full justify-start text-text-weak hover:text-text-base h-8"
              icon="sliders"
              onClick={() => dialog.show(() => <DialogManageModels />)}
            >
              {language.t("dialog.model.manage")}
            </Button>
          </div>
        </div>

        <div class="w-64 flex-shrink-0 border-r border-border-base flex flex-col bg-surface-base">
          <div class="px-3 py-2 text-11-medium text-text-weak uppercase tracking-wider border-b border-border-base">
            Accounts
          </div>
          <div class="p-2 space-y-1 overflow-y-auto flex-1">
            <Show
              when={accountsForSelectedProvider().length > 0}
              fallback={<div class="px-3 py-2 text-12-regular text-text-weak">No account data</div>}
            >
              <For each={accountsForSelectedProvider()}>
                {(row) => (
                  <button
                    class={cn(
                      "w-full text-left rounded-md px-3 py-2 transition-colors",
                      selectedAccountId() === row.id
                        ? "bg-surface-raised-pressed text-text-strong"
                        : "hover:bg-surface-raised-hover text-text-base",
                    )}
                    onClick={() => setSelectedAccountId(row.id)}
                  >
                    <div class="flex items-center gap-2">
                      <span class="truncate flex-1">{row.label}</span>
                      <Show when={row.active}>
                        <Tag>{language.t("settings.accounts.active")}</Tag>
                      </Show>
                      <Show when={row.unavailable}>
                        <Tag>{language.t("dialog.model.activity.unavailable")}</Tag>
                      </Show>
                    </div>
                    <Show when={row.unavailable}>
                      {(msg) => <div class="text-11-regular text-icon-warning-base pt-1 truncate">{msg()}</div>}
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>

        <div class="flex-1 flex flex-col min-w-0 bg-surface-raised-base">
          <div class="p-3 border-b border-border-base bg-surface-base">
            <TextField
              class="w-full"
              placeholder={language.t("dialog.model.search.placeholder")}
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              autofocus
              icon="magnifying-glass"
            />
          </div>

          <div class="flex-1 overflow-hidden relative">
            <List
              class="h-full [&_[data-slot=list-scroll]]:h-full [&_[data-slot=list-scroll]]:p-2"
              items={filteredModels()}
              key={(x) => `${x.provider.id}:${x.id}`}
              current={local.model.current()}
              filterKeys={["provider.name", "name", "id"]}
              sortBy={(a, b) => {
                return a.name.localeCompare(b.name)
              }}
              itemWrapper={(item, node) => (
                <Tooltip
                  class="w-full"
                  placement="right"
                  gutter={12}
                  value={
                    <ModelTooltip
                      model={item}
                      latest={item.latest}
                      free={item.provider.id === "opencode" && (!item.cost || item.cost.input === 0)}
                    />
                  }
                >
                  {node}
                </Tooltip>
              )}
              onSelect={(x) => {
                if (!x) return
                const providerFamily = familyOf(x.provider.id)
                const accountId = selectedAccountId() || activeAccountForFamily(providerFamily)
                const unavailable = modelUnavailableReason(x.provider.id, accountId)
                if (unavailable) {
                  showToast({
                    variant: "error",
                    title: language.t("dialog.model.activity.selectBlocked"),
                    description: unavailable,
                  })
                  return
                }
                const family = providerFamily
                const setModel = () => {
                  local.model.set(
                    { modelID: x.id, providerID: x.provider.id },
                    {
                      recent: true,
                    },
                  )
                  dialog.close()
                }
                if (!accountId) {
                  setModel()
                  return
                }
                sdk.client.account
                  .setActive({ family, accountId })
                  .then(setModel)
                  .catch((err) => {
                    showToast({
                      variant: "error",
                      title: language.t("common.requestFailed"),
                      description: err instanceof Error ? err.message : String(err),
                    })
                  })
              }}
            >
              {(item) => (
                <ModelItem
                  item={item}
                  selected={false}
                  enabled={local.model.enabled({ modelID: item.id, providerID: item.provider.id })}
                  unavailableReason={modelUnavailableReason(item.provider.id, selectedAccountId())}
                  onToggleEnabled={(e: MouseEvent) => {
                    e.stopPropagation()
                    e.preventDefault()
                    const key = { modelID: item.id, providerID: item.provider.id }
                    local.model.setVisibility(key, !local.model.enabled(key))
                  }}
                />
              )}
            </List>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
