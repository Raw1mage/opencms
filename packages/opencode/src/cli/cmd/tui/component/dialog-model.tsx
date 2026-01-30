import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect, type DialogSelectRef } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogAccount } from "./dialog-account"
import { useKeybind } from "../context/keybind"
import { useTheme } from "@tui/context/theme"
import { iife } from "@/util/iife"
import * as fuzzysort from "fuzzysort"
import { Account } from "@/account"
import { Keybind } from "@/util/keybind"
import { isDeepEqual } from "remeda"

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
  const [showHidden, setShowHidden] = createSignal(false)

  const connected = useConnected()
  const providers = createDialogProviderOptions()
  const family = (id: string) => {
    const parsed = Account.parseFamily(id)
    if (parsed) return parsed
    if (id === "opencode" || id.startsWith("opencode-")) return "opencode"
    return undefined
  }

  const label = (name: string, id: string) => {
    const fam = family(id)
    if (!fam) return name
    const map: Record<string, string> = {
      anthropic: "Anthropic",
      openai: "OpenAI",
      google: "Google",
      antigravity: "Antigravity",
      "gemini-cli": "Gemini CLI",
      gitlab: "GitLab",
      opencode: "OpenCode",
    }
    return map[fam as string] ?? name
  }

  const owner = (provider: { id: string; name: string; email?: string }) => {
    const fam = family(provider.id)
    if (!fam) return undefined
    const info = {
      type: "subscription",
      name: provider.name,
      email: provider.email,
      refreshToken: "",
      accessToken: "",
      expiresAt: 0,
      addedAt: 0,
    }
    const display = Account.getDisplayName(provider.id, info as any, fam as string)
    return display || undefined
  }

  const activeOwners = createMemo(() => {
    const map = new Map<string, string>()
    for (const provider of sync.data.provider as any[]) {
      if (!provider.active) continue
      const fam = family(provider.id)
      if (!fam) continue
      const who = owner(provider)
      if (!who) continue

      const existing = map.get(fam)
      if (existing && existing.includes("@") && !who.includes("@")) {
        continue
      }
      map.set(fam, who)
    }
    return map
  })

  const activeFamilies = createMemo(() => new Set(activeOwners().keys()))

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
        const fam = family(provider.id)
        if (fam && activeFamilies().has(fam) && !provider.active) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        const who = iife(() => {
          if (!fam) return owner(provider)
          return activeOwners().get(fam) ?? owner(provider)
        })
        const group = label(provider.name, provider.id)
        return [
          {
            key: item,
            value: {
              providerID: provider.id,
              modelID: model.id,
              origin: "favorite",
            },
            title: model.name ?? item.modelID,
            description: [group, who].filter(Boolean).join(" · "),
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
              origin: "recent",
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
      filter((provider: any) => {
        if (provider.active === false) return false
        const fam = family(provider.id)
        if (!fam) return true
        const active = activeFamilies().has(fam)
        if (!active) return true
        // if (provider.id === fam) return false // Fix: Don't hide family-named providers (fixes Anthropic)
        return provider.active === true
      }),
      sortBy(
        (provider) => provider.id === "opencode",
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
              category: connected()
                ? iife(() => {
                  const base = label(provider.name, provider.id)
                  const who = owner(provider)
                  if (who) return `${base} (${who})`
                  return base
                })
                : undefined,
              disabled:
                (provider.id === "opencode" && model.includes("-nano")) ||
                (p.cooldownReason?.includes("blocked") ?? false),
              footer: iife(() => {
                if (info.cost?.input === 0 && provider.id === "opencode") return "Free"
                if (p.active) return "Active"
                return undefined
              }),
              gutter: p.active ? (
                <text fg={theme.success as any}>●</text>
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
                if (p.cooldownReason && !p.cooldownReason.includes("quota")) {
                  statusDetails.push(`⛔ ${p.cooldownReason}`)
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
            // Filter hidden items unless showing all
            if (showSections && !showHidden()) {
              const value = x.value
              const isHidden = local.model.hidden().some(
                (h) => h.providerID === value.providerID && h.modelID === value.modelID
              )
              if (isHidden) return false
            }
            if (!showSections) return true

            // Original logic for providerOptions:
            // filter((provider: any) => {
            //   if (provider.active === false) return false
            //   const fam = family(provider.id)
            //   if (!fam) return true
            //   const active = activeFamilies().has(fam)
            //   if (!active) return true
            //   // Removed: if (provider.id === fam) return false
            //   return provider.active === true
            // })
            // This filter block is applied to the flattened options
            // But the logic above (if (!showSections) return true) handles typical cases.
            // The `providerOptions` construction loop had the filter.
            // Wait, I am editing the `options` memo's filter function at the end?
            // NO, I am editing the `filter` pipe call in `providerOptions` definition?
            // The lines match `filter((x) => {` which is the LAST filter in `options` memo (combining all lists).
            // That filter was managing hidden state.
            // The user wants Anthropic visible.
            // That logic was in `providerOptions` definition earlier in the file.
            // I need to target THAT block.
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
          keybind: Keybind.parse("f")[0],
          title: "Favorite",
          disabled: !connected(),
          onTrigger: (option: any) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
        {
          keybind: Keybind.parse("delete")[0],
          title: "Delete/Hide",
          disabled: !connected(),
          onTrigger: (option: any) => {
            const val = option.value as { providerID: string; modelID: string; origin?: string }
            if (val.origin === "recent") {
              local.model.removeFromRecent(val)
            } else if (val.origin === "favorite") {
              local.model.toggleFavorite(val)
            } else {
              local.model.toggleHidden(val)
            }
          },
        },
        // Add backspace as alias for delete
        {
          keybind: Keybind.parse("backspace")[0],
          title: "Delete (Backspace)",
          disabled: !connected(),
          onTrigger: (option: any) => {
            const val = option.value as { providerID: string; modelID: string; origin?: string }
            if (val.origin === "recent") {
              local.model.removeFromRecent(val)
            } else if (val.origin === "favorite") {
              local.model.toggleFavorite(val)
            } else {
              local.model.toggleHidden(val)
            }
          },
        },
        {
          keybind: Keybind.parse("s")[0],
          title: showHidden() ? "Hide hidden" : "Show all",
          disabled: !connected(),
          onTrigger: () => {
            setShowHidden(!showHidden())
          },
        },
        {
          keybind: Keybind.parse("insert")[0],
          title: "Unhide",
          disabled: !connected() || !showHidden(),
          onTrigger: (option: any) => {
            const val = option.value as { providerID: string; modelID: string }
            const isHidden = local.model.hidden().some(
              (h) => h.providerID === val.providerID && h.modelID === val.modelID
            )
            if (isHidden) {
              local.model.toggleHidden(val)
            }
          },
        },
        {
          keybind: Keybind.parse("left")[0],
          title: "Back",
          onTrigger: () => {
            dialog.clear()
          },
        },
        {
          keybind: Keybind.parse("a")[0],
          title: "Accounts",
          onTrigger: () => {
            dialog.replace(() => <DialogAccount />)
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
