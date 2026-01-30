import { createMemo, createSignal, createResource } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { map, pipe, entries, filter, sortBy } from "remeda"
import { DialogSelect, type DialogSelectRef } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider } from "./dialog-provider"
import { DialogAccount } from "./dialog-account"
import { useKeybind } from "../context/keybind"
import { useTheme } from "@tui/context/theme"
import { iife } from "@/util/iife"
import { Account } from "@/account"
import { Keybind } from "@/util/keybind"
import { AccountManager } from "../../../../plugin/antigravity/plugin/accounts"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogProvider as DialogProviderList } from "./dialog-provider"
import { useToast } from "@tui/ui/toast"
import { saveAccounts, loadAccounts } from "../../../../plugin/antigravity/plugin/storage"

// Helper to check connectivity
function useConnected() {
    const sync = useSync()
    return createMemo(() =>
        sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
    )
}

export function DialogAdmin() {
    const local = useLocal()
    const sync = useSync()
    const dialog = useDialog()
    const toast = useToast()
    const { theme } = useTheme()
    const [ref, setRef] = createSignal<DialogSelectRef<unknown>>()
    const [query, setQuery] = createSignal("")
    const [showHidden, setShowHidden] = createSignal(false)

    // Navigation State
    // steps: root -> account_select -> model_select
    // distinct views: favorites, recents
    const [step, setStep] = createSignal<"root" | "account_select" | "model_select" | "favorites" | "recents">("root")
    const [selectedFamily, setSelectedFamily] = createSignal<string | null>(null)

    // This tracks the "provider ID" that models.ts/sync system naturally understands
    // For Antigravity, it's the generic "antigravity". For others, it might be specific IDs.
    const [selectedProviderID, setSelectedProviderID] = createSignal<string | null>(null)

    // Load Antigravity Manager for accurate account listing
    // To trigger UI updates when we change active account (since sync might lag)
    const [refreshSignal, setRefreshSignal] = createSignal(0)
    const forceRefresh = () => setRefreshSignal(s => s + 1)

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
    const refreshAntigravity = async () => {
        try {
            const mod = await import("../../../../plugin/antigravity")
            if (mod.refreshGlobalAccountManager) {
                await mod.refreshGlobalAccountManager()
            }
        } catch { }
    }
    const [coreAg] = createResource(refreshSignal, async () => {
        try {
            return await Account.list("antigravity")
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

        // Agnostic owner fallback
        const info = {
            type: "subscription",
            name: provider.name,
            email: provider.email,
        }
        const display = Account.getDisplayName(provider.id, info as any, fam as string)
        return display || undefined
    }

    // Group providers by family from SYNC data (for Level 1 list)
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

    // ---- OPTION GENERATION ----
    const options = createMemo(() => {
        const s = step()
        const triggers = refreshSignal() // Dependency to force re-calc

        const favorites = connected() ? local.model.favorite() : []
        const recents = local.model.recent()

        // LEVEL 1: ROOT
        if (s === "root") {
            const list = []

            // LIST HELPERS (Favorites/Recents)
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

            // 1. Favorites (Directly listed)
            if (favorites.length > 0) {
                list.push(...getModelOptions(favorites.map(x => ({ ...x, origin: 'favorite' }))))
            }

            // 2. Recents (Directly listed)
            if (recents.length > 0) {
                list.push(...getModelOptions(recents.map(x => ({ ...x, origin: 'recent' }))))
            }

            // 3. Families
            const families = Array.from(groupedProviders().keys()).sort((a, b) => {
                if (a === 'antigravity') return -1
                if (b === 'antigravity') return 1
                return a.localeCompare(b)
            })

            for (const fam of families) {
                const providers = groupedProviders().get(fam) || []
                // Skip empty families?
                if (providers.every(p => Object.keys(p.models).length === 0 && !p.active)) continue;

                const displayName = label(fam, fam)
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
                        forceRefresh()
                    }
                })
            }
            return list
        }

        // LEVEL 2: ACCOUNT MANAGEMENT
        if (s === "account_select") {
            const fam = selectedFamily()
            if (!fam) return []

            if (agManager.loading) {
                return [{
                    title: "Loading accounts...",
                    value: "__loading__",
                    disabled: true,
                    category: "Status",
                    icon: "⏳"
                }]
            }

            // Combine sources for robustness
            const manager = agManager()
            const agAccounts = manager?.getAccountsSnapshot() || []
            const syncProviders = groupedProviders().get(fam) || []

            const accountMap = new Map<string, any>()

            // Level 2 strategy:
            // - Use core accounts for most providers.
            // - Use agManager for antigravity.

            if (fam !== "antigravity") {
                const familyData = coreAll()?.[fam]
                const accounts = familyData?.accounts || {}
                const activeId = familyData?.activeAccount
                const isFamilySuffix = (id: string) => id === `${fam}-subscription-${fam}` || id === `${fam}-api-${fam}`
                const isGeneric = (id: string) =>
                    id === fam || id === "google" || id === "gemini-cli" || id === "antigravity" || isFamilySuffix(id)
                const hasSpecific = Object.keys(accounts).some(id => !isGeneric(id))

                for (const entry of Object.entries(accounts)) {
                    const id = entry[0]
                    const info = entry[1] as any
                    if (hasSpecific && isGeneric(id)) continue

                    const displayName = Account.getDisplayName(id, info, fam) || info?.name || id
                    accountMap.set(id, {
                        id: id,
                        coreId: id,
                        name: displayName,
                        active: activeId === id,
                        email: info?.email
                    })
                }
            }

            if (fam === "antigravity") {
                const core = coreAg() || {}
                const coreByToken = new Map<string, string>()
                const coreByEmail = new Map<string, string>()

                for (const entry of Object.entries(core)) {
                    const id = entry[0]
                    const info = entry[1] as any
                    if (info?.type !== "subscription") continue
                    if (info.refreshToken) coreByToken.set(info.refreshToken, id)
                    if (info.email) coreByEmail.set(info.email, id)
                }

                if (!manager || agAccounts.length === 0) {
                    for (const p of syncProviders) {
                        accountMap.set(p.id, {
                            id: p.id,
                            coreId: p.id,
                            name: owner(p as any) || p.name || p.id,
                            active: p.active,
                            email: p.email
                        })
                    }
                }

                const activeId = coreActive()
                for (const acc of agAccounts) {
                    const id = `antigravity-subscription-${acc.index + 1}`

                    const token = acc.parts?.refreshToken
                    const byToken = token ? coreByToken.get(token) : undefined
                    const byEmail = acc.email ? coreByEmail.get(acc.email) : undefined
                    const mapped = byToken || byEmail
                    const coreId = mapped || id

                    const syncMatch = syncProviders.find(p => p.id === id)
                    const name = acc.email || (syncMatch ? owner(syncMatch as any) || syncMatch.name : null) || (acc.parts.projectId ? `Project: ${acc.parts.projectId}` : `Account ${acc.index + 1}`)

                    const isActive = activeId ? activeId === coreId : manager?.getActiveIndex() === acc.index
                    accountMap.set(id, {
                        id: id,
                        coreId: coreId,
                        name: name,
                        active: isActive,
                        email: acc.email,
                    })
                }
            }

            const accountList = Array.from(accountMap.values())

            const accountOptions = pipe(
                accountList,
                map(p => {
                    const title = p.name || p.id

                    return {
                        value: p.id,
                        coreId: p.coreId,
                        title: title,
                        category: label(fam, fam),
                        icon: "👤",
                        description: p.id !== title ? p.id : undefined,
                        onSelect: async () => {
                            await handleSetActive(fam, p.coreId || p.id, p.id)
                            await refreshAntigravity()
                            setStep("model_select")
                            setQuery("")
                        }
                    }
                })
            )

            const result = [...accountOptions]

            if (result.length === 0 && accountList.length === 0) {
                // Prepend a dummy if list is empty
                return [{
                    title: "No accounts configured",
                    value: "__none__",
                    disabled: true,
                    category: label(fam, fam),
                    icon: "⚠️"
                }]
            }

            return result
        }

        // LEVEL 3: MODEL SELECTION
        if (s === "model_select") {
            const pid = selectedProviderID()
            if (!pid) return []

            // Note: We look up in sync.data.provider. 
            // Since we just set active, we hope sync reflects this or the provider object is stable (e.g. "antigravity" generic ID).
            const p = sync.data.provider.find(x => x.id === pid)
            if (!p) return []

            const showAll = showHidden()

            const result = pipe(
                p.models,
                entries(),
                filter(([_, info]) => info.status !== "deprecated"),
                filter(([mid, _]) => {
                    if (showAll) return true
                    return !local.model.hidden().some(h => h.providerID === pid && h.modelID === mid)
                }),
                map(([mid, info]) => {
                    const isFav = favorites.some(f => f.providerID === pid && f.modelID === mid)
                    const pAny = p as any

                    const isRateLimited = (pAny.coolingDownUntil && pAny.coolingDownUntil > Date.now())
                    const isBlocked = !!pAny.cooldownReason
                    const isActionable = isRateLimited || isBlocked

                    return {
                        value: { providerID: pid, modelID: mid },
                        title: info.name ?? mid,
                        category: "Models",
                        gutter: isFav ? "⭐" : undefined,
                        description: iife(() => {
                            if (isRateLimited) {
                                const remaining = Math.ceil((pAny.coolingDownUntil - Date.now()) / 1000 / 60)
                                return `⏳ Rate limited (${remaining}m)`
                            }
                            if (isBlocked) return `⛔ ${pAny.cooldownReason}`
                            return undefined
                        }),
                        disabled: (pid === "opencode" && mid.includes("-nano")) || (isBlocked && !isRateLimited), // Allow selecting rate-limited to see timer? No, standard logic.
                        // Footer: "X" if limited/blocked, "Free" otherwise
                        footer: isActionable ? <text fg={theme.error as any}>X</text> : (info.cost?.input === 0 ? "Free" : undefined),
                        onSelect: () => {
                            dialog.clear()
                            local.model.set({ providerID: pid, modelID: mid }, { recent: true })
                        }
                    }
                }),
                sortBy(x => x.title)
            )

            if (result.length === 0) {
                return [{
                    title: "No models found",
                    value: "__empty__",
                    disabled: true,
                    category: "Models"
                }]
            }
            return result
        }

        return []
    })

    // ---- ACTIONS ----

    const handleSetActive = async (fam: string, accountId: string, displayId?: string) => {
        // 1. Set Active in Backend
        if (fam === 'antigravity') {
            try {
                // Update Core
                await Account.setActive(fam, accountId)

                // Update Specialized Manager
                const manager = agManager()
                if (manager) {
                    const id = displayId || accountId
                    const match = id.match(/antigravity-subscription-(\d+)/)
                    if (match) {
                        const index = parseInt(match[1]) - 1
                        manager.setActiveIndex(index)
                        await saveAccounts({
                            version: 3,
                            accounts: manager.getAccountsSnapshot() as any,
                            activeIndex: index,
                            activeIndexByFamily: {
                                claude: index,
                                gemini: index
                            }
                        }, true) // OVERWRITE to ensure exact sync
                    }
                }

                await Account.refresh()
            } catch (e) { console.error(e) }
            // Use generic ID for model lookup
            setSelectedProviderID('antigravity')
        } else if (fam === 'anthropic') {
            try {
                await Account.setActive(fam, accountId)
                await Account.refresh()
            } catch (e) { }
            // FORCE generic ID for Anthropic model lookup
            setSelectedProviderID('anthropic')
        } else {
            try {
                // Only call setActive if it's a multi-account family
                if (['openai', 'anthropic', 'google'].includes(fam)) {
                    await Account.setActive(fam, accountId)
                    await Account.refresh()
                }
            } catch (e) { }
            setSelectedProviderID(accountId)
        }
        forceRefresh() // Trigger UI redraw to show updated green dot
    }

    // ---- TITLES ----
    const title = createMemo(() => {
        if (step() === "root") return "Admin Control Panel"
        if (step() === "favorites") return "Favorites"
        if (step() === "recents") return "Recent Models"
        if (step() === "account_select") return `Manage Accounts (${label(selectedFamily() || "", selectedFamily() || "")})`
        if (step() === "model_select") {
            // Try to show meaningful header
            const pid = selectedProviderID()
            if (pid) {
                const p = sync.data.provider.find(x => x.id === pid)
                if (p) {
                    const who = owner(p)
                    if (who) return `Select Model - ${who}`
                    return `Select Model - ${p.name}`
                }
            }
            return "Select Model"
        }
        return "Admin"
    })

    // ---- BACK NAVIGATION ----
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
            // Keep provider ID selected? Or clear? 
            // Maybe clear to reset state, but keeping it is fine.
            // Actually, account list doesn't depend on selectedProviderID, it depends on selectedFamily.
            return
        }
    }

    return (
        <DialogSelect
            keybind={[

                // MODEL STEP KEYBINDS
                {
                    keybind: Keybind.parse("f")[0],
                    title: "Favorite",
                    label: "F/f",
                    disabled: !connected() || step() !== "model_select",
                    onTrigger: (option: any) => {
                        const val = option.value
                        if (val && typeof val === "object" && val.providerID && val.modelID) {
                            local.model.toggleFavorite(val)
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
                // ACCOUNT STEP KEYBINDS
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
                // SHARED / DELETE
                {
                    keybind: Keybind.parse("delete")[0],
                    title: step() === "model_select" ? "Hide" : "Delete",
                    label: "del",
                    disabled: !connected(),
                    onTrigger: async (option: any) => {
                        const val = option.value

                        if (step() === "account_select" && typeof val === "string" && val !== "__add_account__") {
                            const fam = selectedFamily()
                            if (fam) {
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
                                                        const remaining = manager.getAccountsSnapshot()
                                                        await saveAccounts({
                                                            version: 3,
                                                            accounts: remaining as any,
                                                            activeIndex: Math.max(0, manager.getActiveIndex()),
                                                            activeIndexByFamily: {
                                                                claude: Math.max(0, manager.getActiveIndex()),
                                                                gemini: Math.max(0, manager.getActiveIndex())
                                                            }
                                                        }, true) // OVERWRITE is critical for deletion
                                                    }
                                                }
                                            }
                                        }

                                        // 2. Core Account Removal
                                        // Use the mapped coreId (e.g. antigravity-subscription-ivon0829-gmail-com)
                                        const coreId = option.coreId || val
                                        await Account.remove(fam, coreId)
                                        await Account.refresh()

                                        toast.show({ message: "Account deleted successfully", variant: "success" })
                                        await refreshAntigravity()
                                        setStep("account_select")
                                        setSelectedFamily(fam)
                                        forceRefresh()
                                    } catch (e: any) {
                                        toast.error(e)
                                    }
                                }
                            }
                            return
                        }

                        if (step() === "model_select" || step() === "root") {
                            // Only handle model values (objects)
                            if (typeof val === "object" && val.providerID && val.modelID) {
                                const modelVal = val as any
                                if (modelVal.origin === "recent") local.model.removeFromRecent(modelVal)
                                else if (modelVal.origin === "favorite") local.model.toggleFavorite(modelVal)
                                else if (step() !== "root") local.model.toggleHidden(modelVal)
                            }
                        }
                    },
                },
                {
                    keybind: Keybind.parse("insert")[0],
                    title: "Unhide",
                    label: "Ins",
                    disabled: !connected() || !showHidden(),
                    onTrigger: (option: any) => {
                        // ... existing unhide logic ...
                        const val = option.value as any
                        local.model.toggleHidden(val)
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
