import { createMemo, createSignal, createResource } from "solid-js"
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
import { AccountManager } from "../../../../plugin/antigravity/plugin/accounts"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogProvider as DialogProviderList } from "./dialog-provider"
import { useToast } from "@tui/ui/toast"
import { saveAccounts } from "../../../../plugin/antigravity/plugin/storage"

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
  const toast = useToast()
  const keybind = useKeybind()
  const { theme } = useTheme()
  const [ref, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [query, setQuery] = createSignal("")
  const [showHidden, setShowHidden] = createSignal(false)

  // Navigation State
  // steps: root -> account_select -> model_select
  // distinct views: favorites, recents
  const [step, setStep] = createSignal<"root" | "account_select" | "model_select" | "favorites" | "recents">("root")
  const [selectedFamily, setSelectedFamily] = createSignal<string | null>(null)
  const [selectedProviderID, setSelectedProviderID] = createSignal<string | null>(props.providerID ?? null)

  const [refreshSignal, setRefreshSignal] = createSignal(0)
  const forceRefresh = () => setRefreshSignal((s) => s + 1)

  // Load Antigravity Manager
  const [agManager] = createResource(refreshSignal, async () => {
    try {
      return await AccountManager.loadFromDisk()
    } catch (e) {
      return null
    }
  })
  const [coreAll] = createResource(refreshSignal, async () => {
    try {
      return await Account.listAll()
    } catch (e) {
      return {}
    }
  })
  const [coreActive] = createResource(refreshSignal, async () => {
    try {
      return await Account.getActive("antigravity")
    } catch (e) {
      return undefined
    }
  })

  const connected = useConnected()

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

    // Fix Antigravity Display Name using AccountManager
    if (fam === 'antigravity') {
      const manager = agManager()
      if (manager) {
        const snap = manager.getAccountsSnapshot()

        // Case 1: Specific Account ID (e.g., antigravity-subscription-1)
        const match = provider.id.match(/antigravity-subscription-(\d+)/)
        if (match) {
          const index = parseInt(match[1]) - 1
          const acc = snap.find((a: any) => a.index === index)
          if (acc && acc.email) return acc.email
        }

        // Case 2: Generic "antigravity" ID -> Use Active Account
        if (provider.id === 'antigravity') {
          const activeIndex = manager.getActiveIndex()
          const acc = snap.find((a: any) => a.index === activeIndex)
          if (acc && acc.email) return acc.email
        }

        // Case 3: Fallback by index match
        const acc = snap.find((a: any) => String(a.index) === provider.id)
        if (acc && acc.email) return acc.email
      }
    }

    const info = {
      type: "subscription",
      name: provider.name,
      email: provider.email,
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

  // Group providers by family
  const groupedProviders = createMemo(() => {
    const groups = new Map<string, any[]>()
    for (const p of sync.data.provider) {
      const fam = family(p.id)
      if (!fam) continue
      if (!groups.has(fam)) groups.set(fam, [])
      groups.get(fam)!.push(p)
    }
    return groups
  })

  const options = createMemo(() => {
    const s = step()
    const q = query()

    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    // ROOT VIEW: Families + Favorites/Recents (Expanded)
    if (s === "root") {
      const list = []

      const getModelOptions = (modelList: { providerID: string, modelID: string, origin?: string }[]) => {
        return modelList.flatMap(item => {
          const p = sync.data.provider.find(x => x.id === item.providerID)
          if (!p) return []
          const m = p.models[item.modelID]
          if (!m) return []

          return [{
            value: { providerID: item.providerID, modelID: item.modelID, origin: item.origin },
            title: m.name ?? item.modelID,
            description: label(p.name, p.id),
            category: item.origin === 'favorite' ? "Favorites" : "Recents",
            footer: m.cost?.input === 0 ? "Free" : undefined,
            disabled: (p.id === "opencode" && m.id.includes("-nano")),
            onSelect: () => {
              dialog.clear()
              local.model.set({ providerID: item.providerID, modelID: item.modelID }, { recent: true })
            }
          }]
        })
      }

      if (favorites.length > 0) {
        list.push(...getModelOptions(favorites.map(x => ({ ...x, origin: 'favorite' }))))
      }

      if (recents.length > 0) {
        list.push(...getModelOptions(recents.map(x => ({ ...x, origin: 'recent' }))))
      }

      // 3. Families
      // Sort families: Antigravity first, then others
      const families = Array.from(groupedProviders().keys()).sort((a, b) => {
        if (a === 'antigravity') return -1
        if (b === 'antigravity') return 1
        return a.localeCompare(b)
      })

      for (const fam of families) {
        const providers = groupedProviders().get(fam) || []
        // Check if any is active or has models
        if (providers.every(p => Object.keys(p.models).length === 0 && !p.active)) continue;

        const displayName = label(fam, fam) // Pass id same as name if abstract
        const familyData = coreAll()?.[fam]
        const allIds = familyData ? Object.keys(familyData.accounts || {}) : []
        const isFamilySuffix = (id: string) => id === `${fam}-subscription-${fam}` || id === `${fam}-api-${fam}`
        const isGeneric = (id: string) =>
          id === fam || id === "google" || id === "gemini-cli" || id === "antigravity" || isFamilySuffix(id)
        const hasSpecific = allIds.some(id => !isGeneric(id))
        const filteredIds = allIds.filter(id => (hasSpecific ? !isGeneric(id) : true))
        const accountTotal = familyData ? filteredIds.length : providers.length
        const activeCount = familyData?.activeAccount ? 1 : providers.filter(p => p.active).length

        list.push({
          value: fam,
          title: displayName,
          category: "Providers",
          icon: "📂",
          description: accountTotal >= 1 ? `${accountTotal} account${accountTotal === 1 ? "" : "s"}` : undefined,
          gutter: activeCount > 0 ? <text fg={theme.success as any}>●</text> : undefined,
          onSelect: () => {
            setSelectedFamily(fam)
            setStep("account_select")
            setQuery("")
          }
        })
      }
      return list
    }

    // ACCOUNT SELECTION VIEW
    if (s === "account_select") {
      const fam = selectedFamily()
      if (!fam) return []

      // Special handling for Antigravity: Get accounts directly from manager
      let accountList: any[] = []

      if (fam === 'antigravity') {
        const agAccounts = agManager()?.getAccountsSnapshot() || []

        if (agAccounts.length > 0) {
          const core = coreAll()?.antigravity?.accounts || {}
          const coreByToken = new Map<string, string>()
          const coreByEmail = new Map<string, string>()
          for (const entry of Object.entries(core)) {
            const id = entry[0]
            const info = entry[1] as any
            if (info?.type !== "subscription") continue
            if (info.refreshToken) coreByToken.set(info.refreshToken, id)
            if (info.email) coreByEmail.set(info.email, id)
          }

          const activeId = coreActive()

          accountList = agAccounts.map(acc => {
            const id = `antigravity-subscription-${acc.index + 1}`
            const token = acc.parts?.refreshToken
            const byToken = token ? coreByToken.get(token) : undefined
            const byEmail = acc.email ? coreByEmail.get(acc.email) : undefined
            const mapped = byToken || byEmail
            const coreId = mapped || id
            const isActive = activeId ? activeId === coreId : agManager()?.getActiveIndex() === acc.index
            return {
              id: id,
              coreId: coreId,
              name: acc.email || `Account ${acc.index + 1}`,
              active: isActive,
              email: acc.email,
              type: "subscription"
            }
          })
        }
      } else {
        const familyData = coreAll()?.[fam]
        const accounts = familyData?.accounts || {}
        const activeId = familyData?.activeAccount
        const isFamilySuffix = (id: string) => id === `${fam}-subscription-${fam}` || id === `${fam}-api-${fam}`
        const isGeneric = (id: string) =>
          id === fam || id === "google" || id === "gemini-cli" || id === "antigravity" || isFamilySuffix(id)
        const hasSpecific = Object.keys(accounts).some(id => !isGeneric(id))
        accountList = Object.entries(accounts)
          .filter(([id]) => {
            if (hasSpecific && isGeneric(id)) return false
            return true
          })
          .map(([id, info]) => {
            const displayName = Account.getDisplayName(id, info as any, fam) || (info as any)?.name || id
            return {
              id,
              coreId: id,
              name: displayName,
              active: activeId === id,
              email: (info as any)?.email,
              type: (info as any)?.type
            }
          })
      }

      const accountOptions = pipe(
        accountList,
        map(p => {
          // Determine display name
          let title = p.name
          if (fam === 'antigravity' && p.email) title = p.email
          else if (fam === 'antigravity') {
            // Fallback title logic if name is missing or same as ID
            title = p.name || p.id
          } else {
            const who = owner(p)
            title = who || p.name || p.id
          }

          return {
            value: p.id,
            coreId: p.coreId || p.id,
            title: title,
            category: label(fam, fam),
            icon: "👤",
            description: p.id !== title ? p.id : undefined,
            onSelect: async () => {
              // If Antigravity, we need to explicitly set active
              if (fam === 'antigravity') {
                try {
                  const coreId = p.coreId || p.id
                  // Update Core
                  await Account.setActive(fam, coreId)

                  // Update Specialized Manager
                  const manager = agManager()
                  if (manager) {
                    const match = p.id.match(/antigravity-subscription-(\d+)/)
                    if (match) {
                      const index = parseInt(match[1]) - 1
                      manager.setActiveIndex(index)
                      await saveAccounts({
                        version: 3,
                        accounts: manager.getAccountsSnapshot() as any,
                        activeIndex: manager.getActiveIndex(),
                        activeIndexByFamily: manager.getActiveIndexByFamily()
                      })
                    }
                  }
                } catch (e) {
                  console.error(e)
                }
                // For model selection, use the GENERIC "antigravity" provider ID
                setSelectedProviderID('antigravity')
              } else {
                if (fam) {
                  await Account.setActive(fam, p.coreId || p.id)
                  await Account.refresh()
                }
                setSelectedProviderID(p.coreId || p.id)
              }
              setStep("model_select")
              setQuery("")
              forceRefresh()
            }
          }
        })
      )

      return accountOptions
    }

    // FAVORITES VIEW
    if (s === "favorites") {
      const list = []
      const getModelOptions = (modelList: { providerID: string, modelID: string, origin?: string }[]) => {
        return modelList.flatMap(item => {
          const p = sync.data.provider.find(x => x.id === item.providerID)
          if (!p) return []
          const m = p.models[item.modelID]
          if (!m) return []
          return [{
            value: { providerID: item.providerID, modelID: item.modelID },
            title: m.name ?? item.modelID,
            description: label(p.name, p.id),
            category: item.origin === 'favorite' ? "Favorites" : "Recents",
            footer: m.cost?.input === 0 ? "Free" : undefined,
            disabled: (p.id === "opencode" && m.id.includes("-nano")),
            onSelect: () => {
              dialog.clear()
              local.model.set({ providerID: item.providerID, modelID: item.modelID }, { recent: true })
            }
          }]
        })
      }
      list.push(...getModelOptions(favorites.map(x => ({ ...x, origin: 'favorite' }))))
      return list
    }

    // RECENTS VIEW
    if (s === "recents") {
      const list = []
      const getModelOptions = (modelList: { providerID: string, modelID: string, origin?: string }[]) => {
        return modelList.flatMap(item => {
          const p = sync.data.provider.find(x => x.id === item.providerID)
          if (!p) return []
          const m = p.models[item.modelID]
          if (!m) return []
          return [{
            value: { providerID: item.providerID, modelID: item.modelID },
            title: m.name ?? item.modelID,
            description: label(p.name, p.id),
            category: item.origin === 'favorite' ? "Favorites" : "Recents",
            footer: m.cost?.input === 0 ? "Free" : undefined,
            disabled: (p.id === "opencode" && m.id.includes("-nano")),
            onSelect: () => {
              dialog.clear()
              local.model.set({ providerID: item.providerID, modelID: item.modelID }, { recent: true })
            }
          }]
        })
      }
      list.push(...getModelOptions(recents.map(x => ({ ...x, origin: 'recent' }))))
      return list
    }

    // MODEL SELECTION VIEW (Tier 3)
    if (s === "model_select") {
      const pid = selectedProviderID()
      if (!pid) return []
      const p = sync.data.provider.find(x => x.id === pid)
      if (!p) return []

      const showAll = showHidden()

      return pipe(
        p.models,
        entries(),
        filter(([_, info]) => info.status !== "deprecated"),
        // Filter hidden
        filter(([mid, _]) => {
          if (showAll) return true
          return !local.model.hidden().some(h => h.providerID === pid && h.modelID === mid)
        }),
        map(([mid, info]) => {
          const isFav = favorites.some(f => f.providerID === pid && f.modelID === mid)
          const pAny = p as any
          return {
            value: { providerID: pid, modelID: mid },
            title: info.name ?? mid,
            category: "Models",
            gutter: isFav ? "⭐" : undefined,
            description: iife(() => {
              if (pAny.coolingDownUntil && pAny.coolingDownUntil > Date.now()) {
                const remaining = Math.ceil((pAny.coolingDownUntil - Date.now()) / 1000 / 60)
                return `⏳ Rate limited (${remaining}m)`
              }
              if (pAny.cooldownReason) return `⛔ ${pAny.cooldownReason}`
              return undefined
            }),
            disabled: (pid === "opencode" && mid.includes("-nano")) || (pAny.cooldownReason?.includes("blocked") ?? false),
            footer: info.cost?.input === 0 ? "Free" : undefined,
            onSelect: () => {
              dialog.clear()
              local.model.set({ providerID: pid, modelID: mid }, { recent: true })
            }
          }
        }),
        sortBy(x => x.title)
      )
    }

    return []
  })

  const title = createMemo(() => {
    if (step() === "root") return "Select Provider"
    if (step() === "favorites") return "Favorites"
    if (step() === "recents") return "Recent Models"
    if (step() === "account_select") return `Select Account (${label(selectedFamily() || "", selectedFamily() || "")})`
    if (step() === "model_select") {
      if (selectedProviderID()) {
        const p = sync.data.provider.find(x => x.id === selectedProviderID())
        if (p) {
          const who = owner(p)
          if (who) return `Select Model - ${who}`
          return `Select Model - ${p.name}`
        }
      }
      return "Select Model"
    }
    return "Models"
  })

  // Handle Back
  const goBack = () => {
    if (query() !== "") {
      setQuery("")
      return
    }
    if (step() === "root") {
      dialog.clear()
      return
    }
    if (step() === "account_select" || step() === "favorites" || step() === "recents") {
      setStep("root")
      setSelectedFamily(null)
      return
    }
    if (step() === "model_select") {
      setStep("account_select")
      setSelectedProviderID(null)
      return
    }
  }

  return (
    <DialogSelect
      keybind={[
        {
          keybind: Keybind.parse("f")[0],
          title: "Favorite",
          label: "F/f",
          disabled: !connected() || step() !== "model_select", // Only allow favoriting in model list
          onTrigger: (option: any) => {
            const val = option.value
            if (val && typeof val === "object" && val.providerID && val.modelID) {
              local.model.toggleFavorite(val)
            }
          },
        },
        {
          keybind: Keybind.parse("delete")[0],
          title: step() === "model_select" ? "Hide" : "Delete",
          label: "del",
          disabled: !connected(),
          onTrigger: async (option: any) => {
            const val = option.value

            // Handle Account Deletion in 'account_select' step
            if (step() === "account_select" && typeof val === "string" && val !== "__add_account__") {
              const fam = selectedFamily()
              if (!fam) return

              const confirmed = await DialogConfirm.show(
                dialog,
                "Delete Account",
                `Are you sure you want to delete this account?`
              )

              if (confirmed) {
                try {
                  // 1. Specialized Antigravity Cleanup
                  if (fam === 'antigravity') {
                    const manager = agManager()
                    if (manager) {
                      const match = val.match(/antigravity-subscription-(\d+)/)
                      if (match) {
                        const index = parseInt(match[1]) - 1
                        if (manager.removeAccountByIndex(index)) {
                          await saveAccounts({
                            version: 3,
                            accounts: manager.getAccountsSnapshot() as any,
                            activeIndex: manager.getActiveIndex(),
                            activeIndexByFamily: manager.getActiveIndexByFamily()
                          })
                        }
                      }
                    }
                  }

                  // 2. Core Account Removal
                  const coreId = option.coreId || val
                  await Account.remove(fam, coreId)
                  await Account.refresh()

                  toast.show({ message: "Account deleted successfully", variant: "success" })
                  setStep("account_select")
                  setSelectedFamily(fam)
                  setQuery("")
                  forceRefresh()
                } catch (e: any) {
                  toast.error(e)
                }
              }
              return
            }

            if (step() === "model_select") {
              const modelVal = option.value as { providerID: string; modelID: string; origin?: string }
              if (modelVal.origin === "recent") {
                local.model.removeFromRecent(modelVal)
              } else if (modelVal.origin === "favorite") {
                local.model.toggleFavorite(modelVal)
              } else {
                local.model.toggleHidden(modelVal)
              }
            }
          },
        },
        {
          keybind: Keybind.parse("s")[0],
          title: "Showall",
          label: "S/s",
          disabled: !connected() || step() !== "model_select",
          onTrigger: () => setShowHidden(!showHidden()),
        },
        {
          keybind: Keybind.parse("insert")[0],
          title: "Unhide",
          label: "Ins",
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
          keybind: Keybind.parse("a")[0],
          title: "Add",
          label: "A/a",
          disabled: step() !== "account_select",
          onTrigger: () => {
            const fam = selectedFamily()
            if (fam) dialog.replace(() => <DialogProviderList providerID={fam} />)
          }
        },
        {
          keybind: Keybind.parse("left")[0],
          title: "Back",
          label: "left/esc",
          hidden: step() === "model_select",
          onTrigger: goBack
        },
        {
          keybind: Keybind.parse("esc")[0],
          title: "",
          hidden: true,
          onTrigger: goBack
        },
      ]}
      ref={setRef}
      onFilter={setQuery}
      skipFilter={step() === "account_select"}
      hideInput={step() === "account_select"}
      title={title()}
      current={local.model.current()}
      options={options()}
      keybindLayout={step() === "account_select" || step() === "model_select" ? "columns" : "inline"}
    />
  )
}
