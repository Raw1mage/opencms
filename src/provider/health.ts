import { Provider } from "./provider"
import { generateText, streamText } from "ai"
import { Log } from "@/util/log"
import { withTimeout } from "@/util/timeout"
import { Auth } from "../auth"
import { Account } from "../account"
import { JWT } from "@/util/jwt"

export namespace ProviderHealth {
  const log = Log.create({ service: "provider-health" })

  /**
   * Model health status types
   */
  export type ModelStatus =
    | "AVAILABLE" // ✅ Model is working and available
    | "RATE_LIMITED" // ⏳ Authenticated but rate limit exceeded
    | "QUOTA_EXCEEDED" // 💰 Quota/billing limit exceeded
    | "AUTH_ERROR" // 🔑 Authentication failed
    | "TIMEOUT" // ⏱️ Request timed out
    | "NETWORK_ERROR" // 🌐 Network connection failed
    | "MODEL_NOT_FOUND" // ❓ Model does not exist
    | "UNKNOWN_ERROR" // ❌ Unknown error occurred
    | "NO_AUTH" // 🔐 No authentication configured

  /**
   * Model detail for account status
   */
  export type ModelDetail = {
    modelID: string
    name: string
    status: ModelStatus
    responseTime?: number
    error?: string
  }

  /**
   * Account authentication status
   */
  export type AccountStatus = {
    accountID: string // e.g. "google-api", "google-api-work", "antigravity"
    providerFamily: string // e.g. "google-api", "openai", "anthropic"
    authType: "oauth" | "api" | "wellknown" | "antigravity" | "none"
    authenticated: boolean
    accountEmail?: string
    accountName?: string
    modelsWorking: number // Number of models that successfully tested
    modelsTotal: number // Total number of models for this account
    models: ModelDetail[] // Detailed list of models for this account
    lastChecked: string
  }

  /**
   * Detailed health information for a single model
   */
  export type ModelHealthInfo = {
    providerID: string
    modelID: string
    fullID: string // "provider/model"
    name?: string // Friendly name from config
    status: ModelStatus
    available: boolean // Whether model is currently usable
    responseTime?: number // Response time in milliseconds
    error?: string // Error message if not available
    retryAfter?: number // Seconds to wait before retry (for rate limits)
    timestamp: string // ISO timestamp of check
    capabilities?: {
      context: number
      output: number
      modalities?: string[]
    }
  }

  /**
   * Comprehensive health report for all models
   */
  export type HealthReport = {
    timestamp: string
    totalModels: number
    availableModels: ModelHealthInfo[]
    unavailableModels: ModelHealthInfo[]
    accounts: AccountStatus[] // Authentication status for all accounts
    summary: {
      available: number
      rateLimited: number
      quotaExceeded: number
      authError: number
      noAuth: number
      other: number
      accountsAuthenticated: number
      accountsTotal: number
    }
  }

  /**
   * Options for health check
   */
  export type CheckOptions = {
    timeout?: number // Timeout in milliseconds (default: 10000)
    mode?: "perception" | "full"
    providers?: Record<string, Provider.Info> // Optional cached providers list
  }

  /**
   * Options for checking all models
   */
  export type CheckAllOptions = {
    timeout?: number // Timeout per model in milliseconds (default: 10000)
    parallel?: boolean // Check models in parallel (default: false)
    providers?: string[] // Filter by specific provider IDs (default: all)
    mode?: "perception" | "full" // Check mode: 'perception' (auth only) or 'full' (with testing)
  }

  /**
   * In-memory state of model health for dynamic tracking
   */
  const modelState: Record<
    string,
    {
      status: ModelStatus
      retryAfter?: number
      timestamp: number
      error?: string
    }
  > = {}

  /**
   * Update the dynamic health state of a model
   */
  export function updateStatus(
    providerID: string,
    modelID: string,
    status: ModelStatus,
    retryAfter?: number,
    error?: string,
  ) {
    const fullID = `${providerID}/${modelID}`
    modelState[fullID] = {
      status,
      retryAfter,
      timestamp: Date.now(),
      error,
    }
  }

  /**
   * Get the current dynamic status of a model
   * Returns "AVAILABLE" if no state is recorded
   */
  export function getStatus(providerID: string, modelID: string): ModelStatus {
    const fullID = `${providerID}/${modelID}`
    const state = modelState[fullID]
    if (!state) return "AVAILABLE"

    // Check if rate limit has expired
    if (state.status === "RATE_LIMITED" && state.retryAfter) {
      const now = Date.now()
      const expiry = state.timestamp + state.retryAfter * 1000
      if (now > expiry) return "AVAILABLE"
    }

    return state.status
  }

  /**
   * Check health of a single model by sending a minimal test request
   */
  export async function checkModel(
    providerID: string,
    modelID: string,
    options: CheckOptions = {},
  ): Promise<ModelHealthInfo> {
    const timeout = options.timeout || 10000
    const fullID = `${providerID}/${modelID}`
    const startTime = Date.now()
    let controller: AbortController | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    // [REMOVED legacy rate limit check that was causing account collision and missing response times]

    // Check Legacy Status (In-memory)
    const currentStatus = getStatus(providerID, modelID)
    if (currentStatus !== "AVAILABLE") {
      // Still return the cached state if we explicitly marked it as non-available recently
      // but only if NO_AUTH or similar terminal states. For RATE_LIMITED we might want to re-verify.
      if (currentStatus !== "RATE_LIMITED") {
        return {
          providerID,
          modelID,
          fullID,
          status: currentStatus,
          available: false,
          timestamp: new Date().toISOString(),
        }
      }
    }

    log.info("checking model", { providerID, modelID, timeout, mode: options.mode })

    try {
      // Use provided providers list or load it
      const providers = options.providers || (await Provider.list())
      const provider = providers[providerID]
      if (!provider) {
        throw new Error(`Provider not found: ${providerID}`)
      }
      const modelConfig = provider?.models[modelID]

      if (!provider || !modelConfig) {
        log.warn("model not found in config", { providerID, modelID })
        updateStatus(providerID, modelID, "MODEL_NOT_FOUND", undefined, "Model not found in configuration")
        return {
          providerID,
          modelID,
          fullID,
          status: "MODEL_NOT_FOUND",
          available: false,
          error: "Model not found in configuration",
          timestamp: new Date().toISOString(),
        }
      }

      // Helper to get modality labels
      const getModalities = (input: any) => {
        const modalities: string[] = []
        if (input.text) modalities.push("text")
        if (input.image) modalities.push("image")
        if (input.pdf) modalities.push("pdf")
        if (input.audio) modalities.push("audio")
        if (input.video) modalities.push("video")
        return modalities
      }

      // Get the actual model language instance
      const language = await Provider.getLanguage(modelConfig)

      // Skip if it's an embedding model (which will always fail streamText)
      if (modelID.includes("embedding") || modelConfig.family?.includes("embedding")) {
        return {
          providerID,
          modelID,
          fullID,
          status: "UNKNOWN_ERROR",
          available: false,
          error: "Skipping: Embedding models not supported for chat health check",
          timestamp: new Date().toISOString(),
        }
      }

      // Create abort controller for timeout
      controller = new AbortController()
      timeoutId = setTimeout(() => controller!.abort(), timeout)

      // Perception mode: Skip the actual test request if authentication is valid
      if (options.mode === "perception") {
        const responseTime = Date.now() - startTime
        updateStatus(providerID, modelID, "AVAILABLE")
        return {
          providerID,
          modelID,
          fullID,
          name: modelConfig.name || modelID,
          status: "AVAILABLE",
          available: true,
          responseTime,
          timestamp: new Date().toISOString(),
          capabilities: {
            context: modelConfig.limit?.context || 0,
            output: modelConfig.limit?.output || 0,
            modalities: getModalities(modelConfig.capabilities.input),
          },
        }
      }

      // Send minimal test request using generateText for higher reliability in heartbeat checks
      const doCheck = async () => {
        const options: any = {
          model: language,
          prompt: "Return a JSON object with status ok",
          abortSignal: controller!.signal,
          maxRetries: 0, // Fail fast, do not retry
        }

        if (providerID === "openai" || modelID.includes("gpt-5")) {
          options.responseFormat = { type: "json" }
        }

        // Suppress console errors during health check
        const originalConsoleError = console.error
        try {
          console.error = () => {} // Silence errors
          const result = streamText(options)

          // Consume at least one chunk to verify aliveness
          for await (const _ of result.textStream) {
            return // Alive
          }
        } finally {
          console.error = originalConsoleError
        }
      }

      await withTimeout(doCheck(), timeout)

      const responseTime = Date.now() - startTime

      updateStatus(providerID, modelID, "AVAILABLE")
      return {
        providerID,
        modelID,
        fullID,
        name: modelConfig.name,
        status: "AVAILABLE",
        available: true,
        responseTime,
        timestamp: new Date().toISOString(),
        capabilities: {
          context: modelConfig.limit?.context || 0,
          output: modelConfig.limit?.output || 0,
          modalities: getModalities(modelConfig.capabilities.input),
        },
      }
    } catch (error) {
      const responseTime = Date.now() - startTime
      const classification = classifyError(error, providerID, modelID)

      // SILENT: Don't spray the full error object to stderr anymore
      log.warn(`Check failed: ${fullID} -> ${classification.status}`)
      updateStatus(providerID, modelID, classification.status, classification.retryAfter, classification.error)

      // Try to get model config for capabilities using provided providers list
      const providers = options.providers || (await Provider.list())
      const modelConfig = providers[providerID]?.models[modelID]

      return {
        providerID,
        modelID,
        fullID,
        name: modelConfig?.name || modelID,
        status: classification.status,
        available: false,
        error: classification.error,
        retryAfter: classification.retryAfter,
        responseTime,
        timestamp: new Date().toISOString(),
        capabilities: modelConfig
          ? {
              context: modelConfig.limit?.context || 0,
              output: modelConfig.limit?.output || 0,
              modalities: (() => {
                const input = modelConfig.capabilities.input
                const modalities: string[] = []
                if (input.text) modalities.push("text")
                if (input.image) modalities.push("image")
                if (input.pdf) modalities.push("pdf")
                if (input.audio) modalities.push("audio")
                if (input.video) modalities.push("video")
                return modalities
              })(),
            }
          : undefined,
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }

  /**
   * Classify an error into a specific ModelStatus
   */
  function classifyError(
    error: any,
    providerID: string,
    modelID: string,
  ): {
    status: ModelStatus
    error?: string
    retryAfter?: number
  } {
    const errorMessage = (error.message || "").toLowerCase()
    const errorBody = (error.responseBody || "").toLowerCase()
    const errorCode = error.statusCode || error.code
    const combined = (errorMessage + " " + errorBody).toLowerCase()

    // 1. QUOTA_EXCEEDED - Billing/quota issues (Check this before Rate Limit)
    if (
      errorCode === 402 || // Payment Required
      combined.includes("quota exceeded") ||
      combined.includes("insufficient quota") ||
      combined.includes("billing not enabled") ||
      combined.includes("exceeded your current quota") ||
      combined.includes("quota_exceeded") ||
      combined.includes("credit balance is too low") ||
      combined.includes("check your plan and billing details")
    ) {
      return {
        status: "QUOTA_EXCEEDED",
        error: "API quota exceeded - check billing settings",
      }
    }

    // Logic from SessionRetry.retryable to detect rate limits from JSON bodies
    try {
      const str = error.responseBody || error.message
      if (typeof str === "string" && (str.trim().startsWith("{") || str.trim().startsWith("["))) {
        const json = JSON.parse(str)
        if (json.type === "error" && json.error?.type === "too_many_requests") {
          const retryAfter = extractRetryAfter(error)
          return { status: "RATE_LIMITED", error: "Too Many Requests", retryAfter }
        }
        if (json.code?.includes("exhausted") || json.code?.includes("unavailable")) {
          const retryAfter = extractRetryAfter(error)
          return { status: "RATE_LIMITED", error: "Provider is overloaded", retryAfter }
        }
        if (json.type === "error" && json.error?.code?.includes("rate_limit")) {
          const retryAfter = extractRetryAfter(error)
          return { status: "RATE_LIMITED", error: "Rate Limited", retryAfter }
        }
      }
    } catch {}

    // 2. RATE_LIMITED - Authenticated but rate limit exceeded
    if (
      errorCode === 429 ||
      combined.includes("rate limit") ||
      combined.includes("too many requests") ||
      combined.includes("overloaded")
    ) {
      const retryAfter = extractRetryAfter(error)
      return {
        status: "RATE_LIMITED",
        error: retryAfter ? `Rate limit exceeded, retry after ${retryAfter}s` : "Rate limit exceeded",
        retryAfter,
      }
    }

    // 3. AUTH_ERROR - Authentication failed
    if (
      errorCode === 401 ||
      errorCode === 403 ||
      combined.includes("unauthorized") ||
      combined.includes("invalid api key") ||
      combined.includes("invalid authentication") ||
      combined.includes("api key not valid") ||
      combined.includes("authentication failed") ||
      combined.includes("invalid_api_key") ||
      combined.includes("wrong api key") ||
      combined.includes("access denied") ||
      combined.includes("permission denied")
    ) {
      return {
        status: "AUTH_ERROR",
        error: "Authentication failed - check API key configuration",
      }
    }

    // 4. TIMEOUT
    if (
      error.name === "AbortError" ||
      combined.includes("timeout") ||
      combined.includes("timed out") ||
      combined.includes("deadline exceeded")
    ) {
      return {
        status: "TIMEOUT",
        error: "TIMEOUT",
      }
    }

    // 5. NETWORK_ERROR
    if (
      combined.includes("network") ||
      combined.includes("econnrefused") ||
      combined.includes("enotfound") ||
      combined.includes("fetch failed") ||
      combined.includes("socket hang up") ||
      combined.includes("connection refused") ||
      errorCode === "ECONNREFUSED" ||
      errorCode === "ENOTFOUND" ||
      errorCode === "ETIMEDOUT"
    ) {
      return {
        status: "NETWORK_ERROR",
        error: "Network connection failed",
      }
    }

    // 6. MODEL_NOT_FOUND
    if (
      errorCode === 404 ||
      combined.includes("model not found") ||
      combined.includes("does") ||
      combined.includes("not exist") ||
      combined.includes("model_not_found") ||
      combined.includes("not found")
    ) {
      return {
        status: "MODEL_NOT_FOUND",
        error: "Model does not exist or is not accessible",
      }
    }

    // 7. UNKNOWN_ERROR - Fallback
    return {
      status: "UNKNOWN_ERROR",
      error: error.message || error.toString() || "Unknown error occurred",
    }
  }

  /**
   * Infer account authentication status from model check results
   * Uses unified Account module as single source of truth
   */
  async function inferAccountStatus(results: ModelHealthInfo[]): Promise<AccountStatus[]> {
    const providerResults = new Map<
      string,
      { success: number; total: number; errors: string[]; models: ModelDetail[] }
    >()

    // Group results by provider
    for (const result of results) {
      const existing = providerResults.get(result.providerID) || { success: 0, total: 0, errors: [], models: [] }
      existing.total++
      if (result.status === "AVAILABLE") {
        existing.success++
      } else if (result.error && result.status !== "NO_AUTH") {
        existing.errors.push(result.error)
      }

      // Add model detail
      existing.models.push({
        modelID: result.modelID,
        name: result.name || result.modelID,
        status: result.status,
        responseTime: result.responseTime,
        error: result.error,
      })

      providerResults.set(result.providerID, existing)
    }

    // Build account statuses from unified Account module only
    const accountStatuses: AccountStatus[] = []
    const unifiedAccounts = await Account.listAll()

    for (const [family, familyData] of Object.entries(unifiedAccounts)) {
      const hasSpecificAccounts = Object.keys(familyData.accounts).some(
        (id) =>
          id.includes("-subscription-") ||
          id.includes("@") ||
          (id !== family && id !== "antigravity" && id !== "gemini-cli"),
      )

      for (const [accountId, accountInfo] of Object.entries(familyData.accounts)) {
        // Filter out legacy "phantom" accounts if specific accounts exist for this family
        // These are often artifacts of migration or old provider IDs
        if (
          hasSpecificAccounts &&
          (accountId === family ||
            accountId === "antigravity" ||
            accountId === "gemini-cli" ||
            accountId === "google-api")
        ) {
          // If we have at least one better identifier, skip the generic ones
          continue
        }

        const providerStats = providerResults.get(accountId) || { success: 0, total: 0, errors: [], models: [] }
        const authenticated = providerStats.success > 0

        const status: AccountStatus = {
          accountID: accountId,
          providerFamily: family,
          authType: accountInfo.type === "api" ? "api" : "oauth",
          authenticated,
          accountEmail: (() => {
            if (accountInfo.type === "subscription") {
              if (accountInfo.email && !JWT.isUUID(accountInfo.email)) return accountInfo.email
              if (accountInfo.accessToken) {
                const email = JWT.getEmail(accountInfo.accessToken)
                if (email) return email
              }
              if (accountInfo.refreshToken) {
                const email = JWT.getEmail(accountInfo.refreshToken)
                if (email) return email
              }
            }
            const email = accountInfo.type === "subscription" ? accountInfo.email : undefined
            return email && !JWT.isUUID(email) ? email : undefined
          })(),
          accountName: accountInfo.name && !JWT.isUUID(accountInfo.name) ? accountInfo.name : undefined,
          modelsWorking: providerStats.success,
          modelsTotal: providerStats.total,
          models: providerStats.models,
          lastChecked: new Date().toISOString(),
        }

        accountStatuses.push(status)
      }
    }

    return accountStatuses
  }

  /**
   * Check health of all configured models
   * Uses unified Account module as single source of truth
   */
  export async function checkAll(options: CheckAllOptions = {}): Promise<HealthReport> {
    process.env.OPENCODE_HEALTH_CHECK = "1"
    const startTime = Date.now()
    log.info("checking all models", {
      parallel: options.parallel || false,
      providers: options.providers || "all",
    })

    try {
      // Get all providers once for performance
      const providers = await Provider.list()
      const checks: Promise<ModelHealthInfo>[] = []

      // Iterate through providers and models
      for (const [providerID, provider] of Object.entries(providers)) {
        // Filter by provider or family if specified
        if (options.providers) {
          const family = Account.parseFamily(providerID)
          if (!options.providers.includes(providerID) && (!family || !options.providers.includes(family))) {
            continue
          }
        }

        // Check if provider has authentication (Auth module handles the actual auth)
        const hasAuth = await Auth.hasAccount(providerID)

        // Check each model in the provider
        for (const modelID of Object.keys(provider.models)) {
          if (Provider.isModelIgnored(providerID, modelID)) continue
          // If no auth, mark all models as NO_AUTH
          if (!hasAuth) {
            checks.push(
              Promise.resolve({
                providerID,
                modelID,
                fullID: `${providerID}/${modelID}`,
                name: provider.models[modelID].name || modelID,
                status: "NO_AUTH" as ModelStatus,
                available: false,
                error: `No authentication configured for ${providerID}. Run: opencode auth login ${providerID}`,
                timestamp: new Date().toISOString(),
              }),
            )
            continue
          }

          const checkPromise = checkModel(providerID, modelID, {
            timeout: options.timeout,
            mode: options.mode,
            providers,
          })

          checks.push(checkPromise)

          // If not parallel mode, wait for this check to complete
          if (!options.parallel) {
            await checkPromise
          }
        }
      }

      // Wait for all checks to complete
      const results = await Promise.all(checks)

      // Infer account status from actual model test results
      const accounts = await inferAccountStatus(results)

      // Separate available and unavailable models
      const availableModels = results.filter((r) => r.available)
      const unavailableModels = results.filter((r) => !r.available)

      // Calculate summary statistics
      const summary = {
        available: results.filter((r) => r.status === "AVAILABLE").length,
        rateLimited: results.filter((r) => r.status === "RATE_LIMITED").length,
        quotaExceeded: results.filter((r) => r.status === "QUOTA_EXCEEDED").length,
        authError: results.filter((r) => r.status === "AUTH_ERROR").length,
        noAuth: results.filter((r) => r.status === "NO_AUTH").length,
        other: results.filter(
          (r) => !["AVAILABLE", "RATE_LIMITED", "QUOTA_EXCEEDED", "AUTH_ERROR", "NO_AUTH"].includes(r.status),
        ).length,
        accountsAuthenticated: accounts.filter((a) => a.authenticated).length,
        accountsTotal: accounts.length,
      }

      const totalTime = Date.now() - startTime
      log.info("check all complete", {
        totalModels: results.length,
        available: summary.available,
        rateLimited: summary.rateLimited,
        quotaExceeded: summary.quotaExceeded,
        authError: summary.authError,
        noAuth: summary.noAuth,
        other: summary.other,
        accountsAuthenticated: summary.accountsAuthenticated,
        accountsTotal: summary.accountsTotal,
        totalTime,
      })

      return {
        timestamp: new Date().toISOString(),
        totalModels: results.length,
        availableModels,
        unavailableModels,
        accounts,
        summary,
      }
    } catch (error) {
      log.error("check all failed", { error })
      throw error
    }
  }

  /**
   * Extract retry-after time from error response
   */
  function extractRetryAfter(error: any): number | undefined {
    // Try to get from headers
    const retryAfterHeader = error.headers?.["retry-after"] || error.headers?.["Retry-After"]
    if (retryAfterHeader) {
      const seconds = parseInt(retryAfterHeader, 10)
      if (!isNaN(seconds)) return seconds
    }

    // Try to extract from error message
    // Patterns: "retry after 60 seconds", "retry in 60s", "wait 60 seconds"
    const patterns = [/retry after (\d+)/i, /retry in (\d+)/i, /wait (\d+)\s*(?:seconds?|s)/i, /try again in (\d+)/i]

    for (const pattern of patterns) {
      const match = error.message?.match(pattern)
      if (match) {
        const seconds = parseInt(match[1], 10)
        if (!isNaN(seconds)) return seconds
      }
    }

    return undefined
  }
}
