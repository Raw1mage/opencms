import { SEARCH_MODEL } from "../src/plugin/antigravity/constants"
import { AccountManager } from "../src/plugin/antigravity/plugin/accounts"
import { accessTokenExpired } from "../src/plugin/antigravity/plugin/auth"
import { ensureProjectContext } from "../src/plugin/antigravity/plugin/project"
import { refreshAccessToken } from "../src/plugin/antigravity/plugin/token"
import type { PluginClient } from "../src/plugin/antigravity/plugin/types"
import { executeSearch } from "../src/plugin/antigravity/plugin/search"
import { loadConfig } from "../src/plugin/antigravity/plugin/config"
import { debugCheckpoint } from "../src/util/debug"

const args = process.argv.slice(2)
const query = args[0] ?? "OpenCode google_search smoke test"
const urls = args.slice(1)

const config = loadConfig(process.cwd())
const accountManager = await AccountManager.loadFromDisk()
await accountManager.reloadFromAccountModule()

const accountCount = accountManager.getAccountCount()
if (accountCount === 0) {
  console.error("No Antigravity accounts configured.")
  process.exitCode = 1
}

let lastError: Error | null = null

for (let attempt = 0; attempt < accountCount; attempt += 1) {
  const account = accountManager.getCurrentOrNextForFamily(
    "gemini",
    SEARCH_MODEL,
    config.account_selection_strategy,
    "antigravity",
    config.pid_offset_enabled,
  )

  if (!account) {
    lastError = new Error("No available Antigravity accounts")
    break
  }

  let authRecord = accountManager.toAuthDetails(account)
  if (accessTokenExpired(authRecord)) {
    debugCheckpoint("google_search", "smoke: access token expired, refreshing", { accountIndex: account.index })
    const client = {
      auth: {
        set: async () => ({ data: null, error: null }),
      },
    } as unknown as PluginClient
    const refreshed = await refreshAccessToken(authRecord, client, "antigravity").catch((error) => {
      lastError = error instanceof Error ? error : new Error(String(error))
      return undefined
    })

    if (!refreshed) {
      debugCheckpoint("google_search", "smoke: refresh failed", { accountIndex: account.index })
      continue
    }

    accountManager.updateFromAuth(account, refreshed)
    accountManager.requestSaveToDisk()
    await accountManager.flushSaveToDisk()
    authRecord = refreshed
  }

  const accessToken = authRecord.access
  if (!accessToken) {
    lastError = new Error("Missing access token")
    debugCheckpoint("google_search", "smoke: missing access token", { accountIndex: account.index })
    continue
  }

  const projectContext = await ensureProjectContext(authRecord).catch((error) => {
    lastError = error instanceof Error ? error : new Error(String(error))
    debugCheckpoint("google_search", "smoke: project context error", {
      accountIndex: account.index,
      error: String(error),
    })
    return undefined
  })

  if (!projectContext) {
    continue
  }

  if (projectContext.auth !== authRecord) {
    accountManager.updateFromAuth(account, projectContext.auth)
    accountManager.requestSaveToDisk()
    await accountManager.flushSaveToDisk()
    authRecord = projectContext.auth
  }

  const projectId = projectContext.effectiveProjectId
  if (!projectId) {
    lastError = new Error("Missing project ID")
    debugCheckpoint("google_search", "smoke: missing project id", { accountIndex: account.index })
    continue
  }

  debugCheckpoint("google_search", "smoke: execute search", { accountIndex: account.index, projectId })
  const result = await executeSearch(
    {
      query,
      urls: urls.length > 0 ? urls : undefined,
      thinking: true,
    },
    accessToken,
    projectId,
  )

  if (result.ok) {
    console.log(result.output)
    process.exitCode = 0
    break
  }

  lastError = new Error(result.error ?? "Search failed")
  debugCheckpoint("google_search", "smoke: search failed", { accountIndex: account.index, error: result.error })
}

if (lastError) {
  console.error(lastError.message)
  process.exitCode = 1
}
