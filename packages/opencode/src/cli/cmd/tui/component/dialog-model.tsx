import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectRef } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { Account } from "@/account"
import { Keybind } from "@/util/keybind"
import { debugCheckpoint } from "@/util/debug"

export function useConnected() {
  const sync = useSync()
  return createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
}

type SectionOptionValue = { kind: "section"; section: "favorites" | "providers" }
type ProviderOptionValue = { kind: "provider"; providerId: string }
type ModelOptionValue = { kind: "model"; providerId: string; modelID: string; origin?: "favorite" }
type OptionValue = SectionOptionValue | ProviderOptionValue | ModelOptionValue

export function DialogModel(props: { providerId?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [ref, setRef] = createSignal<DialogSelectRef<OptionValue>>()
  const [query, setQuery] = createSignal("")
  const [showHiddenModels, setShowHiddenModels] = createSignal(false)
  const [showHiddenProviders, setShowHiddenProviders] = createSignal(false)
  const [favoritesExpanded, setFavoritesExpanded] = createSignal(false)
  const [providersExpanded, setProvidersExpanded] = createSignal(true)

  // FIX: hierarchical single-page model picker with collapsible sections (@event_20260212_tui_models_hierarchical)
  const [expandedProviders, setExpandedProviders] = createSignal<Set<string>>(
    props.providerId ? new Set([props.providerId]) : new Set(),
  )

  const family = (id: string) => {
    const parsed = Account.parseFamily(id)
    if (parsed) return parsed
    if (id === "opencode" || id.startsWith("opencode-")) return "opencode"
    return undefined
  }

  const providerLabel = (name: string, id: string) => {
    const fam = family(id)
    if (!fam) return name
    const map: Record<string, string> = {
      anthropic: "Anthropic",
      openai: "OpenAI",
      "google-api": "Google-API",
      antigravity: "Antigravity",
      "gemini-cli": "Gemini CLI",
      gitlab: "GitLab",
      opencode: "OpenCode",
    }
    return map[fam] ?? name
  }

  const normalizeProviderForRotation = (providerId: string) => {
    const fam = family(providerId)
    // Fix: if family is an email (e.g. from legacy account ID), map to known provider
    if (fam && fam.includes("@")) {
      if (fam.endsWith("gmail.com")) return "google-api"
      // Default fallback for other emails if needed
    }
    return fam ?? providerId
  }

  const toggleProviderExpanded = (providerId: string) => {
    const next = new Set(expandedProviders())
    if (next.has(providerId)) next.delete(providerId)
    else next.add(providerId)
    setExpandedProviders(next)
  }

  const toggleSectionExpanded = (section: "favorites" | "providers") => {
    if (section === "favorites") setFavoritesExpanded(!favoritesExpanded())
    else setProvidersExpanded(!providersExpanded())
  }

  const probeAndSelectModel = (providerId: string, modelID: string, origin?: string) => {
    const normalizedProviderId = normalizeProviderForRotation(providerId)
    debugCheckpoint("model", "selected (probe skipped)", {
      provider: providerId,
      providerNormalized: normalizedProviderId,
      model: modelID,
      origin,
    })
    local.model.set(
      { providerId: normalizedProviderId, modelID },
      { recent: true, skipValidation: true, announce: true },
    )
    dialog.clear()
  }

  const connected = useConnected()

  const groupedProviders = createMemo(() => {
    const map = new Map<string, typeof sync.data.provider>()
    for (const p of sync.data.provider) {
      const fam = family(p.id) ?? p.id
      const list = map.get(fam)
      if (list) list.push(p)
      else map.set(fam, [p])
    }
    return map
  })

  const options = createMemo(() => {
    const favoritesRaw = connected() ? local.model.favorite() : []
    const hidden = local.model.hidden()
    const hiddenProviders = new Set(local.model.hiddenProviders())
    const providerGroups = groupedProviders()

    const isHiddenInFamily = (fam: string, modelID: string) => {
      const members = providerGroups.get(fam) ?? []
      return hidden.some((h) => {
        if (h.modelID !== modelID) return false
        if (h.providerId === fam) return true
        return members.some((m) => m.id === h.providerId)
      })
    }

    const dedupFavorites = new Map<string, { providerId: string; modelID: string }>()
    for (const item of favoritesRaw) {
      const fam = normalizeProviderForRotation(item.providerId)
      dedupFavorites.set(`${fam}:${item.modelID}`, { providerId: fam, modelID: item.modelID })
    }

    const favorites = [...dedupFavorites.values()]
      .map((item) => {
        const members = providerGroups.get(item.providerId) ?? []
        const found = members
          .map((p) => ({ provider: p, model: p.models[item.modelID] }))
          .find(({ model }) => !!model && model.status !== "deprecated")
        if (!found) return undefined
        if (!showHiddenProviders() && hiddenProviders.has(item.providerId)) return undefined
        if (!showHiddenModels() && isHiddenInFamily(item.providerId, item.modelID)) return undefined
        return {
          providerId: item.providerId,
          modelID: item.modelID,
          providerName: providerLabel(item.providerId, item.providerId),
          modelName: found.model.name ?? item.modelID,
          disabled: item.providerId === "opencode" && item.modelID.includes("-nano"),
        }
      })
      .filter(Boolean) as Array<{
      providerId: string
      modelID: string
      providerName: string
      modelName: string
      disabled: boolean
    }>

    favorites.sort((a, b) => {
      const providerCmp = a.providerName.localeCompare(b.providerName)
      if (providerCmp !== 0) return providerCmp
      return a.modelName.localeCompare(b.modelName)
    })

    const list: Array<any> = []

    if (favorites.length > 0) {
      list.push({
        value: { kind: "section", section: "favorites" } as SectionOptionValue,
        title: `${favoritesExpanded() ? "▼" : "▶"} Favorites`,
        onSelect: () => toggleSectionExpanded("favorites"),
      })

      if (favoritesExpanded()) {
        const providerWidth = Math.max(0, ...favorites.map((x) => x.providerName.length))
        for (const row of favorites) {
          list.push({
            value: {
              kind: "model",
              providerId: row.providerId,
              modelID: row.modelID,
              origin: "favorite",
            } as ModelOptionValue,
            title: `  ${row.providerName.padEnd(providerWidth, " ")}`,
            description: row.modelName,
            disabled: row.disabled,
            onSelect: () => probeAndSelectModel(row.providerId, row.modelID, "favorite"),
          })
        }
      }
    }

    list.push({
      value: { kind: "section", section: "providers" } as SectionOptionValue,
      title: `${providersExpanded() ? "▼" : "▶"} Providers`,
      onSelect: () => toggleSectionExpanded("providers"),
    })

    if (!providersExpanded()) return list

    const families = [...providerGroups.entries()]
      .filter(([_, members]) => members.some((p) => Object.keys(p.models).length > 0))
      .sort(([a], [b]) => {
        if (a === "antigravity") return -1
        if (b === "antigravity") return 1
        return providerLabel(a, a).localeCompare(providerLabel(b, b))
      })

    for (const [fam, members] of families) {
      if (!showHiddenProviders() && hiddenProviders.has(fam)) continue
      const expanded = expandedProviders().has(fam)
      const providerHidden = hiddenProviders.has(fam)

      const modelMap = new Map<string, { name: string; blocked?: string; cooldownUntil?: number }>()
      for (const p of members) {
        const pMeta = p as typeof p & { coolingDownUntil?: number; cooldownReason?: string }
        for (const [mid, info] of Object.entries(p.models)) {
          if (info.status === "deprecated") continue
          if (!modelMap.has(mid)) {
            modelMap.set(mid, {
              name: info.name ?? mid,
              blocked: pMeta.cooldownReason,
              cooldownUntil: pMeta.coolingDownUntil,
            })
          }
        }
      }

      const modelCount = modelMap.size
      if (modelCount === 0) continue

      list.push({
        value: { kind: "provider", providerId: fam } as ProviderOptionValue,
        title: `  ${expanded ? "▼" : "▶"} ${providerLabel(fam, fam)}`,
        description: providerHidden ? `${modelCount} models · hidden` : `${modelCount} models`,
        onSelect: () => toggleProviderExpanded(fam),
      })

      if (!expanded) continue

      const models = [...modelMap.entries()]
        .filter(([mid]) => (showHiddenModels() ? true : !isHiddenInFamily(fam, mid)))
        .sort((a, b) => a[1].name.localeCompare(b[1].name))

      for (const [index, [mid, meta]] of models.entries()) {
        const favorite = favorites.some((f) => f.providerId === fam && f.modelID === mid)
        const branch = index === models.length - 1 ? "└─" : "├─"
        const modelIndent = favorite ? "     " : "      "
        list.push({
          value: { kind: "model", providerId: fam, modelID: mid } as ModelOptionValue,
          title: `${modelIndent}${branch} ${meta.name} ${favorite ? "★" : ""}`,
          gutter: undefined,
          description:
            meta.cooldownUntil && meta.cooldownUntil > Date.now()
              ? `⏳ Rate limited (${Math.ceil((meta.cooldownUntil - Date.now()) / 1000 / 60)}m)`
              : meta.blocked
                ? `⛔ ${meta.blocked}`
                : undefined,
          disabled: (fam === "opencode" && mid.includes("-nano")) || (meta.blocked?.includes("blocked") ?? false),
          onSelect: () => probeAndSelectModel(fam, mid),
        })
      }
    }

    return list
  })

  const currentOption = createMemo(() => {
    const current = local.model.current()
    if (!current) return undefined

    const fam = normalizeProviderForRotation(current.providerId)
    const members = groupedProviders().get(fam) ?? []
    const exists = members.some((p) => !!p.models[current.modelID])
    if (exists) {
      return { kind: "model", providerId: fam, modelID: current.modelID } as ModelOptionValue
    }

    return { kind: "model", providerId: current.providerId, modelID: current.modelID } as ModelOptionValue
  })

  const goBack = () => {
    if (query() !== "") {
      setQuery("")
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect
      keybind={[
        {
          keybind: Keybind.parse("f")[0],
          title: "Favorite",
          label: "F/f",
          disabled: !connected(),
          onTrigger: (option: any) => {
            const val = option?.value as OptionValue | undefined
            if (!val || val.kind !== "model") return
            local.model.toggleFavorite({ providerId: val.providerId, modelID: val.modelID }, { skipValidation: true })
            // Auto-unhide when adding to favorites
            const isHidden = local.model
              .hidden()
              .some((h) => h.providerId === val.providerId && h.modelID === val.modelID)
            if (isHidden) {
              local.model.toggleHidden({ providerId: val.providerId, modelID: val.modelID })
            }
          },
        },
        {
          keybind: Keybind.parse("delete")[0],
          title: "Hide",
          label: "del",
          disabled: !connected(),
          onTrigger: (option: any) => {
            const val = option?.value as OptionValue | undefined
            if (!val) return
            if (val.kind === "provider") {
              local.model.toggleHiddenProvider(val.providerId)
              return
            }
            if (val.kind !== "model") return
            if (val.origin === "favorite") {
              local.model.toggleFavorite({ providerId: val.providerId, modelID: val.modelID }, { skipValidation: true })
              // Auto-hide when removing from favorites
              const isHidden = local.model
                .hidden()
                .some((h) => h.providerId === val.providerId && h.modelID === val.modelID)
              if (!isHidden) {
                local.model.toggleHidden({ providerId: val.providerId, modelID: val.modelID })
              }
              return
            }
            local.model.toggleHidden({ providerId: val.providerId, modelID: val.modelID })
          },
        },
        {
          keybind: Keybind.parse("s")[0],
          title: "Showall",
          label: "S/s",
          disabled: !connected(),
          onTrigger: (option: any) => {
            const val = option?.value as OptionValue | undefined
            if (val?.kind === "section") {
              setShowHiddenProviders(!showHiddenProviders())
              return
            }
            setShowHiddenModels(!showHiddenModels())
          },
        },
        {
          keybind: Keybind.parse("insert")[0],
          title: "Unhide",
          label: "Ins",
          disabled: !connected() || (!showHiddenModels() && !showHiddenProviders()),
          onTrigger: (option: any) => {
            const val = option?.value as OptionValue | undefined
            if (!val) return
            if (val.kind === "provider") {
              if (!showHiddenProviders()) return
              if (local.model.isProviderHidden(val.providerId)) {
                local.model.toggleHiddenProvider(val.providerId)
              }
              return
            }
            if (val.kind !== "model") return
            if (!showHiddenModels()) return
            const isHidden = local.model
              .hidden()
              .some((h) => h.providerId === val.providerId && h.modelID === val.modelID)
            if (isHidden) {
              local.model.toggleHidden({ providerId: val.providerId, modelID: val.modelID })
            }
          },
        },
        {
          keybind: Keybind.parse("left")[0],
          title: "Back",
          label: "left/esc",
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
      onFilter={setQuery}
      title="Select Models"
      current={currentOption()}
      options={options()}
      keybindLayout="inline"
    />
  )
}
