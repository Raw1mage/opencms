import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectRef } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { useRoute } from "@tui/context/route"
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
  const route = useRoute()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
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

  const providerKey = (id: string) => {
    const parsed = Account.parseProvider(id)
    if (parsed) return parsed
    if (id === "opencode" || id.startsWith("opencode-")) return "opencode"
    return undefined
  }

  const providerLabel = (name: string, id: string) => {
    const normalizedProviderKey = providerKey(id)
    if (!normalizedProviderKey) return name
    const map: Record<string, string> = {
      "claude-cli": "Claude CLI",
      openai: "OpenAI",
      "google-api": "Google-API",
      "gemini-cli": "Gemini CLI",
      gitlab: "GitLab",
      opencode: "OpenCode",
    }
    return map[normalizedProviderKey] ?? name
  }

  const normalizeProviderForRotation = (providerId: string) => {
    const normalizedProviderKey = providerKey(providerId)
    // Normalize legacy account-like provider IDs into their provider key when possible.
    if (normalizedProviderKey && normalizedProviderKey.includes("@")) {
      if (normalizedProviderKey.endsWith("gmail.com")) return "google-api"
    }
    return normalizedProviderKey ?? providerId
  }

  const resolveSessionAccountIdForProvider = async (providerId: string) => {
    const sessionID = route.data.type === "session" ? route.data.sessionID : undefined
    const targetProviderKey = providerKey(providerId) ?? providerId
    const current = local.model.current(sessionID)
    const currentAccountId = local.model.currentAccountId(sessionID)
    const currentProviderKey = current ? (providerKey(current.providerId) ?? current.providerId) : undefined
    if (currentAccountId && currentProviderKey === targetProviderKey) return currentAccountId
    if (!targetProviderKey) return undefined
    return (await Account.getActive(targetProviderKey)) ?? undefined
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

  const probeAndSelectModel = async (providerId: string, modelID: string, origin?: string) => {
    const normalizedProviderId = normalizeProviderForRotation(providerId)
    const accountId = await resolveSessionAccountIdForProvider(normalizedProviderId)
    debugCheckpoint("model", "selected (probe skipped)", {
      provider: providerId,
      providerNormalized: normalizedProviderId,
      model: modelID,
      accountId,
      origin,
    })
    local.model.set(
      { providerId: normalizedProviderId, modelID, accountId },
      { recent: true, skipValidation: true, announce: true, interrupt: true, syncSessionExecution: true },
      route.data.type === "session" ? route.data.sessionID : undefined,
    )
    dialog.clear()
  }

  const connected = useConnected()

  const providersByKey = createMemo(() => {
    const map = new Map<string, typeof sync.data.provider>()
    for (const p of sync.data.provider) {
      const normalizedProviderKey = providerKey(p.id) ?? p.id
      const list = map.get(normalizedProviderKey)
      if (list) list.push(p)
      else map.set(normalizedProviderKey, [p])
    }
    return map
  })

  const options = createMemo(() => {
    const favoritesRaw = connected() ? local.model.favorite() : []
    const hidden = local.model.hidden()
    const hiddenProviders = new Set(local.model.hiddenProviders())
    const providersByGroup = providersByKey()

    const isHiddenForProviderKey = (providerGroupKey: string, modelID: string) => {
      const members = providersByGroup.get(providerGroupKey) ?? []
      return hidden.some((h) => {
        if (h.modelID !== modelID) return false
        if (h.providerId === providerGroupKey) return true
        return members.some((m) => m.id === h.providerId)
      })
    }

    const dedupFavorites = new Map<string, { providerId: string; modelID: string }>()
    for (const item of favoritesRaw) {
      const normalizedProviderId = normalizeProviderForRotation(item.providerId)
      dedupFavorites.set(`${normalizedProviderId}:${item.modelID}`, {
        providerId: normalizedProviderId,
        modelID: item.modelID,
      })
    }

    const favorites = [...dedupFavorites.values()]
      .map((item) => {
        const members = providersByGroup.get(item.providerId) ?? []
        const found = members
          .map((p) => ({ provider: p, model: p.models[item.modelID] }))
          .find(({ model }) => !!model && model.status !== "deprecated")
        if (!found) return undefined
        if (!showHiddenProviders() && hiddenProviders.has(item.providerId)) return undefined
        if (!showHiddenModels() && isHiddenForProviderKey(item.providerId, item.modelID)) return undefined
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

    const providerGroups = [...providersByGroup.entries()]
      .filter(([_, members]) => members.some((p) => Object.keys(p.models).length > 0))
      .sort(([a], [b]) => providerLabel(a, a).localeCompare(providerLabel(b, b)))

    for (const [providerGroupKey, members] of providerGroups) {
      if (!showHiddenProviders() && hiddenProviders.has(providerGroupKey)) continue
      const expanded = expandedProviders().has(providerGroupKey)
      const providerHidden = hiddenProviders.has(providerGroupKey)

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
        value: { kind: "provider", providerId: providerGroupKey } as ProviderOptionValue,
        title: `  ${expanded ? "▼" : "▶"} ${providerLabel(providerGroupKey, providerGroupKey)}`,
        description: providerHidden ? `${modelCount} models · hidden` : `${modelCount} models`,
        onSelect: () => toggleProviderExpanded(providerGroupKey),
      })

      if (!expanded) continue

      const models = [...modelMap.entries()]
        .filter(([mid]) => (showHiddenModels() ? true : !isHiddenForProviderKey(providerGroupKey, mid)))
        .sort((a, b) => a[1].name.localeCompare(b[1].name))

      for (const [index, [mid, meta]] of models.entries()) {
        const favorite = favorites.some((f) => f.providerId === providerGroupKey && f.modelID === mid)
        const branch = index === models.length - 1 ? "└─" : "├─"
        list.push({
          value: { kind: "model", providerId: providerGroupKey, modelID: mid } as ModelOptionValue,
          title: `      ${branch} ${meta.name} ${favorite ? "★" : " "}`,
          gutter: undefined,
          description:
            meta.cooldownUntil && meta.cooldownUntil > Date.now()
              ? `⏳ Rate limited (${Math.ceil((meta.cooldownUntil - Date.now()) / 1000 / 60)}m)`
              : meta.blocked
                ? `⛔ ${meta.blocked}`
                : undefined,
          disabled:
            (providerGroupKey === "opencode" && mid.includes("-nano")) || (meta.blocked?.includes("blocked") ?? false),
          onSelect: () => probeAndSelectModel(providerGroupKey, mid),
        })
      }
    }

    return list
  })

  const currentOption = createMemo(() => {
    const current = local.model.current(route.data.type === "session" ? route.data.sessionID : undefined)
    if (!current) return undefined

    const normalizedProviderId = normalizeProviderForRotation(current.providerId)
    const members = providersByKey().get(normalizedProviderId) ?? []
    const exists = members.some((p) => !!p.models[current.modelID])
    if (exists) {
      return { kind: "model", providerId: normalizedProviderId, modelID: current.modelID } as ModelOptionValue
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
              const hidden = local.model.isProviderHidden(val.providerId)
              local.model.toggleHiddenProvider(val.providerId)
              toast.show({
                message: hidden ? `Provider unhidden: ${val.providerId}` : `Provider hidden: ${val.providerId}`,
                variant: "info",
                duration: 2000,
              })
              return
            }
            if (val.kind !== "model") return
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
              const next = !showHiddenProviders()
              setShowHiddenProviders(next)
              toast.show({
                message: next ? "Show All Providers enabled" : "Show All Providers disabled",
                variant: "info",
                duration: 1500,
              })
              return
            }
            const next = !showHiddenModels()
            setShowHiddenModels(next)
            toast.show({
              message: next ? "Show Hidden Models enabled" : "Show Hidden Models disabled",
              variant: "info",
              duration: 1500,
            })
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
                toast.show({
                  message: `Provider unhidden: ${val.providerId}`,
                  variant: "info",
                  duration: 2000,
                })
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
      hideCurrentIndicator
    />
  )
}
