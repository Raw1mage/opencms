import { Popover as Kobalte } from "@kobalte/core/popover"
import {
  Component,
  ComponentProps,
  createEffect,
  createMemo,
  createSignal,
  createResource,
  For,
  JSX,
  onCleanup,
  Show,
  ValidComponent,
} from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
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
import { showToast } from "@opencode-ai/ui/toast"
import { iconNames, type IconName } from "@opencode-ai/ui/icons/provider"
import {
  buildAccountRows,
  buildProviderRows,
  filterModelsForMode,
  normalizeProviderFamily,
} from "./model-selector-state"
import "./dialog-select-model.css"

function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(" ")
}

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

const MODEL_MANAGER_LAYOUT_STORAGE_KEY = "opencode.web.modelManager.layout.v1"

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
            "size-6 shrink-0 opacity-100 transition-opacity",
            props.enabled !== false
              ? "[&_[data-slot=icon-svg]]:text-icon-success-base hover:[&_[data-slot=icon-svg]]:text-icon-success-base"
              : "[&_[data-slot=icon-svg]]:text-icon-danger-base hover:[&_[data-slot=icon-svg]]:text-icon-danger-base",
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
  showUnavailableTag?: boolean
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
        <Show when={props.showUnavailableTag !== false && props.unavailableReason}>
          <Tag>{language.t("dialog.model.activity.unavailable")}</Tag>
        </Show>
      </div>
      <IconButton
        icon={props.enabled ? "eye" : "circle-ban-sign"}
        variant="ghost"
        class={cn(
          "size-6 shrink-0 opacity-100 transition-opacity",
          props.enabled
            ? "[&_[data-slot=icon-svg]]:text-icon-success-base hover:[&_[data-slot=icon-svg]]:text-icon-success-base"
            : "[&_[data-slot=icon-svg]]:text-icon-danger-base hover:[&_[data-slot=icon-svg]]:text-icon-danger-base",
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

  const [accountInfo, { refetch: refetchAccountInfo }] = createResource(async () => {
    return sdk.client.account.listAll().then((x) => x.data)
  })

  const [selectedProviderId, setSelectedProviderId] = createSignal<string>(props.provider || "")
  const [selectedAccountId, setSelectedAccountId] = createSignal<string>("")
  const [switchingAccountId, setSwitchingAccountId] = createSignal<string>("")
  const [mode, setMode] = createSignal<"favorites" | "all">("favorites")
  const [mobileSection, setMobileSection] = createSignal<"provider" | "account" | "model">("provider")
  const isMobileViewport = createMediaQuery("(max-width: 767px)")
  const [dialogOffset, setDialogOffset] = createSignal({ x: 0, y: 0 })
  const initialDialogSize = () => {
    if (typeof window === "undefined") return { width: 980, height: 760 }
    if (window.innerWidth < 768) {
      return {
        width: Math.max(320, window.innerWidth - 16),
        height: Math.max(420, window.innerHeight - 16),
      }
    }
    return {
      width: Math.min(window.innerWidth - 16, Math.max(900, Math.floor(window.innerWidth * 0.78))),
      height: Math.min(window.innerHeight - 16, Math.max(620, Math.floor(window.innerHeight * 0.78))),
    }
  }
  const [dialogSize, setDialogSize] = createSignal(initialDialogSize())
  let dialogContainerEl: HTMLElement | undefined

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

  const resolveDialogContainer = () => {
    if (dialogContainerEl && document.body.contains(dialogContainerEl)) return dialogContainerEl
    const content = document.querySelector(".model-manager-dialog") as HTMLElement | null
    const container = content?.closest('[data-slot="dialog-container"]') as HTMLElement | null
    dialogContainerEl = container ?? undefined
    return dialogContainerEl
  }

  const clampDialogState = (nextSize = dialogSize(), nextOffset = dialogOffset()) => {
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      return {
        size: {
          width: Math.max(320, Math.min(window.innerWidth - 16, nextSize.width)),
          height: Math.max(420, Math.min(window.innerHeight - 16, nextSize.height)),
        },
        offset: { x: 0, y: 0 },
      }
    }
    // Keep a minimum size, but avoid strict viewport max-clamping.
    // Hard max + offset clamping caused reverse-motion feeling while resizing.
    const width = Math.max(560, nextSize.width)
    const height = Math.max(320, nextSize.height)
    const x = nextOffset.x
    const y = nextOffset.y
    return { size: { width, height }, offset: { x, y } }
  }

  const loadDialogLayout = () => {
    if (typeof window === "undefined") return
    try {
      const raw = window.localStorage.getItem(MODEL_MANAGER_LAYOUT_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as {
        width?: number
        height?: number
        x?: number
        y?: number
      }
      const nextSize = {
        width: typeof parsed.width === "number" ? parsed.width : dialogSize().width,
        height: typeof parsed.height === "number" ? parsed.height : dialogSize().height,
      }
      const nextOffset = {
        x: typeof parsed.x === "number" ? parsed.x : dialogOffset().x,
        y: typeof parsed.y === "number" ? parsed.y : dialogOffset().y,
      }
      const clamped = clampDialogState(nextSize, nextOffset)
      setDialogSize(clamped.size)
      setDialogOffset(clamped.offset)
    } catch {
      // ignore malformed persisted layout
    }
  }

  const saveDialogLayout = () => {
    if (typeof window === "undefined") return
    try {
      const size = dialogSize()
      const offset = dialogOffset()
      window.localStorage.setItem(
        MODEL_MANAGER_LAYOUT_STORAGE_KEY,
        JSON.stringify({ width: size.width, height: size.height, x: offset.x, y: offset.y }),
      )
    } catch {
      // ignore storage quota/security errors
    }
  }

  const applyDialogFrame = () => {
    const container = resolveDialogContainer()
    if (!container) return

    if (isMobileViewport()) {
      container.style.width = ""
      container.style.height = ""
      container.style.transform = ""
      return
    }

    const state = clampDialogState()
    if (
      state.size.width !== dialogSize().width ||
      state.size.height !== dialogSize().height ||
      state.offset.x !== dialogOffset().x ||
      state.offset.y !== dialogOffset().y
    ) {
      setDialogSize(state.size)
      setDialogOffset(state.offset)
    }
    container.style.width = `${state.size.width}px`
    container.style.height = `${state.size.height}px`
    container.style.transform = `translate(${state.offset.x}px, ${state.offset.y}px)`
  }

  createEffect(() => {
    applyDialogFrame()
  })

  createEffect(() => {
    loadDialogLayout()
  })

  createEffect(() => {
    dialogSize()
    dialogOffset()
    saveDialogLayout()
  })

  createEffect(() => {
    const onResize = () => {
      applyDialogFrame()
    }
    window.addEventListener("resize", onResize)
    onCleanup(() => window.removeEventListener("resize", onResize))
  })

  const startDrag = (event: MouseEvent) => {
    if (isMobileViewport()) return
    const target = event.target as HTMLElement | null
    if (!target) return
    if (target.closest("button, [role='switch'], [data-no-drag], input, textarea, a")) return

    event.preventDefault()
    const start = { x: event.clientX, y: event.clientY }
    const origin = dialogOffset()

    const onMove = (moveEvent: MouseEvent) => {
      const nextOffset = {
        x: origin.x + (moveEvent.clientX - start.x),
        y: origin.y + (moveEvent.clientY - start.y),
      }
      setDialogOffset(clampDialogState(dialogSize(), nextOffset).offset)
    }

    const onUp = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }

    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  const startResize = (event: MouseEvent) => {
    if (isMobileViewport()) return
    event.preventDefault()
    event.stopPropagation()
    const start = { x: event.clientX, y: event.clientY }
    const origin = dialogSize()
    const originOffset = dialogOffset()

    const onMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - start.x
      const dy = moveEvent.clientY - start.y
      const nextSize = {
        width: origin.width + dx,
        height: origin.height + dy,
      }
      const nextOffset = {
        x: originOffset.x + dx / 2,
        y: originOffset.y + dy / 2,
      }
      const clamped = clampDialogState(nextSize, nextOffset)
      setDialogSize(clamped.size)
      setDialogOffset(clamped.offset)
    }

    const onUp = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }

    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  createEffect(() => {
    const header = document.querySelector(".model-manager-dialog [data-slot='dialog-header']") as HTMLElement | null
    if (!header) return
    header.style.cursor = isMobileViewport() ? "default" : "move"
    const onMouseDown = (event: globalThis.MouseEvent) => startDrag(event as unknown as MouseEvent)
    header.addEventListener("mousedown", onMouseDown)
    onCleanup(() => header.removeEventListener("mousedown", onMouseDown))
  })

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

  const isAccountLikeProviderId = (id: string) => id.includes("@")

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
    const inFamily = models.filter((m) => familyOf(m.provider.id) === providerId)
    if (inFamily.length === 0) return []

    const currentProviderID = local.model.current()?.provider?.id
    const resolvedProviderID =
      inFamily.find((m) => m.provider.id === providerId)?.provider.id ??
      (currentProviderID && inFamily.some((m) => m.provider.id === currentProviderID)
        ? currentProviderID
        : undefined) ??
      inFamily.find((m) => !isAccountLikeProviderId(m.provider.id))?.provider.id ??
      inFamily[0]?.provider.id

    const scopedModels = resolvedProviderID ? inFamily.filter((m) => m.provider.id === resolvedProviderID) : inFamily

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

  const switchActiveAccount = (row: { id: string; unavailable?: string }) => {
    const providerId = selectedProviderId()
    if (!providerId) return
    const family = familyOf(providerId)
    if (!family) return

    if (row.unavailable) {
      showToast({
        variant: "error",
        title: language.t("dialog.model.activity.selectBlocked"),
        description: row.unavailable,
      })
      return
    }

    const previous = selectedAccountId()
    setSelectedAccountId(row.id)
    setSwitchingAccountId(row.id)

    sdk.client.account
      .setActive({ family, accountId: row.id })
      .then(() => refetchAccountInfo())
      .catch((err) => {
        setSelectedAccountId(previous)
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => setSwitchingAccountId(""))
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      class="model-manager-dialog relative w-full h-full min-w-0 md:min-w-[560px] min-h-[320px] flex flex-col p-0 overflow-hidden [&_[data-slot=dialog-header]]:px-3 [&_[data-slot=dialog-header]]:py-2 [&_[data-slot=dialog-title]]:text-14-medium"
    >
      <div
        class="px-3 py-2 border-b border-border-base bg-surface-base flex items-center justify-between gap-2 cursor-move select-none"
        onMouseDown={startDrag}
      >
        <div class="flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={mode() === "all"}
            class="relative h-8 rounded-full border border-border-strong bg-surface-raised px-1 text-11-medium shadow-sm hover:border-border-stronger focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
            onClick={() => setMode((current) => (current === "favorites" ? "all" : "favorites"))}
            title={`${language.t("dialog.model.mode.curated")}/${language.t("dialog.model.mode.all")}`}
          >
            <div class="relative grid h-full grid-cols-2 items-center gap-1 px-2 min-w-[128px]">
              <span
                class={cn(
                  "z-10 text-center transition-colors select-none",
                  mode() === "favorites" ? "text-text-strong" : "text-text-weaker opacity-85",
                )}
              >
                {language.t("dialog.model.mode.curated")}
              </span>
              <span
                class={cn(
                  "z-10 text-center transition-colors select-none",
                  mode() === "all" ? "text-text-strong" : "text-text-weaker opacity-85",
                )}
              >
                {language.t("dialog.model.mode.all")}
              </span>
              <span
                class={cn(
                  "absolute top-0.5 h-7 w-[calc(50%-0.25rem)] rounded-full bg-surface-raised-pressed shadow-sm transition-transform duration-150",
                  mode() === "all" ? "translate-x-[calc(100%+0.25rem)]" : "translate-x-0",
                )}
              />
            </div>
          </button>
        </div>

        <div class="flex items-center gap-2">
          <Button
            size="small"
            variant="ghost"
            class="h-7 rounded-full px-3 text-text-weak hover:text-text-base border border-border-base"
            icon="plus-small"
            onClick={() => dialog.show(() => <DialogSelectProvider />)}
          >
            {language.t("command.provider.connect")}
          </Button>
          <Button
            size="small"
            variant="ghost"
            class="h-7 rounded-full px-3 text-text-weak hover:text-text-base border border-border-base"
            icon="sliders"
            onClick={() => dialog.show(() => <DialogManageModels />)}
          >
            {language.t("dialog.model.manage")}
          </Button>
        </div>
      </div>

      <div class="md:hidden px-3 py-2 border-b border-border-base bg-surface-base">
        <div class="grid grid-cols-3 gap-1 rounded-lg bg-surface-raised p-1">
          <button
            type="button"
            class={cn(
              "h-8 rounded-md text-12-medium transition-colors",
              mobileSection() === "provider" ? "bg-surface-raised-pressed text-text-strong" : "text-text-weak",
            )}
            onClick={() => setMobileSection("provider")}
          >
            {language.t("common.providers")}
          </button>
          <button
            type="button"
            class={cn(
              "h-8 rounded-md text-12-medium transition-colors",
              mobileSection() === "account" ? "bg-surface-raised-pressed text-text-strong" : "text-text-weak",
            )}
            onClick={() => setMobileSection("account")}
          >
            {language.t("settings.accounts.title")}
          </button>
          <button
            type="button"
            class={cn(
              "h-8 rounded-md text-12-medium transition-colors",
              mobileSection() === "model" ? "bg-surface-raised-pressed text-text-strong" : "text-text-weak",
            )}
            onClick={() => setMobileSection("model")}
          >
            {language.t("dialog.model.select.title")}
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 flex-1 min-h-0 h-full overflow-hidden">
        <div
          class={cn(
            "border-r border-border-base flex-col bg-surface-base min-w-0 min-h-0",
            mobileSection() === "provider" ? "flex" : "hidden",
            "md:flex",
          )}
        >
          <div class="model-manager-column-scroll p-2 space-y-1 overflow-y-auto flex-1 min-h-0">
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
        </div>

        <div
          class={cn(
            "border-r border-border-base flex-col bg-surface-base min-w-0 min-h-0",
            mobileSection() === "account" ? "flex" : "hidden",
            "md:flex",
          )}
        >
          <div class="px-3 py-2 text-11-medium text-text-weak uppercase tracking-wider border-b border-border-base">
            {language.t("settings.accounts.title")}
          </div>
          <Show when={selectedProviderId()}>
            {(provider) => <div class="px-3 py-1 text-11-regular text-text-weak">{provider()}</div>}
          </Show>
          <div class="model-manager-column-scroll p-2 space-y-1 overflow-y-auto flex-1 min-h-0">
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
                    disabled={switchingAccountId() === row.id}
                    onClick={() => switchActiveAccount(row)}
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

        <div
          class={cn(
            "flex-col min-w-0 min-h-0 bg-surface-raised-base",
            mobileSection() === "model" ? "flex" : "hidden",
            "md:flex",
          )}
        >
          <div class="px-3 py-2 text-11-regular text-text-weak border-b border-border-base md:hidden">
            <span>{selectedProviderId() || "--"}</span>
            <span class="px-1">/</span>
            <span>{selectedAccountId() || "--"}</span>
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
                const familyCandidates = local.model
                  .list()
                  .filter((m) => m.id === x.id && familyOf(m.provider.id) === providerFamily)
                const providerIDForSelection =
                  familyCandidates.find((m) => m.provider.id === providerFamily)?.provider.id ??
                  familyCandidates.find((m) => !isAccountLikeProviderId(m.provider.id))?.provider.id ??
                  x.provider.id
                const setModel = () => {
                  local.model.set(
                    { modelID: x.id, providerID: providerIDForSelection },
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
                  showUnavailableTag={mode() !== "all"}
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
      <Show when={!isMobileViewport()}>
        <button
          type="button"
          aria-label="Resize model manager dialog"
          data-no-drag
          class="model-manager-resize-handle"
          onMouseDown={startResize}
        >
          <span class="model-manager-resize-corner" />
        </button>
      </Show>
    </Dialog>
  )
}
