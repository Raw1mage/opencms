import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider } from "./dialog-provider"
import { useKeybind } from "../context/keybind"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { DialogConfirm } from "../ui/dialog-confirm"
import { xdgData } from "xdg-basedir"
import path from "path"
import fs from "node:fs"
import { Buffer } from "node:buffer"
import z from "zod"
import { JWT } from "@/util/jwt"

// Account type schemas (mirrored from account module to avoid Instance.state() dependency)
const ApiAccount = z.object({
  type: z.literal("api"),
  name: z.string(),
  apiKey: z.string(),
  addedAt: z.number(),
})

const SubscriptionAccount = z.object({
  type: z.literal("subscription"),
  name: z.string(),
  email: z.string().optional(),
  refreshToken: z.string(),
  accessToken: z.string().optional(),
  expiresAt: z.number().optional(),
  projectId: z.string().optional(),
  managedProjectId: z.string().optional(),
  accountId: z.string().optional(),
  addedAt: z.number(),
  rateLimitResetTimes: z.record(z.string(), z.number()).optional(),
  coolingDownUntil: z.number().optional(),
  cooldownReason: z.string().optional(),
  fingerprint: z.record(z.string(), z.unknown()).optional(),
})

const AccountInfo = z.discriminatedUnion("type", [ApiAccount, SubscriptionAccount])
type AccountInfo = z.infer<typeof AccountInfo>

const FamilyData = z.object({
  activeAccount: z.string().optional(),
  accounts: z.record(z.string(), AccountInfo),
})
type FamilyData = z.infer<typeof FamilyData>

const AccountStorage = z.object({
  version: z.number(),
  families: z.record(z.string(), FamilyData),
})
type AccountStorage = z.infer<typeof AccountStorage>

type AccountOption = {
  accountId: string
  family: string
  type: "api" | "subscription"
}

// Helper functions to read/write accounts.json directly
// Use xdg-basedir directly to avoid Global module's top-level await
const accountsFilepath = path.join(xdgData!, "opencode", "accounts.json")

function loadAccountsSync(): AccountStorage {
  try {
    // Use synchronous file reading to avoid async issues in TUI context
    const content = fs.readFileSync(accountsFilepath, "utf-8")
    const data = JSON.parse(content)
    const parsed = AccountStorage.safeParse(data)
    if (!parsed.success) {
      return { version: 1, families: {} }
    }
    return parsed.data
  } catch {
    return { version: 1, families: {} }
  }
}

function saveAccountsSync(storage: AccountStorage): void {
  try {
    // Ensure directory exists
    fs.mkdirSync(path.dirname(accountsFilepath), { recursive: true })
    fs.writeFileSync(accountsFilepath, JSON.stringify(storage, null, 2), { mode: 0o600 })
  } catch {
    // Ignore errors
  }
}

function setActiveAccountSync(family: string, accountId: string): void {
  const storage = loadAccountsSync()
  if (!storage.families[family]?.accounts[accountId]) {
    throw new Error(`Account not found: ${family}/${accountId}`)
  }
  storage.families[family].activeAccount = accountId
  saveAccountsSync(storage)
}

function removeAccountSync(family: string, accountId: string): void {
  const storage = loadAccountsSync()
  if (!storage.families[family]?.accounts[accountId]) {
    return
  }
  delete storage.families[family].accounts[accountId]
  // If we removed the active account, pick another
  if (storage.families[family].activeAccount === accountId) {
    const remaining = Object.keys(storage.families[family].accounts)
    storage.families[family].activeAccount = remaining[0]
  }
  saveAccountsSync(storage)
}


export function DialogAccount() {
  const sync = useSync()
  const dialog = useDialog()
  const keybind = useKeybind()
  const { theme } = useTheme()
  const toast = useToast()
  const sdk = useSDK()

  // Load accounts synchronously to avoid async issues in TUI context
  const getAccounts = () => {
    try {
      const storage = loadAccountsSync()

      const result: Array<{
        accountId: string
        family: string
        info: AccountInfo
        isActive: boolean
      }> = []

      for (const [family, familyData] of Object.entries(storage.families)) {
        const activeId = familyData.activeAccount
        for (const [accountId, info] of Object.entries(familyData.accounts)) {
          result.push({
            accountId,
            family,
            info,
            isActive: accountId === activeId,
          })
        }
      }

      return result
    } catch (e) {
      console.error("Failed to load accounts:", e)
      return []
    }
  }

  const getAccountStatus = (info: AccountInfo): { icon: string; color: any; text: string } | null => {
    if (info.type === "subscription") {
      // Check for cooling down (rate limited)
      if (info.coolingDownUntil && info.coolingDownUntil > Date.now()) {
        const remaining = Math.ceil((info.coolingDownUntil - Date.now()) / 1000 / 60)
        return { icon: "⏳", color: theme.warning, text: `Rate limited (${remaining}m)` }
      }
      // Check for quota issues via cooldownReason
      if (info.cooldownReason?.includes("quota")) {
        return { icon: "💰", color: theme.error, text: "Quota exceeded" }
      }
    }
    return null
  }

  const options = createMemo(() => {
    const accountList = getAccounts()
    if (!accountList || accountList.length === 0) return []

    const result: DialogSelectOption<AccountOption>[] = []

    // Group by family and type
    const familyOrder: Record<string, string> = {
      antigravity: "Antigravity",
      "gemini-cli": "Gemini CLI",
      google: "Google",
      openai: "OpenAI",
      anthropic: "Anthropic",
    }

    for (const family of Object.keys(familyOrder)) {
      const familyAccounts = accountList.filter((a) => a.family === family)
      if (familyAccounts.length === 0) continue

      // Sort: active first, then by type (subscription before api), then by name
      const sorted = familyAccounts.sort((a, b) => {
        if (a.isActive && !b.isActive) return -1
        if (!a.isActive && b.isActive) return 1
        if (a.info.type === "subscription" && b.info.type === "api") return -1
        if (a.info.type === "api" && b.info.type === "subscription") return 1
        return a.info.name.localeCompare(b.info.name)
      })

      for (const account of sorted) {
        const typeLabel = account.info.type === "api" ? "API Key" : "Subscription"
        const familyName = familyOrder[family] || (family.charAt(0).toUpperCase() + family.slice(1))
        const categoryLabel = `${familyName} (${typeLabel})`
        const status = getAccountStatus(account.info)

        let displayName = account.info.name
        let description: string | undefined

        const tokenEmail = (account.info.type === "subscription" && account.info.accessToken)
          ? JWT.getEmail(account.info.accessToken)
          : undefined

        if (tokenEmail && (JWT.isUUID(displayName) || displayName === account.accountId)) {
          displayName = tokenEmail
        }

        if (account.info.type === "subscription") {
          const email = tokenEmail || (account.info.email && !JWT.isUUID(account.info.email) ? account.info.email : undefined)
          const targetDescription = email || account.info.projectId || account.info.accountId
          if (targetDescription && targetDescription !== displayName) {
            description = targetDescription
          }
        }
        // Append status text if any
        if (status) {
          description = description ? `${description} ${status.icon} ${status.text}` : `${status.icon} ${status.text}`
        }

        result.push({
          value: {
            accountId: account.accountId,
            family: account.family,
            type: account.info.type,
          },
          title: displayName,
          description,
          category: categoryLabel,
          footer: account.isActive ? "Active" : undefined,
          gutter: account.isActive ? (
            <text fg={theme.success}>●</text>
          ) : status ? (
            <text fg={status.color}>{status.icon}</text>
          ) : undefined,
          onSelect: async () => {
            setActiveAccountSync(account.family, account.accountId)
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

  const handleDelete = async (option: DialogSelectOption<AccountOption>) => {
    const selected = option.value

    const account = getAccounts().find((a) => a.accountId === selected.accountId)
    if (!account) return

    const confirmed = await DialogConfirm.show(
      dialog,
      "Delete Account",
      `Are you sure you want to delete "${account.info.name}"?`
    )

    if (confirmed) {
      removeAccountSync(selected.family, selected.accountId)
      toast.show({ message: `Deleted ${account.info.name}`, variant: "info" })
      // Reload provider state
      await sdk.client.instance.dispose()
      await sync.bootstrap()
    }
    // Re-show the account dialog
    dialog.replace(() => <DialogAccount />)
  }

  const handleReauth = async (option: DialogSelectOption<AccountOption>) => {
    const selected = option.value

    // Only subscription accounts can be re-authenticated
    if (selected.type !== "subscription") {
      toast.show({ message: "API keys don't require re-authentication", variant: "warning" })
      return
    }

    const account = getAccounts().find((a) => a.accountId === selected.accountId)
    if (!account) return

    toast.show({ message: `Opening browser for ${selected.family} login...`, variant: "info" })
    dialog.clear()

    try {
      // Call the auth login endpoint
      const response = await fetch(`http://localhost:4096/auth/${selected.family}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })

      const result = await response.json() as { success: boolean; error?: string }

      if (result.success) {
        toast.show({ message: "Re-authentication successful!", variant: "success" })
        // Reload provider state
        await sdk.client.instance.dispose()
        await sync.bootstrap()
      } else {
        toast.show({ message: result.error || "Re-authentication failed", variant: "error" })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.show({ message: `Re-authentication failed: ${message}`, variant: "error" })
    }
  }

  return (
    <DialogSelect
      title="Manage Accounts"
      options={options()}
      current={undefined}
      keybind={[
        {
          keybind: keybind.all.model_provider_list,
          title: "Add",
          onTrigger: () => {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          keybind: { name: "r", ctrl: false, meta: false, shift: false, super: false, leader: false },
          title: "Re-auth",
          onTrigger: handleReauth,
        },
        {
          keybind: [
            ...(keybind.all.session_delete ?? []),
            { name: "delete", ctrl: false, meta: false, shift: false, super: false, leader: false },
          ],
          title: "Delete",
          onTrigger: handleDelete,
        },
      ]}
    />
  )
}
