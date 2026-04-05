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
import { useGlobalSDK } from "@/context/global-sdk"
import { useSDK } from "@/context/sdk"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/tag"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { TextField } from "@opencode-ai/ui/text-field"
import { DialogSelectProvider } from "./dialog-select-provider"
import { DialogConnectProvider } from "./dialog-connect-provider"
import { DialogManageModels } from "./dialog-manage-models"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { useParams } from "@solidjs/router"
import { useModels } from "@/context/models"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { showToast } from "@opencode-ai/ui/toast"
import { iconNames, type IconName } from "@opencode-ai/ui/icons/provider"
import {
  buildAccountRows,
  buildProviderRows,
  filterModelsForMode,
  getActiveAccountForProviderKey,
  getFilteredModelsForSelection,
  getModelUnavailableReason,
  isAccountLikeProviderId,
  pickSelectedAccount,
  pickSelectedModel,
  pickSelectedProvider,
  providerKeyOf,
  sameModelSelectorSelection,
} from "./model-selector-state"
import { loadQuotaHint, peekQuotaHint } from "@/utils/quota-hint-cache"
import "./dialog-select-model.css"

function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(" ")
}

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

const MODEL_MANAGER_LAYOUT_STORAGE_KEY = "opencode.web.modelManager.layout.v1"
const MODEL_MANAGER_PROVIDER_MIN_PX = 160
const MODEL_MANAGER_ACCOUNT_MIN_PX = 200
const MODEL_MANAGER_MODEL_MIN_PX = 160
const MODEL_MANAGER_DEFAULT_COLUMN_LAYOUT = { providerRatio: 0.31, accountRatio: 0.35 }


type AccountRecord = {
  id: string
  providerKey: string
  name: string
  type: "api" | "subscription" | "oauth"
  active: boolean
  email?: string
  projectId?: string
  coolingDownUntil?: number
  cooldownReason?: string
  metadata?: Record<string, unknown>
}

type ModelListEntry = ReturnType<ReturnType<typeof useModels>["list"]>[number]
type ModelListGroup = { items: ModelListEntry[] }

function preserveScrollPosition(getElement: () => HTMLElement | undefined, action: () => void | Promise<unknown>) {
  const previous = getElement()
  const top = previous?.scrollTop ?? 0
  const left = previous?.scrollLeft ?? 0

  const restore = () => {
    const current = getElement()
    if (!current) return
    current.scrollTop = top
    current.scrollLeft = left
  }

  queueMicrotask(restore)
  requestAnimationFrame(() => {
    restore()
    requestAnimationFrame(restore)
  })

  const result = action()
  Promise.resolve(result).finally(() => {
    queueMicrotask(restore)
    requestAnimationFrame(() => {
      restore()
      requestAnimationFrame(restore)
    })
  })
}

function normalizeAccountRecord(
  providerKey: string,
  accountId: string,
  raw: Record<string, unknown> | undefined,
  activeAccount?: string,
): AccountRecord {
  const typeValue = typeof raw?.type === "string" ? raw.type : "api"
  const type: AccountRecord["type"] =
    typeValue === "subscription" || typeValue === "oauth" || typeValue === "api" ? typeValue : "api"
  return {
    id: accountId,
    providerKey,
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name : accountId,
    type,
    active: activeAccount === accountId,
    email: typeof raw?.email === "string" ? raw.email : undefined,
    projectId: typeof raw?.projectId === "string" ? raw.projectId : undefined,
    coolingDownUntil: typeof raw?.coolingDownUntil === "number" ? raw.coolingDownUntil : undefined,
    cooldownReason: typeof raw?.cooldownReason === "string" ? raw.cooldownReason : undefined,
    metadata: raw?.metadata && typeof raw.metadata === "object" ? (raw.metadata as Record<string, unknown>) : undefined,
  }
}

function accountTypeLabel(type: AccountRecord["type"]) {
  if (type === "subscription") return "Subscription"
  if (type === "oauth") return "OAuth"
  return "API"
}

function responseErrorMessage(payload: unknown): string | undefined {
  if (payload && typeof payload === "object") {
    if ("data" in payload) {
      const nested = responseErrorMessage((payload as { data?: unknown }).data)
      if (nested) return nested
    }
    if ("error" in payload) {
      const nested = responseErrorMessage((payload as { error?: unknown }).error)
      if (nested) return nested
    }
    if ("message" in payload) {
      const message = (payload as { message?: unknown }).message
      if (typeof message === "string" && message.trim()) return message
    }
  }
  if (payload instanceof Error && payload.message) return payload.message
  if (typeof payload === "string" && payload.trim()) return payload
  return undefined
}

async function readResponseMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as unknown
    return responseErrorMessage(payload) ?? response.statusText
  } catch {
    return response.statusText || `Request failed (${response.status})`
  }
}

const AccountActionButton: Component<{
  label: string
  icon: "eye" | "edit" | "trash"
  onClick: (event: MouseEvent) => void
  tone?: "danger"
}> = (props) => {
  return (
    <Tooltip placement="top" value={props.label}>
      <IconButton
        icon={props.icon}
        variant="ghost"
        class={cn(
          "size-6 shrink-0",
          props.tone === "danger" &&
            "[&_[data-slot=icon-svg]]:text-icon-danger-base hover:[&_[data-slot=icon-svg]]:text-icon-danger-base",
        )}
        aria-label={props.label}
        onClick={props.onClick}
      />
    </Tooltip>
  )
}

const AccountViewDialog: Component<{ account: AccountRecord }> = (props) => {
  const dialog = useDialog()
  const sdk = useSDK()
  const [resetting, setResetting] = createSignal(false)
  const [cooldownCleared, setCooldownCleared] = createSignal(false)
  const cooldown = createMemo(() => {
    if (cooldownCleared()) return undefined
    if (!props.account.coolingDownUntil || props.account.coolingDownUntil <= Date.now()) return undefined
    const minutes = Math.max(1, Math.ceil((props.account.coolingDownUntil - Date.now()) / 60000))
    return props.account.cooldownReason ? `${props.account.cooldownReason} (${minutes}m)` : `Cooling down (${minutes}m)`
  })

  const resetCooldown = async () => {
    setResetting(true)
    try {
      const response = await sdk.fetch(
        `${sdk.url}/api/v2/account/${encodeURIComponent(props.account.providerKey)}/${encodeURIComponent(props.account.id)}/reset-cooldown`,
        { method: "POST" },
      )
      if (!response.ok) {
        throw new Error(await readResponseMessage(response))
      }
      setCooldownCleared(true)
      showToast({
        variant: "success",
        title: "Cooldown reset",
        description: `${props.account.name} is now available`,
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: "Failed to reset cooldown",
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setResetting(false)
    }
  }

  const details = createMemo(() =>
    [
      ["Provider", props.account.providerKey],
      ["Account ID", props.account.id],
      ["Name", props.account.name],
      ["Type", accountTypeLabel(props.account.type)],
      ["Email", props.account.email],
      ["Project", props.account.projectId],
      ["Status", props.account.active ? "Active" : "Inactive"],
      ["Cooldown", cooldown()],
    ].filter((entry): entry is [string, string] => Boolean(entry[1])),
  )

  return (
    <Dialog title="Account details">
      <div class="flex flex-col gap-4 px-2.5 pb-3">
        <div class="rounded-lg border border-border-base bg-surface-base p-4">
          <div class="space-y-3">
            <For each={details()}>
              {([label, value]) => (
                <div class="grid grid-cols-[96px_minmax(0,1fr)] gap-3 text-13-regular">
                  <div class="text-text-weak">{label}</div>
                  <div class="min-w-0 break-words text-text-strong">{value}</div>
                </div>
              )}
            </For>
          </div>
          <Show when={props.account.metadata && Object.keys(props.account.metadata).length > 0}>
            <div class="mt-4 border-t border-border-base pt-4">
              <div class="mb-2 text-12-medium uppercase tracking-wide text-text-weak">Metadata</div>
              <pre class="max-h-56 overflow-auto rounded-md bg-surface-raised p-3 text-11-regular text-text-base">
                {JSON.stringify(props.account.metadata, null, 2)}
              </pre>
            </div>
          </Show>
        </div>
        <div class="flex justify-between">
          <Button size="small" variant="secondary" onClick={resetCooldown} loading={resetting()}>
            Reset Cooldown
          </Button>
          <Button size="small" variant="secondary" onClick={() => dialog.close()}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const AccountRenameDialog: Component<{ account: AccountRecord; onSaved: () => Promise<void> | void }> = (props) => {
  const dialog = useDialog()
  const sdk = useSDK()
  const [name, setName] = createSignal(props.account.name)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const save = async () => {
    const nextName = name().trim()
    if (!nextName) {
      setError("Name is required")
      return
    }
    if (nextName === props.account.name) {
      dialog.close()
      return
    }

    setSaving(true)
    setError(undefined)
    try {
      const response = await sdk.fetch(
        `${sdk.url}/api/v2/account/${encodeURIComponent(props.account.providerKey)}/${encodeURIComponent(props.account.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: nextName }),
        },
      )
      if (!response.ok) {
        throw new Error(await readResponseMessage(response))
      }
      await props.onSaved()
      showToast({
        variant: "success",
        title: "Account name updated",
        description: `${props.account.providerKey} → ${nextName}`,
      })
      dialog.close()
    } catch (err) {
      setError(responseErrorMessage(err) ?? "Failed to update account name")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="Edit account name">
      <div class="flex flex-col gap-4 px-2.5 pb-3">
        <div class="text-14-regular text-text-base">
          Update the display name for <span class="font-medium text-text-strong">{props.account.providerKey}</span> /{" "}
          {props.account.id}.
        </div>
        <TextField
          autofocus
          label="Account name"
          value={name()}
          onChange={setName}
          validationState={error() ? "invalid" : undefined}
          error={error()}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void save()
            }
          }}
        />
        <div class="flex justify-end gap-2">
          <Button size="small" variant="secondary" onClick={() => dialog.close()} disabled={saving()}>
            Cancel
          </Button>
          <Button size="small" variant="primary" onClick={() => void save()} loading={saving()}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const AccountDeleteDialog: Component<{
  account: AccountRecord
  onDeleted: () => Promise<void> | void
  onOptimisticDelete: (id: string) => void
}> = (props) => {
  const dialog = useDialog()
  const sdk = useSDK()

  const remove = () => {
    props.onOptimisticDelete(props.account.id)
    dialog.close()
    void (async () => {
      try {
        const response = await sdk.fetch(
          `${sdk.url}/api/v2/account/${encodeURIComponent(props.account.providerKey)}/${encodeURIComponent(props.account.id)}`,
          { method: "DELETE" },
        )
        if (!response.ok) throw new Error(await readResponseMessage(response))
        await props.onDeleted()
        showToast({
          variant: "success",
          title: "Account deleted",
          description: `${props.account.providerKey} → ${props.account.name}`,
        })
      } catch (err) {
        showToast({
          variant: "error",
          title: "Failed to delete account",
          description: responseErrorMessage(err) ?? String(err),
        })
        await props.onDeleted()
      }
    })()
  }

  return (
    <Dialog title="Delete account">
      <div class="flex flex-col gap-4 px-2.5 pb-3">
        <div class="rounded-lg border border-border-base bg-surface-base p-4 text-14-regular text-text-base">
          <div>Are you sure you want to delete this account?</div>
          <div class="mt-2 font-medium text-text-strong">
            {props.account.providerKey} / {props.account.name}
          </div>
          <div class="mt-1 text-12-regular text-text-weak">Account ID: {props.account.id}</div>
        </div>
        <div class="flex justify-end gap-2">
          <Button size="small" variant="secondary" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button
            size="small"
            variant="secondary"
            class="text-icon-danger-base hover:text-icon-danger-base"
            onClick={() => remove()}
          >
            Delete
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
}> = (props) => {
  const local = useLocal()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const params = useParams()

  const resolveSelectionAccountId = (providerId: string) => {
    const targetProviderKey = providerKeyOf(providerId)
    const currentSelection = local.model.selection(params.id)
    if (
      currentSelection &&
      providerKeyOf(currentSelection.providerID) === targetProviderKey &&
      currentSelection.accountID
    ) {
      return currentSelection.accountID
    }
    const providerRow = globalSync.data.account_families?.[targetProviderKey]
    return typeof providerRow?.activeAccount === "string" ? providerRow.activeAccount : undefined
  }

  const models = createMemo(() =>
    local.model
      .list()
      .filter((m: ModelListEntry) => local.model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m: ModelListEntry) => (props.provider ? m.provider.id === props.provider : true)),
  )

  return (
    <List
      class={`flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x: ModelListEntry) => `${x.provider.id}:${x.id}`}
      items={models}
      current={local.model.current(params.id)}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={(a: ModelListEntry, b: ModelListEntry) => a.name.localeCompare(b.name)}
      groupBy={(x: ModelListEntry) => x.provider.name}
      sortGroupsBy={(a: ModelListGroup, b: ModelListGroup) => {
        const aProvider = a.items[0].provider.id
        const bProvider = b.items[0].provider.id
        if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
        if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
        return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
      }}
      itemWrapper={(item: ModelListEntry, node: JSX.Element) => (
        <Tooltip
          class="w-full"
          placement="right-start"
          gutter={12}
          value={<ModelTooltip model={item} latest={item.latest} free={isFree(item.provider.id, item.cost)} />}
        >
          {node}
        </Tooltip>
      )}
      onSelect={(x: ModelListEntry | undefined) => {
        local.model.set(
          x
            ? {
                modelID: x.id,
                providerID: x.provider.id,
                accountID: resolveSelectionAccountId(x.provider.id),
              }
            : undefined,
          {
            recent: true,
            interrupt: true,
            syncSessionExecution: true,
          },
          params.id,
        )
        props.onSelect()
      }}
    >
      {(i: ModelListEntry) => (
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
      onOpenChange={(next: boolean) => {
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
          onEscapeKeyDown={(event: KeyboardEvent) => {
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
          onCloseAutoFocus={(event: Event) => {
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

export type ModelSelectResult = { providerID: string; modelID: string; accountID?: string }

export const DialogSelectModel: Component<{
  provider?: string
  initialProviderId?: string
  initialAccountId?: string
  initialMode?: "favorites" | "all"
  initialMobileSection?: "provider" | "account" | "model"
  initialAccountManagementMode?: boolean
  /** When provided, dialog operates in standalone mode (no LocalProvider needed).
   *  Calls back with the selected model key instead of using local.model.set(). */
  onModelSelect?: (key: ModelSelectResult) => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const local = props.onModelSelect ? undefined : useLocal()
  const models = useModels()
  const params = useParams()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const sdk = props.onModelSelect ? undefined : useSDK()

  // In standalone mode (onModelSelect provided), shim local.model with global models context
  const modelApi = props.onModelSelect
    ? {
        list: models.list,
        visible: (key: { modelID: string; providerID: string }) => models.visible(key),
        current: (_id?: string) =>
          models.find(
            props.initialProviderId && props.initialAccountId
              ? { providerID: props.initialProviderId, modelID: "" }
              : { providerID: "", modelID: "" },
          ) ?? undefined,
        selection: (_id?: string) => undefined as ModelSelectResult | undefined,
        set: async () => {},
        setVisibility: (key: { modelID: string; providerID: string }, v: boolean) => models.setVisibility(key, v),
      }
    : local!.model

  const [accountInfo, { refetch: refetchAccountInfo }] = createResource(async () => {
    const client = sdk?.client ?? globalSDK.client
    return client.account.listAll().then((x: { data: unknown }) => x.data)
  })

  const [optimisticDeletedAccountIds, setOptimisticDeletedAccountIds] = createSignal(new Set<string>())

  const [selectedProviderId, setSelectedProviderId] = createSignal<string>(props.initialProviderId ?? "")
  const [selectedAccountId, setSelectedAccountId] = createSignal<string>(props.initialAccountId ?? "")
  const [selectedModelKey, setSelectedModelKey] = createSignal<string>("")
  const [submitting, setSubmitting] = createSignal(false)
  const [mode, setMode] = createSignal<"favorites" | "all">(props.initialMode ?? "favorites")
  const [mobileSection, setMobileSection] = createSignal<"provider" | "account" | "model">(
    props.initialMobileSection ?? "provider",
  )
  const [accountManagementMode, setAccountManagementMode] = createSignal(props.initialAccountManagementMode ?? false)
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
  const [columnLayout, setColumnLayout] = createSignal(MODEL_MANAGER_DEFAULT_COLUMN_LAYOUT)
  const [layoutHydrated, setLayoutHydrated] = createSignal(false)
  const [columnsWidth, setColumnsWidth] = createSignal(0)
  let dialogContainerEl: HTMLElement | undefined
  let dialogHeaderEl: HTMLElement | undefined
  let columnsEl: HTMLDivElement | undefined
  let providerScrollEl: HTMLDivElement | undefined
  let modelPanelEl: HTMLDivElement | undefined

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

  const resolveDialogContainer = () => {
    if (dialogContainerEl && document.body.contains(dialogContainerEl)) return dialogContainerEl
    const content = document.querySelector(".model-manager-dialog") as HTMLElement | null
    const container = content?.closest('[data-slot="dialog-container"]') as HTMLElement | null
    dialogContainerEl = container ?? undefined
    return dialogContainerEl
  }

  const resolveDialogHeader = () => {
    if (dialogHeaderEl && document.body.contains(dialogHeaderEl)) return dialogHeaderEl
    const content = document.querySelector(".model-manager-dialog") as HTMLElement | null
    const header = content?.querySelector('[data-slot="dialog-header"]') as HTMLElement | null
    dialogHeaderEl = header ?? undefined
    return dialogHeaderEl
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
        providerRatio?: number
        accountRatio?: number
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
      if (typeof parsed.providerRatio === "number" && typeof parsed.accountRatio === "number") {
        setColumnLayout({ providerRatio: parsed.providerRatio, accountRatio: parsed.accountRatio })
      }
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
        JSON.stringify({
          width: size.width,
          height: size.height,
          x: offset.x,
          y: offset.y,
          providerRatio: columnLayout().providerRatio,
          accountRatio: columnLayout().accountRatio,
        }),
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

  const getDesktopColumnsWidth = () => {
    const measuredWidth = columnsWidth()
    if (measuredWidth > 0) return measuredWidth
    if (columnsEl) return columnsEl.getBoundingClientRect().width
    return dialogSize().width
  }

  const clampColumnLayout = (layout = columnLayout(), totalWidth = getDesktopColumnsWidth()) => {
    if (isMobileViewport()) return MODEL_MANAGER_DEFAULT_COLUMN_LAYOUT
    const total = Math.max(1, Math.floor(totalWidth))
    const providerMax = Math.max(
      MODEL_MANAGER_PROVIDER_MIN_PX,
      total - MODEL_MANAGER_ACCOUNT_MIN_PX - MODEL_MANAGER_MODEL_MIN_PX,
    )
    const providerPx = clamp(Math.round(layout.providerRatio * total), MODEL_MANAGER_PROVIDER_MIN_PX, providerMax)
    const accountMax = Math.max(MODEL_MANAGER_ACCOUNT_MIN_PX, total - providerPx - MODEL_MANAGER_MODEL_MIN_PX)
    const accountPx = clamp(Math.round(layout.accountRatio * total), MODEL_MANAGER_ACCOUNT_MIN_PX, accountMax)
    return {
      providerRatio: providerPx / total,
      accountRatio: accountPx / total,
    }
  }

  const columnTemplate = createMemo(() => {
    if (isMobileViewport()) return undefined
    const total = getDesktopColumnsWidth()
    const layout = clampColumnLayout(columnLayout(), total)
    const providerPx = Math.round(layout.providerRatio * total)
    const accountPx = Math.round(layout.accountRatio * total)
    return `${providerPx}px ${accountPx}px minmax(${MODEL_MANAGER_MODEL_MIN_PX}px, 1fr)`
  })

  const dividerOffsets = createMemo(() => {
    const total = getDesktopColumnsWidth()
    const layout = clampColumnLayout(columnLayout(), total)
    const left = Math.round(layout.providerRatio * total)
    const middle = left + Math.round(layout.accountRatio * total)
    return { left, middle }
  })

  createEffect(() => {
    applyDialogFrame()
  })


  createEffect(() => {
    if (layoutHydrated()) return
    loadDialogLayout()
    setLayoutHydrated(true)
  })

  createEffect(() => {
    dialogSize()
    dialogOffset()
    columnLayout()
    saveDialogLayout()
  })

  createEffect(() => {
    if (isMobileViewport()) return
    const total = getDesktopColumnsWidth()
    if (!total) return
    setColumnLayout((current) => clampColumnLayout(current, total))
  })

  createEffect(() => {
    const element = columnsEl
    if (!element) return

    const updateWidth = () => {
      setColumnsWidth(element.getBoundingClientRect().width)
    }

    updateWidth()
    if (typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.getBoundingClientRect().width
      setColumnsWidth(width)
    })
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    const onResize = () => {
      applyDialogFrame()
    }
    window.addEventListener("resize", onResize)
    onCleanup(() => window.removeEventListener("resize", onResize))
  })

  createEffect(() => {
    const header = resolveDialogHeader()
    if (!header) return
    header.addEventListener("mousedown", startDrag)
    onCleanup(() => header.removeEventListener("mousedown", startDrag))
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

  const startColumnResize = (divider: "left" | "right", event: MouseEvent) => {
    if (isMobileViewport()) return
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startLayout = clampColumnLayout(columnLayout())
    const total = getDesktopColumnsWidth()
    const startProviderPx = startLayout.providerRatio * total
    const startAccountPx = startLayout.accountRatio * total

    const onMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX
      if (divider === "left") {
        const providerPx = clamp(
          Math.round(startProviderPx + dx),
          MODEL_MANAGER_PROVIDER_MIN_PX,
          total - MODEL_MANAGER_ACCOUNT_MIN_PX - MODEL_MANAGER_MODEL_MIN_PX,
        )
        const accountPx = clamp(
          Math.round(startAccountPx - (providerPx - startProviderPx)),
          MODEL_MANAGER_ACCOUNT_MIN_PX,
          total - providerPx - MODEL_MANAGER_MODEL_MIN_PX,
        )
        setColumnLayout({ providerRatio: providerPx / total, accountRatio: accountPx / total })
        return
      }

      const accountPx = clamp(
        Math.round(startAccountPx + dx),
        MODEL_MANAGER_ACCOUNT_MIN_PX,
        total - Math.round(startProviderPx) - MODEL_MANAGER_MODEL_MIN_PX,
      )
      setColumnLayout({ providerRatio: startProviderPx / total, accountRatio: accountPx / total })
    }

    const onUp = () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
    }

    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
  }

  const toggleProviderFavorite = (providerId: string, currentlyEnabled: boolean) => {
    const providerKey = providerKeyOf(providerId)
    // currentlyEnabled=true → user wants to hide it → hidden=true
    // currentlyEnabled=false → user wants to show it → hidden=false
    models.setProviderHidden(providerKey, currentlyEnabled)
  }

  const accountProviders = createMemo(() => {
    const payload = accountInfo.latest as
      | { providers?: Record<string, unknown>; families?: Record<string, unknown> }
      | undefined
    return (payload?.providers ?? payload?.families ?? {}) as Record<
      string,
      { activeAccount?: string; accounts?: Record<string, Record<string, unknown>> }
    >
  })

  const providerStatus = createMemo(() => {
    const map = new Map<string, string>()
    const providerMap = accountProviders()

    for (const [providerKey, value] of Object.entries(providerMap)) {
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
      map.set(providerKey, reason || language.t("settings.models.recommendations.cooldown", { minutes }))
    }

    return map
  })

  const currentModel = createMemo(() => modelApi.current(params.id))
  const currentSelection = createMemo(() => modelApi.selection(params.id))
  const committedSelection = createMemo(() => {
    const selection = currentSelection()
    if (!selection) return undefined
    return {
      providerID: selection.providerID,
      modelID: selection.modelID,
      accountID: selection.accountID,
    }
  })
  const preferredProviderId = createMemo(() => props.provider || providerKeyOf(currentModel()?.provider.id ?? ""))

  const providers = createMemo(() => {
    const allProviders = globalSync.data.provider.all ?? []
    return buildProviderRows({
      providers: allProviders,
      accountFamilies: accountProviders(),
      hiddenProviders: new Set(models.hiddenProviders()),
    })
  })

  const providersForMode = createMemo(() => {
    if (mode() === "all") return providers()
    return providers().filter((provider) => provider.enabled)
  })

  createEffect(() => {
    setSelectedProviderId(
      pickSelectedProvider({
        selectedProviderId: selectedProviderId(),
        preferredProviderId: preferredProviderId(),
        providers: providersForMode(),
      }),
    )
  })

  createEffect(() => {
    if (!selectedProviderId()) setAccountManagementMode(false)
  })

  const accountProvidersByKey = accountProviders

  const providerKeyForSelection = (providerId: string) => providerKeyOf(providerId) || providerId
  const activeAccountForProvider = (providerId: string) =>
    getActiveAccountForProviderKey(accountProvidersByKey(), providerKeyForSelection(providerId))

  const modelUnavailableReason = (providerId: string, accountId?: string) =>
    getModelUnavailableReason({
      providerId,
      accountId,
      providerStatus: providerStatus(),
      accountFamilies: accountProvidersByKey(),
      formatCooldown: (minutes) => language.t("settings.models.recommendations.cooldown", { minutes }),
    })

  const accountRecordsForSelectedProvider = createMemo(() => {
    const providerId = selectedProviderId()
    if (!providerId) return [] as AccountRecord[]
    const providerKey = providerKeyForSelection(providerId)
    const providerRow = accountProvidersByKey()[providerKey]
    if (!providerRow?.accounts) return [] as AccountRecord[]
    const deletedIds = optimisticDeletedAccountIds()

    return Object.entries(providerRow.accounts)
      .filter(([accountId]) => !deletedIds.has(accountId))
      .map(([accountId, raw]) => normalizeAccountRecord(providerKey, accountId, raw, providerRow.activeAccount))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const accountRecordById = createMemo(
    () => new Map(accountRecordsForSelectedProvider().map((item) => [item.id, item])),
  )

  const accountsForSelectedProvider = createMemo(() => {
    const providerId = selectedProviderId()
    if (!providerId) return [] as Array<{ id: string; label: string; active: boolean; unavailable?: string }>
    return buildAccountRows({
      selectedProviderKey: providerKeyForSelection(providerId),
      accountFamilies: accountProvidersByKey(),
      formatCooldown: (minutes) => language.t("settings.models.recommendations.cooldown", { minutes }),
    })
  })

  // Fetch live rate-limit cooldowns from rotation/status API (same data source as TUI admin panel)
  const [rateLimitCooldowns, setRateLimitCooldowns] = createSignal<Record<string, { waitMs: number; reason: string }>>(
    {},
  )

  createEffect(() => {
    // Re-fetch when provider changes (dependency tracking)
    selectedProviderId()
    let dead = false

    void (async () => {
      try {
        const fetchFn = sdk?.fetch ?? globalSDK.fetch
        const baseUrl = sdk?.url ?? globalSDK.url
        const res = await fetchFn(`${baseUrl}/api/v2/rotation/status`)
        if (dead || !res.ok) return
        const data = (await res.json()) as {
          accounts?: Array<{
            id: string
            isRateLimited: boolean
            rateLimitResetAt?: number
          }>
        }
        if (dead || !data.accounts) return
        const map: Record<string, { waitMs: number; reason: string }> = {}
        const now = Date.now()
        for (const acct of data.accounts) {
          if (acct.isRateLimited && acct.rateLimitResetAt) {
            const waitMs = Math.max(0, acct.rateLimitResetAt - now)
            if (waitMs > 0) {
              map[acct.id] = { waitMs, reason: "rate limited" }
            }
          }
        }
        if (!dead) setRateLimitCooldowns(map)
      } catch {
        // ignore fetch errors
      }
    })()

    onCleanup(() => {
      dead = true
    })
  })

  const [accountQuotaHints, setAccountQuotaHints] = createSignal<Record<string, string>>({})
  let accountQuotaRequestVersion = 0

  createEffect(() => {
    const providerId = selectedProviderId()
    const rows = accountsForSelectedProvider()
    const requestVersion = ++accountQuotaRequestVersion
    const sdkUrl = sdk?.url ?? globalSDK.url
    const sdkFetch = sdk?.fetch ?? globalSDK.fetch

    if (!providerId || rows.length === 0) {
      setAccountQuotaHints({})
      return
    }

    const immediateEntries = rows.map((row) => {
      const cached = peekQuotaHint({
        baseURL: sdkUrl,
        providerId,
        accountId: row.id,
        format: "admin",
      })
      return [row.id, cached.hint ?? ""] as const
    })
    setAccountQuotaHints(Object.fromEntries(immediateEntries))

    const staleRows = rows.filter(
      (row) =>
        peekQuotaHint({
          baseURL: sdkUrl,
          providerId,
          accountId: row.id,
          format: "admin",
        }).stale,
    )
    if (staleRows.length === 0) return

    void (async () => {
      const entries = await Promise.all(
        staleRows.map(async (row) => {
          const hint =
            (await loadQuotaHint((input) => sdkFetch(input), {
              baseURL: sdkUrl,
              providerId,
              accountId: row.id,
              format: "admin",
            })) ?? ""
          return [row.id, hint] as const
        }),
      )
      if (requestVersion !== accountQuotaRequestVersion) return
      setAccountQuotaHints((current) => ({
        ...current,
        ...Object.fromEntries(entries),
      }))
    })()
  })

  const formatWait = (waitMs: number): string => {
    const totalSec = Math.ceil(waitMs / 1000)
    const days = Math.floor(totalSec / (3600 * 24))
    const hours = Math.floor((totalSec % (3600 * 24)) / 3600)
    const minutes = Math.floor((totalSec % 3600) / 60)
    const seconds = totalSec % 60
    const pad = (n: number) => n.toString().padStart(2, "0")
    return `${pad(days)}:${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  }

  const accountRowDisplay = (row: { id: string; label: string }) => {
    const cd = rateLimitCooldowns()[row.id]
    if (cd && cd.waitMs > 0) {
      return {
        label: row.label,
        quota: undefined,
        cooldown: `⏳ ${formatWait(cd.waitMs)}`,
      }
    }
    const quota = accountQuotaHints()[row.id]
    return {
      label: row.label,
      quota,
      cooldown: undefined,
    }
  }

  createEffect(() => {
    setSelectedAccountId(
      pickSelectedAccount({
        selectedAccountId: selectedAccountId(),
        preferredAccountId: currentSelection()?.accountID,
        accounts: accountsForSelectedProvider(),
      }),
    )
  })

  const filteredModels = createMemo(() => {
    return getFilteredModelsForSelection({
      models: modelApi.list(),
      selectedProviderKey: selectedProviderId(),
      currentProviderID: modelApi.current(params.id)?.provider?.id,
      mode: mode(),
      isVisible: (key) => modelApi.visible(key),
    })
  })

  createEffect(() => {
    const selected = pickSelectedModel<ModelListEntry>({
      selected: (() => {
        const key = selectedModelKey()
        if (!key) return undefined
        const [providerID, modelID] = key.split(":")
        if (!providerID || !modelID) return undefined
        return { providerID, modelID }
      })(),
      preferred: committedSelection(),
      models: filteredModels(),
    })
    setSelectedModelKey(selected ? `${selected.provider.id}:${selected.id}` : "")
  })

  const refreshAccountState = async () => {
    const client = sdk?.client ?? globalSDK.client
    await client.global.dispose().catch(() => undefined)
    await refetchAccountInfo()
    setOptimisticDeletedAccountIds(new Set<string>())
  }

  const reopenModelSelector = () => {
    dialog.show(() => (
      <DialogSelectModel
        provider={props.provider}
        initialProviderId={selectedProviderId()}
        initialAccountId={selectedAccountId()}
        initialMode={mode()}
        initialMobileSection={mobileSection()}
        initialAccountManagementMode={accountManagementMode()}
        onModelSelect={props.onModelSelect}
      />
    ))
  }

  const openViewAccount = (accountId: string) => {
    const account = accountRecordById().get(accountId)
    if (!account) return
    dialog.show(() => <AccountViewDialog account={account} />, reopenModelSelector)
  }

  const openRenameAccount = (accountId: string) => {
    const account = accountRecordById().get(accountId)
    if (!account) return
    dialog.show(() => <AccountRenameDialog account={account} onSaved={refreshAccountState} />, reopenModelSelector)
  }

  const openDeleteAccount = (accountId: string) => {
    const account = accountRecordById().get(accountId)
    if (!account) return
    dialog.show(
      () => (
        <AccountDeleteDialog
          account={account}
          onDeleted={refreshAccountState}
          onOptimisticDelete={(id) => setOptimisticDeletedAccountIds((prev) => new Set([...prev, id]))}
        />
      ),
      reopenModelSelector,
    )
  }

  const openAddAccount = () => {
    const providerId = selectedProviderId()
    if (!providerId) return
    dialog.show(() => <DialogConnectProvider provider={providerId} onBack={reopenModelSelector} />, reopenModelSelector)
  }

  const selectedFilteredModel = createMemo(() => {
    const key = selectedModelKey()
    if (!key) return undefined
    return filteredModels().find((item) => `${item.provider.id}:${item.id}` === key)
  })

  const draftSelection = createMemo(() => {
    const model = selectedFilteredModel()
    if (!model) return undefined
    return {
      providerID: model.provider.id,
      modelID: model.id,
      accountID: selectedAccountId() || undefined,
    }
  })

  const hasPendingChanges = createMemo(() => !sameModelSelectorSelection(draftSelection(), committedSelection()))

  const switchDraftAccount = (row: { id: string; label: string; unavailable?: string }) => {
    if (row.unavailable) {
      showToast({
        variant: "error",
        title: language.t("dialog.model.activity.selectBlocked"),
        description: row.unavailable,
      })
      return
    }

    setSelectedAccountId(row.id)
  }

  const submitSelection = async () => {
    const model = selectedFilteredModel()
    if (!model) return
    const sessionID = params.id || undefined
    const accountId = selectedAccountId() || activeAccountForProvider(model.provider.id)
    const unavailable = modelUnavailableReason(model.provider.id, accountId)
    if (unavailable) {
      showToast({
        variant: "error",
        title: language.t("dialog.model.activity.selectBlocked"),
        description: unavailable,
      })
      return
    }

    const providerKey = providerKeyForSelection(model.provider.id)
    const providerCandidates = modelApi
      .list()
      .filter(
        (item: ModelListEntry) => item.id === model.id && providerKeyForSelection(item.provider.id) === providerKey,
      )
    const providerIDForSelection =
      providerCandidates.find((item: ModelListEntry) => providerKeyForSelection(item.provider.id) === providerKey)
        ?.provider.id ??
      providerCandidates.find((item: ModelListEntry) => !isAccountLikeProviderId(item.provider.id))?.provider.id ??
      model.provider.id

    // Standalone mode: call back with selection and close dialog
    if (props.onModelSelect) {
      props.onModelSelect({ modelID: model.id, providerID: providerIDForSelection, accountID: accountId })
      showToast({
        variant: "success",
        title: language.t("dialog.model.submit.toast.title"),
        description: language.t("dialog.model.submit.toast.description", {
          provider: providerKey,
          account: selectedAccountId() || "--",
          model: (model as ModelListEntry).name,
        }),
      })
      dialog.close()
      return
    }

    setSubmitting(true)
    try {
      await local!.model.set(
        { modelID: model.id, providerID: providerIDForSelection, accountID: accountId },
        {
          recent: true,
          interrupt: !!sessionID,
          syncSessionExecution: !!sessionID,
        },
        sessionID,
      )
      showToast({
        variant: "success",
        title: language.t("dialog.model.submit.toast.title"),
        description: language.t("dialog.model.submit.toast.description", {
          provider: providerKey,
          account: selectedAccountId() || "--",
          model: (model as ModelListEntry).name,
        }),
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      class="model-manager-dialog relative w-full h-full min-w-0 md:min-w-[560px] min-h-[320px] flex flex-col p-0 overflow-hidden [&_[data-slot=dialog-header]]:px-3 [&_[data-slot=dialog-header]]:py-2 [&_[data-slot=dialog-header]]:cursor-move [&_[data-slot=dialog-header]]:select-none [&_[data-slot=dialog-title]]:text-14-medium"
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
          <Show when={hasPendingChanges()}>
            <Button
              size="small"
              variant="primary"
              class="h-7 rounded-full px-3"
              onClick={() => void submitSelection()}
              loading={submitting()}
            >
              {language.t("common.submit")}
            </Button>
          </Show>
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

      <div
        ref={columnsEl}
        class="relative grid grid-cols-1 md:grid-cols-3 flex-1 min-h-0 h-full overflow-hidden"
        style={columnTemplate() ? { "grid-template-columns": columnTemplate() } : undefined}
      >
        <div
          class={cn(
            "border-r border-border-base flex-col bg-surface-base min-w-0 min-h-0",
            mobileSection() === "provider" ? "flex" : "hidden",
            "md:flex",
          )}
        >
          <div class="px-3 py-2 text-11-medium text-text-weak uppercase tracking-wider">
            {language.t("common.providers")}
          </div>
          <div ref={providerScrollEl} class="model-manager-column-scroll p-2 space-y-1 overflow-y-auto flex-1 min-h-0">
            <For each={providersForMode()}>
              {(provider) => (
                <ProviderItem
                  id={provider.id}
                  name={provider.accounts > 0 ? `${provider.name} (${provider.accounts})` : provider.name}
                  providerIcon={iconNames.includes(provider.id as IconName) ? provider.id : "synthetic"}
                  selected={selectedProviderId() === provider.id}
                  enabled={provider.enabled}
                  onClick={() => setSelectedProviderId(provider.id)}
                  onToggleEnabled={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    preserveScrollPosition(
                      () => providerScrollEl,
                      () => toggleProviderFavorite(provider.id, provider.enabled),
                    )
                  }}
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
          <div class="px-3 py-2 flex items-center justify-between gap-2">
            <div class="text-11-medium text-text-weak uppercase tracking-wider">
              {language.t("settings.accounts.title")}
            </div>
            <div class="flex items-center gap-1">
              <Button
                size="small"
                variant="ghost"
                class="h-6 rounded-full px-2 text-11-medium border border-border-base"
                disabled={!selectedProviderId()}
                onClick={openAddAccount}
              >
                Add
              </Button>
              <Button
                size="small"
                variant="ghost"
                class="h-6 rounded-full px-2 text-11-medium border border-border-base"
                disabled={!selectedProviderId()}
                onClick={() => setAccountManagementMode((current) => !current)}
              >
                {accountManagementMode() ? "Done" : "Manage"}
              </Button>
            </div>
          </div>
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
                    onClick={() => switchDraftAccount(row)}
                  >
                    <div class="flex items-center gap-2 min-w-0">
                      <div class="flex items-center gap-2 min-w-0 flex-1">
                        <span class="truncate min-w-0 flex-1">{row.label}</span>
                        <span class="w-4 shrink-0 flex items-center justify-center">
                          <Show when={selectedAccountId() === row.id}>
                            <Icon name="check-small" class="text-icon-success-base shrink-0" />
                          </Show>
                        </span>
                        <Show when={!accountManagementMode() && accountRowDisplay(row).cooldown}>
                          {(cd) => (
                            <span class="shrink-0 w-[124px] text-right text-11-regular text-icon-warning-base tabular-nums whitespace-nowrap">
                              {cd()}
                            </span>
                          )}
                        </Show>
                        <Show
                          when={
                            !accountManagementMode() && !accountRowDisplay(row).cooldown && accountRowDisplay(row).quota
                          }
                        >
                          {(quota) => (
                            <span class="shrink-0 w-[124px] text-right text-11-regular text-text-weak tabular-nums whitespace-nowrap">
                              {quota()}
                            </span>
                          )}
                        </Show>
                      </div>
                      <Show when={accountManagementMode()}>
                        <div class="flex items-center gap-1 shrink-0">
                          <AccountActionButton
                            label="View"
                            icon="eye"
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              openViewAccount(row.id)
                            }}
                          />
                          <AccountActionButton
                            label="Edit"
                            icon="edit"
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              openRenameAccount(row.id)
                            }}
                          />
                          <AccountActionButton
                            label="Delete"
                            icon="trash"
                            tone="danger"
                            onClick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              openDeleteAccount(row.id)
                            }}
                          />
                        </div>
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
          <div class="px-3 py-2 text-11-medium text-text-weak uppercase tracking-wider">
            {language.t("dialog.model.select.title")}
          </div>
          <div class="px-3 pb-1 text-11-regular text-text-weak md:hidden">
            <span>{selectedProviderId() || "--"}</span>
            <span class="px-1">/</span>
            <span>{selectedAccountId() || "--"}</span>
          </div>
          <div ref={modelPanelEl} class="flex-1 overflow-hidden relative">
            <List
              class="h-full [&_[data-slot=list-scroll]]:h-full [&_[data-slot=list-scroll]]:p-2"
              items={filteredModels()}
              key={(x: ModelListEntry) => `${x.provider.id}:${x.id}`}
              current={selectedFilteredModel()}
              filterKeys={["provider.name", "name", "id"]}
              sortBy={(a: ModelListEntry, b: ModelListEntry) => {
                return a.name.localeCompare(b.name)
              }}
              itemWrapper={(item: ModelListEntry, node: JSX.Element) => (
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
              onSelect={(x: ModelListEntry | undefined) => {
                if (!x) return
                setSelectedModelKey(`${x.provider.id}:${x.id}`)
              }}
            >
              {(item: ModelListEntry) => (
                <ModelItem
                  item={item}
                  selected={false}
                  enabled={modelApi.visible({ modelID: item.id, providerID: item.provider.id })}
                  unavailableReason={modelUnavailableReason(item.provider.id, selectedAccountId())}
                  showUnavailableTag={mode() !== "all"}
                  onToggleEnabled={(e: MouseEvent) => {
                    e.stopPropagation()
                    e.preventDefault()
                    const key = { modelID: item.id, providerID: item.provider.id }
                    const nextVisible = !modelApi.visible(key)
                    preserveScrollPosition(
                      () => modelPanelEl?.querySelector('[data-slot="list-scroll"]') as HTMLElement | undefined,
                      () => modelApi.setVisibility(key, nextVisible),
                    )
                  }}
                />
              )}
            </List>
          </div>
        </div>

        <Show when={!isMobileViewport()}>
          <button
            type="button"
            class="model-manager-column-divider hidden md:block"
            style={{ left: `${dividerOffsets().left}px` }}
            onDblClick={() => setColumnLayout(MODEL_MANAGER_DEFAULT_COLUMN_LAYOUT)}
            onMouseDown={(event) => startColumnResize("left", event)}
            aria-label="Resize provider and account columns"
          />
          <button
            type="button"
            class="model-manager-column-divider hidden md:block"
            style={{ left: `${dividerOffsets().middle}px` }}
            onDblClick={() => setColumnLayout(MODEL_MANAGER_DEFAULT_COLUMN_LAYOUT)}
            onMouseDown={(event) => startColumnResize("right", event)}
            aria-label="Resize account and model columns"
          />
        </Show>
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
