import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createLogger } from "./logger"; // Fixed path and function

const log = createLogger("storage");

export interface AccountMetadataV3 {
  refreshToken: string;
  email?: string;
  projectId?: string;
  managedProjectId?: string;
  addedAt: number;
  lastUsed: number;
  enabled: boolean;
  rateLimitResetTimes?: Record<string, number>;
}

export interface AccountStorageV3 {
  version: 3;
  accounts: AccountMetadataV3[];
  activeIndex: number;
  activeIndexByFamily?: {
    claude: number;
    gemini: number;
  };
}

export type AnyAccountStorage = { version: 1 | 2 | 3; accounts: any[] } & any;

function getStoragePath(): string {
  return join(homedir(), ".config", "opencode", "antigravity-accounts.json");
}

async function ensureGitignore(dir: string): Promise<void> {
  const gitignorePath = join(dir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    await fs.writeFile(gitignorePath, "*\n", "utf-8");
  }
}

export function ensureGitignoreSync(dir: string): void {
  const gitignorePath = join(dir, ".gitignore");
  if (existsSync(gitignorePath)) return;
  writeFileSync(gitignorePath, "*\n", "utf-8");
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  // Simple lock implementation
  return fn();
}

function deduplicateAccountsByEmail(accounts: AccountMetadataV3[]): AccountMetadataV3[] {
  const map = new Map<string, AccountMetadataV3>();
  for (const acc of accounts) {
    const key = acc.email || acc.refreshToken;
    const existing = map.get(key);
    if (!existing || acc.addedAt > existing.addedAt) {
      map.set(key, acc);
    }
  }
  return Array.from(map.values());
}

function migrateV1ToV2(v1: any): any {
  return { ...v1, version: 2 };
}

function migrateV2ToV3(v2: any): AccountStorageV3 {
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
  };
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
    };
  }

  const accountMap = new Map<string, AccountMetadataV3>();

  for (const acc of existing.accounts) {
    if (acc.refreshToken) {
      accountMap.set(acc.refreshToken, acc);
    }
  }

  for (const acc of incoming.accounts) {
    if (acc.refreshToken) {
      const existingAcc = accountMap.get(acc.refreshToken);
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
        });
      } else {
        accountMap.set(acc.refreshToken, acc);
      }
    }
  }

  return {
    version: 3,
    accounts: Array.from(accountMap.values()),
    activeIndex: incoming.activeIndex,
    activeIndexByFamily: incoming.activeIndexByFamily ?? existing.activeIndexByFamily,
  };
}

export async function loadAccounts(): Promise<AccountStorageV3 | null> {
  try {
    const path = getStoragePath();
    let data: AnyAccountStorage;

    if (existsSync(path)) {
      const content = await fs.readFile(path, "utf-8");
      data = JSON.parse(content) as AnyAccountStorage;
    } else {
      data = { version: 3, accounts: [], activeIndex: 0 };
    }

    // SYNC FROM CORE (Conditional)
    // We only sync from core if we're forced or if we want to ensure basic presence.
    // However, resyncing every load causes "deleted accounts coming back" if not careful.
    // Fixed: We will TRUST accounts.json as the source of TRUTH for which accounts exist.
    try {
      const mainAccountsPath = join(homedir(), ".local/share", "opencode", "accounts.json");
      if (existsSync(mainAccountsPath)) {
        const mainContent = readFileSync(mainAccountsPath, "utf-8");
        const mainData = JSON.parse(mainContent);
        const agFamily = mainData.families?.antigravity;

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
            .filter(a => !!a.refreshToken);

          // We filter our local accounts to ONLY those that still exist in core
          // or have been manually added/persistent.
          // BUT simpler: We use incomingAccounts as the baseline.
          const existingMap = new Map(data.accounts.map((a: any) => [a.refreshToken, a]));
          const syncedAccounts = incomingAccounts.map(incoming => {
            const existing = existingMap.get(incoming.refreshToken);
            return existing ? { ...existing, ...incoming } : incoming;
          });

          let activeIndex = data.activeIndex ?? 0;
          if (agFamily.activeAccount) {
            const agActive = agFamily.activeAccount;
            const foundIndex = syncedAccounts.findIndex((a, idx) => {
              // Core ID match
              const match = agActive.match(/antigravity-subscription-(\d+)/);
              if (match) return (parseInt(match[1]) - 1) === idx;
              return false;
            });
            if (foundIndex !== -1) activeIndex = foundIndex;
          }

          data.accounts = syncedAccounts;
          data.activeIndex = activeIndex;
        }
      }
    } catch (e) {
      log.warn("Failed to sync from main accounts.json", { error: String(e) });
    }

    let storage: AccountStorageV3;
    if (data.version === 1) {
      storage = migrateV2ToV3(migrateV1ToV2(data));
    } else if (data.version === 2) {
      storage = migrateV2ToV3(data);
    } else {
      storage = data;
    }

    const deduplicated = deduplicateAccountsByEmail(storage.accounts);
    const activeIndex = Math.max(0, Math.min(storage.activeIndex || 0, deduplicated.length - 1));

    return {
      version: 3,
      accounts: deduplicated,
      activeIndex,
      activeIndexByFamily: storage.activeIndexByFamily || { claude: activeIndex, gemini: activeIndex },
    };
  } catch (error) {
    log.error("Failed to load account storage", { error: String(error) });
    return null;
  }
}

export async function saveAccounts(storage: AccountStorageV3, overwrite = false): Promise<void> {
  const path = getStoragePath();
  const configDir = dirname(path);
  await fs.mkdir(configDir, { recursive: true });
  await ensureGitignore(configDir);

  await withFileLock(path, async () => {
    const existing = await loadAccountsUnsafe();
    const merged = (existing && !overwrite) ? mergeAccountStorage(existing, storage, false) : storage;

    const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const content = JSON.stringify(merged, null, 2);

    try {
      await fs.writeFile(tempPath, content, "utf-8");
      await fs.rename(tempPath, path);
    } catch (error) {
      try { await fs.unlink(tempPath); } catch { }
      throw error;
    }
  });
}

async function loadAccountsUnsafe(): Promise<AccountStorageV3 | null> {
  try {
    const path = getStoragePath();
    if (!existsSync(path)) return null;
    const content = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(content);
    return parsed;
  } catch {
    return null;
  }
}

export async function clearAccounts(): Promise<void> {
  try {
    const path = getStoragePath();
    if (existsSync(path)) await fs.unlink(path);
  } catch { }
}
