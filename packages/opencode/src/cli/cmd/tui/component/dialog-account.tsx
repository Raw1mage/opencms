import { useDialog } from "../ui/dialog"
import { useKeybind } from "../context/keybind"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { createMemo, createSignal, onMount } from "solid-js"
import { Account } from "../../../../account"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogProvider } from "./dialog-provider"
import { DialogConfirm } from "../ui/dialog-confirm"

interface AccountOption {
  accountId: string
  providerKey: string
  type: string
}

export function DialogAccount() {
  const sync = useSync()
  const dialog = useDialog()
  const keybind = useKeybind()
  const { theme } = useTheme()
  const toast = useToast()
  const sdk = useSDK()

  const [providerAccounts, setProviderAccounts] = createSignal<Record<string, Account.ProviderData>>({})

  onMount(() => {
    loadAccounts()
  })

  const loadAccounts = async () => {
    try {
      const all = await Account.listAll()
      setProviderAccounts(all)

      // Auto-switch away from invalid gemini-cli accounts
      if (all["gemini-cli"]) {
        const gemini = all["gemini-cli"]
        const activeId = gemini.activeAccount
        if (activeId && gemini.accounts[activeId]?.type === "subscription") {
          const apiId = Object.keys(gemini.accounts).find((id) => gemini.accounts[id].type === "api")
          if (apiId) {
            await setActive("gemini-cli", apiId)
            toast.show({ message: "Switched to API Key account", variant: "info" })
          }
        }
      }
    } catch (e) {
      console.error("Failed to load accounts:", e)
    }
  }

  const setActive = async (providerKey: string, accountId: string) => {
    await Account.setActive(providerKey, accountId)
    await loadAccounts()
  }

  const remove = async (providerKey: string, accountId: string) => {
    // Optimistic UI update
    setProviderAccounts(prev => {
      const next = { ...prev }
      if (next[providerKey] && next[providerKey].accounts) {
        // Deep copy the accounts object before mutating
        next[providerKey] = {
          ...next[providerKey],
          accounts: { ...next[providerKey].accounts }
        }
        delete next[providerKey].accounts[accountId]
      }
      return next
    })
    
    // Perform backend deletion
    const { Auth } = await import("../../../../auth")
    await Auth.remove(accountId)
    // Silently refresh true state in background
    loadAccounts()
  }

  const getAccountStatus = (info: Account.Info): { icon: string; color: any; text: string } | null => {
    if (info.type === "subscription") {
      if (info.coolingDownUntil && info.coolingDownUntil > Date.now()) {
        const remaining = Math.ceil((info.coolingDownUntil - Date.now()) / 1000 / 60)
        return { icon: "⏳", color: theme.warning, text: `Rate limited (${remaining}m)` }
      }
      if (info.cooldownReason?.includes("quota")) {
        return { icon: "💰", color: theme.error, text: "Quota exceeded" }
      }
    }
    return null
  }

  const options = createMemo(() => {
    const data = providerAccounts()
    if (Object.keys(data).length === 0) return []

    const result: DialogSelectOption<AccountOption>[] = []

    // Use predefined order but include any extra provider keys found
    const knownProviders = [...Account.PROVIDERS] as string[]
    const allProviders = Array.from(new Set([...knownProviders, ...Object.keys(data)]))

    for (const providerKey of allProviders) {
      const providerData = data[providerKey]
      if (!providerData || !providerData.accounts) continue

      const accounts = Object.entries(providerData.accounts)
      if (accounts.length === 0) continue

      // Sort: active first, then API vs Subscription, then Name
      const sorted = accounts
        .filter(([id, acc]) => {
          // Filter out subscription accounts for gemini-cli
          if (providerKey === "gemini-cli" && acc.type === "subscription") return false
          return true
        })
        .sort(([idA, a], [idB, b]) => {
          const activeId = providerData.activeAccount
          const isActiveA = idA === activeId
          const isActiveB = idB === activeId

          if (isActiveA && !isActiveB) return -1
          if (!isActiveA && isActiveB) return 1
          if (a.type === "api" && b.type === "subscription") return 1
          if (a.type === "subscription" && b.type === "api") return -1
          return (a.name || "").localeCompare(b.name || "")
        })

      for (const [accountId, info] of sorted) {
        const isActive = accountId === providerData.activeAccount

        // Provider Display Name
        const providerDisplayName = providerKey.charAt(0).toUpperCase() + providerKey.slice(1)

        // Type Label
        let typeLabel = "Free"
        if (info.type === "api") typeLabel = "API"
        else if (info.type === "subscription") {
          // Heuristic for tier? Account.Info doesn't strictly have 'tier' in the Zod schema shown in previous file view
          // but we can default to Subscription or Paid if we knew.
          // For now, let's just say "Subscription" or check specific fields if available.
          // actually the previous code had `info.tier`.
          // The Zod schema in src/account/index.ts does NOT show `tier`.
          // So we'll just use "Subscription".
          typeLabel = "Subscription"
        }

        const categoryLabel = `${providerDisplayName} (${typeLabel})`
        const status = getAccountStatus(info)

        const displayName = Account.getDisplayName(accountId, info, providerKey)

        let description: string | undefined
        if (info.type === "subscription" && info.email && info.email !== displayName) {
          description = info.email
        } else if (info.type === "subscription" && info.projectId) {
          description = `Project: ${info.projectId}`
        } else if (info.type === "api" && (info as any).projectId) {
          description = `Project: ${(info as any).projectId}`
        }

        if (status) {
          description = description ? `${description} ${status.icon} ${status.text}` : `${status.icon} ${status.text}`
        }

        result.push({
          value: {
            accountId: accountId,
            providerKey,
            type: info.type,
          },
          title: displayName,
          description,
          category: categoryLabel,
          footer: isActive ? "Active" : undefined,
          gutter: isActive ? (
            <text fg={theme.success}>●</text>
          ) : status ? (
            <text fg={status.color}>{status.icon}</text>
          ) : undefined,
          onSelect: async () => {
            await setActive(providerKey, accountId)
            toast.show({ message: `Switched to ${displayName}`, variant: "success" })
            // Reload the provider state
            await sdk.client.instance.dispose()
            await sync.bootstrap()
            dialog.clear()
          },
        })
      }
    }

    return result
  })

  const handleDelete = async (option: DialogSelectOption<AccountOption> | undefined) => {
    if (!option) return
    const selected = option.value
    const confirmed = await DialogConfirm.show(
      dialog,
      "Delete Account",
      `Are you sure you want to delete this account?`,
    )

    if (confirmed) {
      await remove(selected.providerKey, selected.accountId)
      toast.show({ message: "Account deleted", variant: "info" })
      await sdk.client.instance.dispose()
      await sync.bootstrap()
    }
    // Re-show
    dialog.replace(() => <DialogAccount />)
  }

  return (
    <DialogSelect
      title="Manage Accounts"
      options={options()}
      current={undefined}
      keybind={[
        {
          keybind: { name: "left", ctrl: false, meta: false, shift: false, super: false, leader: false },
          title: "Back",
          onTrigger: () => {
            dialog.clear()
          },
        },
        {
          keybind: { name: "n", ctrl: true, meta: false, shift: false, super: false, leader: false },
          title: "Add",
          onTrigger: () => {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          keybind: { name: "delete", ctrl: false, meta: false, shift: false, super: false, leader: false },
          title: "Delete",
          onTrigger: handleDelete,
        },
      ]}
    />
  )
}
