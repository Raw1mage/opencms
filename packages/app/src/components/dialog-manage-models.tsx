import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import type { Component } from "solid-js"
import { useLocal } from "@/context/local"
import { popularProviders } from "@/hooks/use-providers"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useGlobalSync } from "@/context/global-sync"
import { DialogSelectProvider } from "./dialog-select-provider"

function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(" ")
}

export const DialogManageModels: Component = () => {
  const local = useLocal()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const dialog = useDialog()
  const billingModeOptions: Array<{ value: "token" | "request" | "unknown"; label: string }> = [
    { value: "token", label: "Token" },
    { value: "request", label: "Request" },
    { value: "unknown", label: "Unknown" },
  ]

  const handleConnectProvider = () => {
    dialog.show(() => <DialogSelectProvider />)
  }
  const providerRank = (id: string) => popularProviders.indexOf(id)
  const providerList = (providerID: string) => local.model.list().filter((x) => x.provider.id === providerID)
  const providerVisible = (providerID: string) =>
    providerList(providerID).every((x) => local.model.visible({ modelID: x.id, providerID: x.provider.id }))
  const setProviderVisibility = (providerID: string, checked: boolean) => {
    providerList(providerID).forEach((x) => {
      local.model.setVisibility({ modelID: x.id, providerID: x.provider.id }, checked)
    })
  }
  const providerBillingMode = (providerID: string) => {
    const provider = providerList(providerID)[0]?.provider
    return (
      provider?.billingMode ??
      globalSync.data.config.provider?.[providerID]?.billingMode ??
      billingModeOptions.find((option) => option.value === "unknown")?.value
    )
  }
  const setProviderBillingMode = async (providerID: string, billingMode: "token" | "request" | "unknown") => {
    const current = globalSync.data.config.provider?.[providerID]
    await globalSync.updateConfig({
      provider: {
        [providerID]: {
          ...(current ?? {}),
          billingMode,
        },
      },
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.manage")}
      description={language.t("dialog.model.manage.description")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={handleConnectProvider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <List
        emptyMessage={language.t("dialog.model.empty")}
        key={(x) => `${x?.provider?.id}:${x?.id}`}
        items={local.model.list()}
        filterKeys={["provider.name", "name", "id"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        groupBy={(x) => x.provider.id}
        groupHeader={(group) => {
          const provider = group.items[0].provider
          return (
            <div class="w-full flex items-center justify-between gap-2">
              <span>{provider.name}</span>
              <div class="flex items-center gap-2">
                <Select
                  options={billingModeOptions}
                  current={billingModeOptions.find((option) => option.value === providerBillingMode(provider.id))}
                  value={(option) => option.value}
                  label={(option) => option.label}
                  onSelect={(option) => option && setProviderBillingMode(provider.id, option.value)}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                />
                <Tooltip
                  placement="top"
                  value={language.t("dialog.model.manage.provider.toggle", { provider: provider.name })}
                >
                  <IconButton
                    icon="eye"
                    variant="ghost"
                    class={cn(
                      "size-6 -mr-1 transition-opacity hover:text-icon-base",
                      providerVisible(provider.id) ? "text-icon-weak-base" : "text-icon-warning-base opacity-100",
                    )}
                    onClick={() => setProviderVisibility(provider.id, !providerVisible(provider.id))}
                  />
                </Tooltip>
              </div>
            </div>
          )
        }}
        sortGroupsBy={(a, b) => {
          const aRank = providerRank(a.items[0].provider.id)
          const bRank = providerRank(b.items[0].provider.id)
          const aPopular = aRank >= 0
          const bPopular = bRank >= 0
          if (aPopular && !bPopular) return -1
          if (!aPopular && bPopular) return 1
          return aRank - bRank
        }}
        onSelect={(x) => {
          if (!x) return
          const key = { modelID: x.id, providerID: x.provider.id }
          local.model.setVisibility(key, !local.model.visible(key))
        }}
      >
        {(i) => (
          <div class="w-full flex items-center justify-between gap-x-3">
            <span>{i.name}</span>
            <IconButton
              icon="eye"
              variant="ghost"
              class={cn(
                "size-6 transition-opacity hover:text-icon-base",
                local.model.visible({ modelID: i.id, providerID: i.provider.id })
                  ? "text-icon-weak-base"
                  : "text-icon-warning-base opacity-100",
              )}
              onClick={() => {
                const key = { modelID: i.id, providerID: i.provider.id }
                local.model.setVisibility(key, !local.model.visible(key))
              }}
            />
          </div>
        )}
      </List>
    </Dialog>
  )
}
