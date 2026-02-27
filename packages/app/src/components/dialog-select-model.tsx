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
import { showToast } from "@opencode-ai/ui/toast"
import { iconNames, type IconName } from "@opencode-ai/ui/icons/provider"
import {
  buildAccountRows,
  buildProviderRows,
  filterModelsForMode,
  normalizeProviderFamily,
} from "./model-selector-state"

function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(" ")
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
  onToggleEnabled?: (e: MouseEvent) => void
  enabled?: boolean
}> = (props) => {
  return (
    <div class="flex items-center w-full group">
      <button
        class={cn(
          "flex items-center gap-2 flex-1 px-3 py-2 text-13-regular rounded-md transition-colors text-left outline-none min-w-0",
          props.selected
            ? "bg-surface-raised-pressed text-text-strong"
            : "text-text-base hover:bg-surface-raised-hover",
        )}
        onClick={props.onClick}
      >
        <Show when={props.providerIcon} fallback={<Icon name={props.icon as any} class="size-4 shrink-0" />}>
          <ProviderIcon id={props.providerIcon as IconName} class="size-4 shrink-0 opacity-80" />
        </Show>
        <span class="truncate flex-1">{props.name}</span>
      </button>
      <Show when={props.onToggleEnabled}>
        <IconButton
          icon={props.enabled !== false ? "eye" : "circle-ban-sign"}
          variant="ghost"
          class={cn(
            "size-6 shrink-0 opacity-100 transition-opacity hover:text-icon-base",
            props.enabled !== false ? "text-icon-base" : "text-icon-warning-base",
          )}
          onClick={props.onToggleEnabled}
        />
      </Show>
    </div>
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
      </div>
      <IconButton
        icon={props.enabled ? "eye" : "circle-ban-sign"}
        variant="ghost"
        class={cn(
          "size-6 shrink-0 opacity-100 transition-opacity hover:text-icon-base",
          props.enabled ? "text-icon-base" : "text-icon-warning-base",
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

  const providers = createMemo(() => {
    const allProviders = globalSync.data.provider.all ?? []
    const families = accountInfo.latest?.families as Record<string, { accounts?: Record<string, unknown> }> | undefined
    return buildProviderRows({
      providers: allProviders,
      accountFamilies: families,
      disabledProviders: (globalSync.data.config.disabled_providers ?? []) as string[],
    })
  })

  const providersForMode = createMemo(() => {
    if (mode() === "all") return providers()
    return providers().filter((provider) => provider.enabled)
  })

  createEffect(() => {
    const selected = selectedProviderId()
    if (selected && providersForMode().some((provider) => provider.id === selected)) return
    if (providersForMode().length > 0) {
      setSelectedProviderId(providersForMode()[0].id)
      return
    }
    setSelectedProviderId("")
  })

  const accountsForSelectedProvider = createMemo(() => {
    const providerId = selectedProviderId()
    if (!providerId) return [] as Array<{ id: string; label: string; active: boolean; unavailable?: string }>
    const families = accountInfo.latest?.families as
      | Record<string, { accounts?: Record<string, unknown>; activeAccount?: string }>
      | undefined
    return buildAccountRows({
      selectedProviderFamily: providerId,
      accountFamilies: families,
      formatCooldown: (minutes) => language.t("settings.models.recommendations.cooldown", { minutes }),
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
    if (!providerId) return [] as ReturnType<ReturnType<typeof useModels>["list"]>

    const models = local.model.list()
    const selectedAccount = selectedAccountId()
    const activeAccount = activeAccountForFamily(providerId)
    const candidateProviderIDs = [selectedAccount, activeAccount, providerId].filter((id): id is string => !!id)
    const resolvedProviderID =
      candidateProviderIDs.find((id) => models.some((m) => m.provider.id === id)) ??
      models.find((m) => familyOf(m.provider.id) === providerId)?.provider.id

    const scopedModels = resolvedProviderID
      ? models.filter((m) => m.provider.id === resolvedProviderID)
      : models.filter((m) => familyOf(m.provider.id) === providerId)

    return filterModelsForMode({
      models: scopedModels,
      providerFamily: providerId,
      mode: mode(),
      isVisible: (key) => local.model.visible(key),
    })
  })

  const toggleProviderEnabled = (e: MouseEvent, family: string) => {
    e.stopPropagation()
    e.preventDefault()
    const before = (globalSync.data.config.disabled_providers ?? []) as string[]
    const current = new Set(before)
    const normalized = normalizeProviderFamily(family)
    if (!normalized) return
    if (current.has(normalized)) {
      current.delete(normalized)
    } else {
      current.add(normalized)
    }
    const next = [...current]
    globalSync.set("config", "disabled_providers", next)
    globalSync.updateConfig({ disabled_providers: next }).catch((err) => {
      globalSync.set("config", "disabled_providers", before)
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      class="w-[800px] max-w-[90vw] h-[600px] max-h-[85vh] flex flex-col p-0 overflow-hidden"
    >
      <div class="flex flex-1 min-h-0 h-full overflow-hidden">
        <div class="w-64 flex-shrink-0 border-r border-border-base flex flex-col bg-surface-base">
          <div class="p-2 space-y-1 overflow-y-auto flex-1">
            <div class="px-3 py-2 text-11-medium text-text-weak uppercase tracking-wider">
              {language.t("common.providers")}
            </div>
            <For each={providersForMode()}>
              {(provider) => (
                <ProviderItem
                  id={provider.id}
                  name={provider.accounts > 0 ? `${provider.name} (${provider.accounts})` : provider.name}
                  providerIcon={iconNames.includes(provider.id as IconName) ? provider.id : "synthetic"}
                  selected={selectedProviderId() === provider.id}
                  enabled={provider.enabled}
                  onToggleEnabled={(e) => toggleProviderEnabled(e, provider.id)}
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
            {language.t("settings.accounts.title")}
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
                        <Icon name="check-small" class="text-icon-success-base shrink-0" />
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
                  enabled={local.model.visible({ modelID: item.id, providerID: item.provider.id })}
                  unavailableReason={modelUnavailableReason(item.provider.id, selectedAccountId())}
                  onToggleEnabled={(e: MouseEvent) => {
                    e.stopPropagation()
                    e.preventDefault()
                    const key = { modelID: item.id, providerID: item.provider.id }
                    const nextVisible = !local.model.visible(key)
                    local.model.setVisibility(key, nextVisible)
                    if (nextVisible && !local.model.favorite(key)) {
                      local.model.toggleFavorite(key)
                    }
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
