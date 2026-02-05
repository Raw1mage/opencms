import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import fs from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { createLogger } from "./logger" // Fixed path and function

const log = createLogger("storage")

// Types needed by accounts.ts
export type ModelFamily = "claude" | "gemini"
export type HeaderStyle = "antigravity" | "gemini-cli"
export type CooldownReason = "rate-limit" | "rotation" | "initial" | "auth-failure" | "project-error" | "network-error"
export type RateLimitStateV3 = Record<string, number>

// Cache for account data
let accountCache: AccountStorageV3 | null = null

export function clearAccountCache(): void {
  accountCache = null
}

export interface AccountMetadataV3 {
  refreshToken: string
  email?: string
  projectId?: string
  managedProjectId?: string
  addedAt: number
  lastUsed: number
  enabled?: boolean // Optional for backward compatibility with tests, defaults to true
  rateLimitResetTimes?: Record<string, number>
  // Additional fields for rotation and cooling
  lastSwitchReason?: CooldownReason
  coolingDownUntil?: number
  cooldownReason?: CooldownReason
  fingerprint?: Record<string, unknown>
  fingerprintHistory?: Array<{ version: number; fingerprint: Record<string, unknown>; timestamp: number }>
}

// Type aliases for backward compatibility
export type AccountMetadata = AccountMetadataV3
export type AccountStorage = AccountStorageV3

export interface AccountStorageV3 {
  version: 3
  accounts: AccountMetadataV3[]
  activeIndex: number
  activeIndexByFamily?: {
    claude: number
    gemini: number
  }
}

export type AnyAccountStorage = { version: 1 | 2 | 3; accounts: any[] } & any

function getStoragePath(): string {
  return join(homedir(), ".config", "opencode", "antigravity-accounts.json")
}

export async function ensureGitignore(dir: string): Promise<void> {
  const gitignorePath = join(dir, ".gitignore")
  if (!existsSync(gitignorePath)) {
    await fs.writeFile(gitignorePath, "*\n", "utf-8")
  }
}

export function ensureGitignoreSync(dir: string): void {
  const gitignorePath = join(dir, ".gitignore")
  if (existsSync(gitignorePath)) return
  writeFileSync(gitignorePath, "*\n", "utf-8")
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  // Simple lock implementation
  return fn()
}

export function deduplicateAccountsByEmail(accounts: AccountMetadataV3[]): AccountMetadataV3[] {
  const map = new Map<string, AccountMetadataV3>()
  for (const acc of accounts) {
    const key = acc.email || acc.refreshToken
    const existing = map.get(key)
    if (!existing || acc.addedAt > existing.addedAt) {
      map.set(key, acc)
    }
  }
  return Array.from(map.values())
}

function migrateV1ToV2(v1: any): any {
  return { ...v1, version: 2 }
}

export function migrateV2ToV3(v2: any): AccountStorageV3 {
  return {
    version: 3,
    accounts: (v2.accounts || []).map((a: any) => ({
      refreshToken: a.refreshToken || a.token,
      email: a.email,
      addedAt: a.addedAt || Date.now(),
      lastUsed: a.lastUsed || 0,
      enabled: true,
    })),
    activeIndex: v2.activeIndex || 0,
  }
}

function mergeAccountStorage(
  existing: AccountStorageV3,
  incoming: AccountStorageV3,
  overwriteAccounts = false,
): AccountStorageV3 {
  if (overwriteAccounts) {
    return {
      version: 3,
      accounts: incoming.accounts,
      activeIndex: incoming.activeIndex,
      activeIndexByFamily: incoming.activeIndexByFamily ?? existing.activeIndexByFamily,
    }
  }

  const accountMap = new Map<string, AccountMetadataV3>()

  for (const acc of existing.accounts) {
    if (acc.refreshToken) {
      accountMap.set(acc.refreshToken, acc)
    }
  }

  for (const acc of incoming.accounts) {
    if (acc.refreshToken) {
      const existingAcc = accountMap.get(acc.refreshToken)
      if (existingAcc) {
        accountMap.set(acc.refreshToken, {
          ...existingAcc,
          ...acc,
          projectId: acc.projectId ?? existingAcc.projectId,
          managedProjectId: acc.managedProjectId ?? existingAcc.managedProjectId,
          rateLimitResetTimes: {
            ...existingAcc.rateLimitResetTimes,
            ...acc.rateLimitResetTimes,
          },
          lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
        })
      } else {
        accountMap.set(acc.refreshToken, acc)
      }
    }
  }

  return {
    version: 3,
    accounts: Array.from(accountMap.values()),
    activeIndex: incoming.activeIndex,
    activeIndexByFamily: incoming.activeIndexByFamily ?? existing.activeIndexByFamily,
  }
}

/**
 * @deprecated Use Account.list("antigravity") from src/account/index.ts instead.
 * This function is kept for backward compatibility with tests.
 */
export async function loadAccounts(): Promise<AccountStorageV3 | null> {
  try {
    const path = getStoragePath()
    let data: AnyAccountStorage

    if (existsSync(path)) {
      const content = await fs.readFile(path, "utf-8")
      data = JSON.parse(content) as AnyAccountStorage
    } else {
      data = { version: 3, accounts: [], activeIndex: 0 }
    }

    // SYNC FROM CORE (Conditional)
    // We only sync from core if we're forced or if we want to ensure basic presence.
    // However, resyncing every load causes "deleted accounts coming back" if not careful.
    // Fixed: We will TRUST accounts.json as the source of TRUTH for which accounts exist.
    try {
      const mainAccountsPath = join(homedir(), ".opencode", "accounts.json")
      if (existsSync(mainAccountsPath)) {
        const mainContent = readFileSync(mainAccountsPath, "utf-8")
        const mainData = JSON.parse(mainContent)
        const agFamily = mainData.families?.antigravity

        if (agFamily && agFamily.accounts) {
          const incomingAccounts: AccountMetadataV3[] = Object.entries(agFamily.accounts)
            .map(([id, acc]: [string, any]) => ({
              refreshToken: acc.refreshToken,
              email: acc.email,
              projectId: acc.projectId,
              managedProjectId: acc.managedProjectId,
              addedAt: acc.addedAt || Date.now(),
              lastUsed: acc.lastUsed || 0,
              enabled: true,
              rateLimitResetTimes: acc.rateLimitResetTimes,
            }))
            .filter((a) => !!a.refreshToken)

          // We filter our local accounts to ONLY those that still exist in core
          // or have been manually added/persistent.
          // BUT simpler: We use incomingAccounts as the baseline.
          const existingMap = new Map(data.accounts.map((a: any) => [a.refreshToken, a]))
          const syncedAccounts = incomingAccounts.map((incoming) => {
            const existing = existingMap.get(incoming.refreshToken)
            return existing ? { ...existing, ...incoming } : incoming
          })

          let activeIndex = data.activeIndex ?? 0
          if (agFamily.activeAccount) {
            const agActive = agFamily.activeAccount

            // Method 1: Look up the active account's data from core and match by refreshToken
            const activeAccData = agFamily.accounts[agActive]
            if (activeAccData?.refreshToken) {
              const foundIndex = syncedAccounts.findIndex((a) => a.refreshToken === activeAccData.refreshToken)
              if (foundIndex !== -1) {
                activeIndex = foundIndex
              }
            } else {
              // Method 2: Try to match by email slug in the ID (e.g., "antigravity-subscription-user-gmail-com")
              const emailSlugMatch = agActive.match(/antigravity-subscription-(.+)/)
              if (emailSlugMatch) {
                const slug = emailSlugMatch[1]
                // Try numeric ID first (e.g., "2" -> index 1)
                const numericIndex = parseInt(slug, 10)
                if (!isNaN(numericIndex) && numericIndex >= 1) {
                  const idx = numericIndex - 1
                  if (idx >= 0 && idx < syncedAccounts.length) {
                    activeIndex = idx
                  }
                } else {
                  // Try matching by email slug
                  const foundIndex = syncedAccounts.findIndex((a) => {
                    if (!a.email) return false
                    const accountSlug = a.email.toLowerCase().replace(/@/g, "-").replace(/\./g, "-")
                    return accountSlug === slug || slug.includes(accountSlug)
                  })
                  if (foundIndex !== -1) {
                    activeIndex = foundIndex
                  }
                }
              }
            }
          }

          data.accounts = syncedAccounts
          data.activeIndex = activeIndex
          // Also update activeIndexByFamily to match the synced activeIndex
          data.activeIndexByFamily = {
            claude: activeIndex,
            gemini: activeIndex,
          }
        }
      }
    } catch (e) {
      log.warn("Failed to sync from main accounts.json", { error: String(e) })
    }

    let storage: AccountStorageV3
    if (data.version === 1) {
      storage = migrateV2ToV3(migrateV1ToV2(data))
    } else if (data.version === 2) {
      storage = migrateV2ToV3(data)
    } else {
      storage = data
    }

    const deduplicated = deduplicateAccountsByEmail(storage.accounts)
    const activeIndex = Math.max(0, Math.min(storage.activeIndex || 0, deduplicated.length - 1))

    return {
      version: 3,
      accounts: deduplicated,
      activeIndex,
      activeIndexByFamily: storage.activeIndexByFamily || { claude: activeIndex, gemini: activeIndex },
    }
  } catch (error) {
    log.error("Failed to load account storage", { error: String(error) })
    return null
  }
}

/**
 * @deprecated Use Account.update() from src/account/index.ts instead.
 * This function is kept for backward compatibility with tests.
 */
export async function saveAccounts(storage: AccountStorageV3, overwrite = false): Promise<void> {
  const path = getStoragePath()
  const configDir = dirname(path)
  await fs.mkdir(configDir, { recursive: true })
  await ensureGitignore(configDir)

  await withFileLock(path, async () => {
    const existing = await loadAccountsUnsafe()
    const merged = existing && !overwrite ? mergeAccountStorage(existing, storage, false) : storage

    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`
    const content = JSON.stringify(merged, null, 2)

    try {
      await fs.writeFile(tempPath, content, "utf-8")
      await fs.rename(tempPath, path)
    } catch (error) {
      try {
        await fs.unlink(tempPath)
      } catch {}
      throw error
    }
  })
}

async function loadAccountsUnsafe(): Promise<AccountStorageV3 | null> {
  try {
    const path = getStoragePath()
    if (!existsSync(path)) return null
    const content = await fs.readFile(path, "utf-8")
    const parsed = JSON.parse(content)
    return parsed
  } catch {
    return null
  }
}

export async function clearAccounts(): Promise<void> {
  try {
    const path = getStoragePath()
    if (existsSync(path)) await fs.unlink(path)
  } catch {}
}
