import { Component, Show } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tag } from "@opencode-ai/ui/tag"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { iconNames, type IconName } from "@opencode-ai/ui/icons/provider"
import { DialogConnectProvider } from "./dialog-connect-provider"
import { useLanguage } from "@/context/language"
import { useGlobalSync } from "@/context/global-sync"
import { DialogCustomProvider } from "./dialog-custom-provider"
import { isSupportedProviderKey } from "@/utils/provider-registry"

const CUSTOM_ID = "_custom"

function icon(id: string): IconName {
  if (iconNames.includes(id as IconName)) return id as IconName
  return "synthetic"
}

export const DialogSelectProvider: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const providers = useProviders()

  const popularGroup = () => language.t("dialog.provider.group.popular")
  const otherGroup = () => language.t("dialog.provider.group.other")
  const customLabel = () => language.t("settings.providers.tag.custom")
  const note = (id: string) => {
    if (id === "claude-cli") return language.t("dialog.provider.anthropic.note")
    if (id === "openai") return language.t("dialog.provider.openai.note")
    if (id.startsWith("github-copilot")) return language.t("dialog.provider.copilot.note")
  }

  const customProviders = () => {
    const config = globalSync.data.config as { provider?: Record<string, unknown> } | undefined
    const providerConfig = config?.provider ?? {}
    return Object.entries(providerConfig)
      .filter(([id, raw]) => {
        if (isSupportedProviderKey(id)) return false
        if (!raw || typeof raw !== "object") return false
        const row = raw as { npm?: unknown; models?: unknown }
        if (row.npm !== "@ai-sdk/openai-compatible") return false
        if (!row.models || typeof row.models !== "object") return false
        return Object.keys(row.models as Record<string, unknown>).length > 0
      })
      .map(([id, raw]) => {
        const row = raw as { name?: unknown }
        return {
          id,
          name: typeof row.name === "string" && row.name.trim() ? row.name : id,
        }
      })
  }

  const providerItems = () => {
    language.locale()
    const merged = new Map<string, { id: string; name: string }>()
    merged.set(CUSTOM_ID, { id: CUSTOM_ID, name: customLabel() })
    for (const item of providers.all()) {
      merged.set(item.id, { id: item.id, name: item.name })
    }
    for (const item of customProviders()) {
      if (!merged.has(item.id)) merged.set(item.id, item)
    }
    return Array.from(merged.values())
  }

  return (
    <Dialog title={language.t("command.provider.connect")} transition>
      <List
        search={{ placeholder: language.t("dialog.provider.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.provider.empty")}
        activeIcon="plus-small"
        key={(x) => x?.id}
        items={providerItems}
        filterKeys={["id", "name"]}
        groupBy={(x) => (popularProviders.includes(x.id) ? popularGroup() : otherGroup())}
        sortBy={(a, b) => {
          if (a.id === CUSTOM_ID) return -1
          if (b.id === CUSTOM_ID) return 1
          if (popularProviders.includes(a.id) && popularProviders.includes(b.id))
            return popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id)
          return a.name.localeCompare(b.name)
        }}
        sortGroupsBy={(a, b) => {
          const popular = popularGroup()
          if (a.category === popular && b.category !== popular) return -1
          if (b.category === popular && a.category !== popular) return 1
          return 0
        }}
        onSelect={(x) => {
          if (!x) return
          if (x.id === CUSTOM_ID) {
            dialog.show(() => <DialogCustomProvider back="providers" />)
            return
          }
          if (!isSupportedProviderKey(x.id)) {
            dialog.show(() => <DialogCustomProvider back="providers" editProviderId={x.id} />)
            return
          }
          dialog.show(() => <DialogConnectProvider provider={x.id} />)
        }}
      >
        {(i) => {
          const providerRow = globalSync.data.account_families[i.id]
          const count = providerRow ? Object.keys(providerRow.accounts).length : 0
          return (
            <div class="px-1.25 w-full flex items-center gap-x-3">
              <ProviderIcon data-slot="list-item-extra-icon" id={icon(i.id)} />
              <span class="truncate text-left" style={{ "min-width": "160px" }}>
                {i.name}
                <Show when={count > 0}>
                  <span class="ml-1 opacity-50 text-12-regular">({count})</span>
                </Show>
              </span>
              <span class="flex items-center gap-2 ml-auto shrink-0">
                <Show when={i.id === CUSTOM_ID || (!isSupportedProviderKey(i.id) && i.id !== CUSTOM_ID)}>
                  <Tag>{language.t("settings.providers.tag.custom")}</Tag>
                </Show>
                <Show when={i.id === "opencode"}>
                  <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
                </Show>
                <Show when={note(i.id)}>
                  {(value) => <span class="text-12-regular text-text-weak whitespace-nowrap">{value()}</span>}
                </Show>
              </span>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
