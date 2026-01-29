import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect, type DialogSelectRef } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { useKeybind } from "../context/keybind"
import { useTheme } from "@tui/context/theme"
import { iife } from "@/util/iife"
import * as fuzzysort from "fuzzysort"

export function useConnected() {
  const sync = useSync()
  return createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
}

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const keybind = useKeybind()
  const { theme } = useTheme()
  const [ref, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [query, setQuery] = createSignal("")

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const showExtra = createMemo(() => {
    if (!connected()) return false
    if (props.providerID) return false
    return true
  })

  const options = createMemo(() => {
    const q = query()
    const needle = q.trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    const recentList = showSections
      ? recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      )
      : []

    const favoriteOptions = showSections
      ? favorites.flatMap((item) => {
        const provider = sync.data.provider.find((x) => x.id === item.providerID) as any
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        return [
          {
            key: item,
            value: {
              providerID: provider.id,
              modelID: model.id,
            },
            title: model.name ?? item.modelID,
            description: provider.name,
            category: "Favorites",
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: model.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect: () => {
              dialog.clear()
              local.model.set(
                {
                  providerID: provider.id,
                  modelID: model.id,
                },
                { recent: true },
              )
            },
          },
        ]
      })
      : []

    // Sort favorites by model name
    const sortedFavoriteOptions = pipe(
      favoriteOptions,
      sortBy((x) => x.title)
    )

    const recentOptions = showSections
      ? recentList.flatMap((item) => {
        const provider = sync.data.provider.find((x) => x.id === item.providerID) as any
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        return [
          {
            key: item,
            value: {
              providerID: provider.id,
              modelID: model.id,
            },
            title: model.name ?? item.modelID,
            description: provider.name,
            category: "Recent",
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: model.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect: () => {
              dialog.clear()
              local.model.set(
                {
                  providerID: provider.id,
                  modelID: model.id,
                },
                { recent: true },
              )
            },
          },
        ]
      })
      : []

    const providerOptions = pipe(
      sync.data.provider,
      filter((provider: any) => provider.active !== false),
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider: any) => !provider.active, // Active accounts first
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => {
            const value = {
              providerID: provider.id,
              modelID: model,
            }
            const p = provider as any
            return {
              value,
              title: info.name ?? model,
              category: connected() ? provider.name : undefined,
              disabled: provider.id === "opencode" && model.includes("-nano"),
              footer: iife(() => {
                if (info.cost?.input === 0 && provider.id === "opencode") return "Free"
                if (p.active) return "Active"
                return undefined
              }),
              gutter: p.active ? (
                <text fg={theme.success}>●</text>
              ) : undefined,
              description: iife(() => {
                const statusDetails = []
                if (p.coolingDownUntil && p.coolingDownUntil > Date.now()) {
                  const remaining = Math.ceil((p.coolingDownUntil - Date.now()) / 1000 / 60)
                  statusDetails.push(`⏳ Rate limited (${remaining}m)`)
                }
                if (p.cooldownReason?.includes("quota")) {
                  statusDetails.push("💰 Quota exceeded")
                }
                const favoriteText = favorites.some(
                  (item) => item.providerID === value.providerID && item.modelID === value.modelID,
                )
                  ? "(Favorite)"
                  : ""

                return [favoriteText, ...statusDetails].filter(Boolean).join(" ") || undefined
              }),
              onSelect() {
                dialog.clear()
                local.model.set(
                  {
                    providerID: provider.id,
                    modelID: model,
                  },
                  { recent: true },
                )
              },
            }
          }),
          filter((x) => {
            if (!showSections) return true
            const value = x.value
            const inFavorites = favorites.some(
              (item) => item.providerID === value.providerID && item.modelID === value.modelID,
            )
            if (inFavorites) return false
            const inRecents = recents.some(
              (item) => item.providerID === value.providerID && item.modelID === value.modelID,
            )
            if (inRecents) return false
            return true
          }),
          sortBy(
            (x) => x.footer !== "Free",
            (x) => x.title,
          ),
        ),
      ),
    )

    const popularProviders = !connected()
      ? pipe(
        providers(),
        map((option) => {
          return {
            ...option,
            category: "Popular providers",
          }
        }),
        take(6),
      )
      : []

    // Search shows a single merged list (favorites inline)
    if (needle) {
      const filteredProviders = fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj)
      const filteredPopular = fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj)
      return [...filteredProviders, ...filteredPopular]
    }

    return [...sortedFavoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((x) => x.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    if (provider()) return provider()!.name
    return "Select model"
  })

  return (
    <DialogSelect
      keybind={[
        {
          keybind: keybind.all.model_provider_list,
          title: connected() ? "Connect provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          keybind: keybind.all.model_favorite_toggle,
          title: "Favorite",
          disabled: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      ref={setRef}
      onFilter={setQuery}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
      options={options()}
    />
  )
}
