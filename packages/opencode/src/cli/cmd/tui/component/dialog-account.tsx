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
  family: string
  type: string
}

export function DialogAccount() {
  const sync = useSync()
  const dialog = useDialog()
  const keybind = useKeybind()
  const { theme } = useTheme()
  const toast = useToast()
  const sdk = useSDK()

  const [families, setFamilies] = createSignal<Record<string, Account.FamilyData>>({})

  onMount(() => {
    loadAccounts()
  })

  const loadAccounts = async () => {
    try {
      const all = await Account.listAll()
      setFamilies(all)
    } catch (e) {
      console.error("Failed to load accounts:", e)
    }
  }

  const setActive = async (family: string, accountId: string) => {
    await Account.setActive(family, accountId)
    await loadAccounts()
  }

  const remove = async (family: string, accountId: string) => {
    await Account.remove(family, accountId)
    await loadAccounts()
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
    const data = families()
    if (Object.keys(data).length === 0) return []

    const result: DialogSelectOption<AccountOption>[] = []

    // Use predefined order but include any extra families found
    const knownFamilies = [...Account.FAMILIES] as string[]
    const allFamilies = Array.from(new Set([...knownFamilies, ...Object.keys(data)]))

    for (const family of allFamilies) {
      const familyData = data[family]
      if (!familyData || !familyData.accounts) continue

      const accounts = Object.entries(familyData.accounts)
      if (accounts.length === 0) continue

      // Sort: active first, then API vs Subscription, then Name
      const sorted = accounts.sort(([idA, a], [idB, b]) => {
        const activeId = familyData.activeAccount
        const isActiveA = idA === activeId
        const isActiveB = idB === activeId

        if (isActiveA && !isActiveB) return -1
        if (!isActiveA && isActiveB) return 1
        if (a.type === "api" && b.type === "subscription") return 1
        if (a.type === "subscription" && b.type === "api") return -1
        return (a.name || "").localeCompare(b.name || "")
      })

      for (const [accountId, info] of sorted) {
        const isActive = accountId === familyData.activeAccount

        // Family Display Name
        const familyDisplayName = family.charAt(0).toUpperCase() + family.slice(1)

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

        const categoryLabel = `${familyDisplayName} (${typeLabel})`
        const status = getAccountStatus(info)

        const displayName = Account.getDisplayName(accountId, info, family)

        let description: string | undefined
        if (info.type === "subscription" && info.email && info.email !== displayName) {
          description = info.email
        } else if (info.type === "subscription" && info.projectId) {
          description = `Project: ${info.projectId}`
        }

        if (status) {
          description = description ? `${description} ${status.icon} ${status.text}` : `${status.icon} ${status.text}`
        }

        result.push({
          value: {
            accountId: accountId,
            family: family,
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
            await setActive(family, accountId)
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
      await remove(selected.family, selected.accountId)
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
