import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, createResource, For, Show, type Component } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"

type AccountInfo = {
  id: string
  family: string
  name: string
  type: "api" | "subscription" | "oauth"
  active: boolean
  email?: string
  projectId?: string
  coolingDownUntil?: number
  cooldownReason?: string
}

type AccountFamily = {
  family: string
  activeAccount?: string
  accounts: AccountInfo[]
}

const familyName = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

const cooldownLabel = (account: AccountInfo, t: ReturnType<typeof useLanguage>["t"]) => {
  if (!account.coolingDownUntil) return
  if (account.coolingDownUntil <= Date.now()) return
  const leftMin = Math.max(1, Math.ceil((account.coolingDownUntil - Date.now()) / 1000 / 60))
  return account.cooldownReason
    ? `${account.cooldownReason} (${leftMin}m)`
    : t("settings.accounts.cooldown", { minutes: leftMin })
}

const toFamilies = (input: unknown): AccountFamily[] => {
  const familiesRecord = input as { families?: unknown } | undefined
  const map = familiesRecord?.families
  if (!map || typeof map !== "object") return []

  const list: AccountFamily[] = []
  for (const [family, dataValue] of Object.entries(map as Record<string, unknown>)) {
    const data = dataValue as Record<string, unknown>
    const activeAccount = typeof data?.activeAccount === "string" ? data.activeAccount : undefined
    const accounts = data?.accounts && typeof data.accounts === "object" ? data.accounts : {}
    const normalized: AccountInfo[] = Object.entries(accounts)
      .map(([id, rawValue]) => {
        const raw = rawValue as Record<string, unknown>
        const type = raw && typeof raw.type === "string" ? raw.type : "api"
        const accountType: AccountInfo["type"] =
          type === "subscription" || type === "oauth" || type === "api" ? type : "api"
        return {
          id,
          family,
          name: typeof raw?.name === "string" && raw.name.length > 0 ? raw.name : id,
          type: accountType,
          active: activeAccount === id,
          email: typeof raw?.email === "string" ? raw.email : undefined,
          projectId: typeof raw?.projectId === "string" ? raw.projectId : undefined,
          coolingDownUntil: typeof raw?.coolingDownUntil === "number" ? raw.coolingDownUntil : undefined,
          cooldownReason: typeof raw?.cooldownReason === "string" ? raw.cooldownReason : undefined,
        }
      })
      .sort((a, b) => {
        if (a.active && !b.active) return -1
        if (!a.active && b.active) return 1
        return a.name.localeCompare(b.name)
      })

    list.push({
      family,
      activeAccount,
      accounts: normalized,
    })
  }

  return list.sort((a, b) => a.family.localeCompare(b.family))
}

export const SettingsAccounts: Component = () => {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()

  const labelForType = (type: AccountInfo["type"]) => {
    if (type === "subscription") return language.t("settings.accounts.type.subscription")
    if (type === "oauth") return language.t("settings.accounts.type.oauth")
    return language.t("settings.accounts.type.api")
  }

  const [accounts, actions] = createResource(async () => {
    const result = await globalSDK.client.account.listAll().then((x) => x.data)
    return toFamilies(result)
  })

  const setActive = async (family: string, accountId: string) => {
    await globalSDK.client.account
      .setActive({ family, accountId })
      .then(async () => {
        await globalSDK.client.global.dispose().catch(() => undefined)
        await actions.refetch()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("settings.accounts.toast.updated.title"),
          description: language.t("settings.accounts.toast.updated.description", {
            family: familyName(family),
            account: accountId,
          }),
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({
          variant: "error",
          title: language.t("settings.accounts.toast.switchFailed"),
          description: message,
        })
      })
  }

  const totalAccounts = createMemo(() =>
    (accounts.latest ?? []).reduce((sum, family) => sum + family.accounts.length, 0),
  )

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-2 pt-6 pb-6 max-w-[720px]">
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-16-medium text-text-strong">{language.t("settings.accounts.title")}</h2>
            <Button size="small" variant="secondary" onClick={() => actions.refetch()} disabled={accounts.loading}>
              {language.t("common.refresh")}
            </Button>
          </div>
          <p class="text-14-regular text-text-weak">
            {language.t("settings.accounts.summary", { count: totalAccounts() })}
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <Show
          when={!accounts.loading}
          fallback={<div class="text-14-regular text-text-weak">{language.t("settings.accounts.loading")}</div>}
        >
          <Show
            when={(accounts.latest ?? []).length > 0}
            fallback={<div class="text-14-regular text-text-weak">{language.t("settings.accounts.empty")}</div>}
          >
            <For each={accounts.latest}>
              {(group) => (
                <div class="flex flex-col gap-2">
                  <h3 class="text-14-medium text-text-strong">{familyName(group.family)}</h3>
                  <div class="bg-surface-raised-base px-4 rounded-lg">
                    <For each={group.accounts}>
                      {(account) => {
                        const cooldown = cooldownLabel(account, language.t)
                        return (
                          <div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
                            <div class="min-w-0 flex flex-col gap-0.5">
                              <div class="flex items-center gap-2">
                                <span class="text-14-medium text-text-strong truncate">{account.name}</span>
                                <span class="text-11-regular text-text-weak">{labelForType(account.type)}</span>
                                <Show when={account.active}>
                                  <span class="text-11-regular text-icon-success-base">
                                    {language.t("settings.accounts.active")}
                                  </span>
                                </Show>
                              </div>
                              <Show when={account.email || account.projectId || cooldown}>
                                <div class="text-12-regular text-text-weak truncate">
                                  {account.email || account.projectId || cooldown}
                                </div>
                              </Show>
                            </div>
                            <div class="flex-shrink-0">
                              <Button
                                size="small"
                                variant={account.active ? "ghost" : "secondary"}
                                disabled={account.active}
                                onClick={() => setActive(group.family, account.id)}
                              >
                                {account.active
                                  ? language.t("settings.accounts.active")
                                  : language.t("settings.accounts.setActive")}
                              </Button>
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
