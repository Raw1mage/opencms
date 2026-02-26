import { useFilteredList } from "@opencode-ai/ui/hooks"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import type { IconName } from "@opencode-ai/ui/icons/provider"
import { createMemo, createResource, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { popularProviders } from "@/hooks/use-providers"
import { useGlobalSDK } from "@/context/global-sdk"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

const ListLoadingState: Component<{ label: string }> = (props) => {
  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <span class="text-14-regular text-text-weak">{props.label}</span>
    </div>
  )
}

const ListEmptyState: Component<{ message: string; filter: string }> = (props) => {
  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <span class="text-14-regular text-text-weak">{props.message}</span>
      <Show when={props.filter}>
        <span class="text-14-regular text-text-strong mt-1">&quot;{props.filter}&quot;</span>
      </Show>
    </div>
  )
}

export const SettingsModels: Component = () => {
  const language = useLanguage()
  const models = useModels()
  const globalSDK = useGlobalSDK()

  const [rotation, rotationActions] = createResource(async () => {
    return globalSDK.client.rotation.status().then((x) => x.data)
  })

  const recommendations = createMemo(() => {
    const info = rotation.latest?.recommended
    if (!info || typeof info !== "object") return [] as Array<{ task: string; value: string }>
    const entries: Array<{ task: string; value: string }> = []
    for (const [task, vectorValue] of Object.entries(info as Record<string, unknown>)) {
      const vector = vectorValue as Record<string, unknown>
      if (!vector) continue
      if (
        typeof vector.providerId !== "string" ||
        typeof vector.accountId !== "string" ||
        typeof vector.modelID !== "string"
      ) {
        continue
      }
      entries.push({
        task,
        value: `${vector.providerId}/${vector.accountId}/${vector.modelID}`,
      })
    }
    return entries
  })

  const list = useFilteredList<ModelItem>({
    items: (_filter) => models.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0

      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      if (aPopular && bPopular) return aIndex - bIndex

      const aName = a.items[0].provider.name
      const bName = b.items[0].provider.name
      return aName.localeCompare(bName)
    },
  })

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.models.title")}</h2>
          <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
            <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={list.filter()}
              onChange={list.onInput}
              placeholder={language.t("dialog.model.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="flex-1"
            />
            <Show when={list.filter()}>
              <IconButton icon="circle-x" variant="ghost" onClick={list.clear} />
            </Show>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-14-medium text-text-strong">{language.t("settings.models.recommendations.title")}</h3>
            <Button
              size="small"
              variant="secondary"
              onClick={() => rotationActions.refetch()}
              disabled={rotation.loading}
            >
              {language.t("common.refresh")}
            </Button>
          </div>
          <div class="bg-surface-raised-base px-4 rounded-lg">
            <Show
              when={recommendations().length > 0}
              fallback={
                <div class="py-4 text-14-regular text-text-weak">
                  {language.t("settings.models.recommendations.empty")}
                </div>
              }
            >
              <For each={recommendations()}>
                {(entry) => (
                  <div class="flex flex-wrap items-center justify-between gap-2 py-3 border-b border-border-weak-base last:border-none">
                    <span class="text-12-regular text-text-weak uppercase">{entry.task}</span>
                    <code class="text-12-regular text-text-base truncate">{entry.value}</code>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>

        <Show
          when={!list.grouped.loading}
          fallback={
            <ListLoadingState label={`${language.t("common.loading")}${language.t("common.loading.ellipsis")}`} />
          }
        >
          <Show
            when={list.flat().length > 0}
            fallback={<ListEmptyState message={language.t("dialog.model.empty")} filter={list.filter()} />}
          >
            <For each={list.grouped.latest}>
              {(group) => (
                <div class="flex flex-col gap-1">
                  <div class="flex items-center gap-2 pb-2">
                    <ProviderIcon id={group.category as IconName} class="size-5 shrink-0 icon-strong-base" />
                    <span class="text-14-medium text-text-strong">{group.items[0].provider.name}</span>
                  </div>
                  <div class="bg-surface-raised-base px-4 rounded-lg">
                    <For each={group.items}>
                      {(item) => {
                        const key = { providerID: item.provider.id, modelID: item.id }
                        return (
                          <div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
                            <div class="min-w-0">
                              <span class="text-14-regular text-text-strong truncate block">{item.name}</span>
                            </div>
                            <div class="flex-shrink-0">
                              <Switch
                                checked={models.visible(key)}
                                onChange={(checked) => {
                                  models.setVisibility(key, checked)
                                }}
                                hideLabel
                              >
                                {item.name}
                              </Switch>
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}
