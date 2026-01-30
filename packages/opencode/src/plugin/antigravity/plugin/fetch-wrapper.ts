import type { PluginContext, GetAuth, ProjectContextResult } from "./types";
import { ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { isOAuthAuth, accessTokenExpired, parseRefreshParts, type OAuthAuthDetails } from "./auth";
import { AccountManager, type ModelFamily, type ManagedAccount } from "./accounts";
import { loadAccounts } from "./storage";
import { refreshAccessToken } from "./token";
import { ensureProjectContext } from "./project";
import { isGenerativeLanguageRequest, prepareAntigravityRequest, transformAntigravityResponse, getPluginSessionId } from "./request";
import { startAntigravityDebugRequest } from "./debug";
import { createLogger, printAntigravityConsole } from "./logger";

const log = createLogger("fetch-wrapper");

// ============================================================================
// Types & Interfaces
// ============================================================================

interface RateLimitDelay {
  attempt: number;
  serverRetryAfterMs: number | null;
  delayMs: number;
}

interface AttemptInfo {
  resolvedUrl: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  streaming: boolean;
  requestedModel?: string;
  effectiveModel?: string;
}

interface EndpointLoopResult {
  type: "success" | "rate-limit" | "retry-soon" | "all-failed";
  response?: Response;
  error?: Error;
  attemptInfo?: AttemptInfo;
  retryAfterMs?: number;
}

// ============================================================================
// Helper Utilities
// ============================================================================

function toUrlStr(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.toString();
  if (typeof input === "string") return input;
  return input.url;
}

function getModelFamilyFromUrl(urlString: string): ModelFamily {
  const lower = urlString.toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("gemini-3-flash")) return "gemini-flash";
  if (lower.includes("gemini-3-pro")) return "gemini-pro";
  return "gemini";
}

function formatWaitTimeMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
}

function computeExponentialBackoffMs(attempt: number): number {
  const base = 2000;
  const cap = 32000;
  const ms = base * Math.pow(2, Math.min(attempt - 1, 5));
  const jitter = Math.random() * 1000;
  return Math.min(ms + jitter, cap);
}

async function sleepWithBackoff(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("AbortError");
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("AbortError"));
    });
  });
}

function overrideEndpointForRequest(request: string, endpoint: string): string {
  try {
    const url = new URL(request);
    const target = new URL(endpoint);
    url.protocol = target.protocol;
    url.host = target.host;
    return url.toString();
  } catch {
    return request;
  }
}

// ============================================================================
// Core Execution Logic
// ============================================================================

async function handleRateLimit(
  response: Response,
  account: ManagedAccount,
  accountManager: AccountManager,
  accountCount: number,
  streaming: boolean,
  debugContext: any,
  requestedModel: string | undefined,
  getRateLimitDelay: (idx: number, ms: number | null) => RateLimitDelay,
  family: ModelFamily,
  projectId: string | undefined,
): Promise<EndpointLoopResult> {
  const retryAfter = response.headers.get("Retry-After");
  const serverRetryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : null;
  const { delayMs } = getRateLimitDelay(account.index, serverRetryMs);

  accountManager.markRateLimited(account, delayMs, family);

  if (accountCount > 1) {
    log.info(`Account ${account.index + 1} rate-limited, switching...`, {
      delayMs,
      family,
    });
    return { type: "retry-soon" };
  }

  // Single account mode: transform the response so diagnostic info is visible
  await transformAntigravityResponse(response, streaming, debugContext, requestedModel, projectId, undefined, undefined, getPluginSessionId());
  return { type: "rate-limit", response, retryAfterMs: delayMs };
}

async function handleServerError(
  response: Response,
  account: ManagedAccount,
  accountManager: AccountManager,
  accountCount: number,
  family: ModelFamily,
): Promise<EndpointLoopResult> {
  log.warn(`Server error ${response.status} on account ${account.index + 1}`, {
    status: response.status,
    family,
  });

  if (accountCount > 1) {
    accountManager.markRateLimited(account, 5000, family);
    return { type: "retry-soon" };
  }

  return { type: "all-failed", response };
}

async function tryEndpointFallbacks(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  accessToken: string,
  projectContext: any,
  account: ManagedAccount,
  accountManager: AccountManager,
  accountCount: number,
  client: PluginContext["client"],
  abortSignal: AbortSignal | undefined,
  getRateLimitDelay: (idx: number, ms: number | null) => RateLimitDelay,
  family: ModelFamily,
): Promise<EndpointLoopResult> {
  let lastResponse: Response | undefined;
  let lastError: Error | undefined;
  let lastAttemptInfo: AttemptInfo | undefined;

  const normalizedInput: RequestInfo = input instanceof URL ? input.toString() : input;

  for (let i = 0; i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length; i++) {
    const currentEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[i];
    if (!currentEndpoint) continue;

    try {
      const { request, init: transformedInit, streaming, requestedModel, effectiveModel } = prepareAntigravityRequest(
        toUrlStr(normalizedInput),
        init,
        accessToken,
        projectContext.effectiveProjectId,
      );

      const finalUrl = overrideEndpointForRequest(toUrlStr(request), currentEndpoint);
      const originalUrl = toUrlStr(input);
      const resolvedUrl = toUrlStr(finalUrl);

      lastAttemptInfo = {
        resolvedUrl,
        method: transformedInit.method,
        headers: transformedInit.headers,
        body: transformedInit.body,
        streaming,
        requestedModel,
        effectiveModel,
      };

      const debugContext = startAntigravityDebugRequest({
        originalUrl,
        resolvedUrl,
        method: transformedInit.method,
        headers: transformedInit.headers,
        body: transformedInit.body,
        streaming,
        projectId: projectContext.effectiveProjectId,
        sessionId: getPluginSessionId(),
      });

      const response = await fetch(finalUrl, transformedInit);

      if (response.status === 429) {
        return handleRateLimit(
          response,
          account,
          accountManager,
          accountCount,
          streaming,
          debugContext,
          requestedModel,
          getRateLimitDelay,
          family,
          projectContext.effectiveProjectId,
        );
      }

      if (response.status >= 500 && i === ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
        return handleServerError(response, account, accountManager, accountCount, family);
      }

      const shouldRetryEndpoint = response.status === 403 || response.status === 404 || response.status >= 500;

      if (shouldRetryEndpoint && i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
        lastResponse = response;
        continue;
      }

      return { type: "success", response, attemptInfo: lastAttemptInfo };
    } catch (error) {
      if (i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      throw error;
    }
  }

  if (lastResponse) {
    return { type: "all-failed", response: lastResponse, attemptInfo: lastAttemptInfo };
  }

  return { type: "all-failed", error: lastError ?? new Error("All endpoints failed") };
}

// ============================================================================
// Factory Implementation
// ============================================================================

export function createAntigravityFetch(
  getAuth: GetAuth,
  client: PluginContext["client"],
  options: { singleAccountMode?: boolean; accountManager?: AccountManager } = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const rateLimitStateByAccount = new Map<number, { consecutive429: number; lastAt: number }>();

  const getRateLimitDelay = (accountIndex: number, serverRetryAfterMs: number | null): RateLimitDelay => {
    const now = Date.now();
    const previous = rateLimitStateByAccount.get(accountIndex);
    const attempt = (previous?.consecutive429 ?? 0) + 1;
    const backoffMs = computeExponentialBackoffMs(attempt);
    const delayMs = serverRetryAfterMs !== null ? Math.max(serverRetryAfterMs, backoffMs) : backoffMs;

    rateLimitStateByAccount.set(accountIndex, { consecutive429: attempt, lastAt: now });

    return { attempt, serverRetryAfterMs, delayMs };
  };

  const resetRateLimitState = (accountIndex: number): void => {
    rateLimitStateByAccount.delete(accountIndex);
  };

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlString = toUrlStr(input);
    const family = getModelFamilyFromUrl(urlString);

    const latestAuth = await getAuth();
    if (!isOAuthAuth(latestAuth)) {
      return fetch(input, init);
    }

    // --- Sidecar Path Interception ---
    if (urlString.endsWith("/model-check") || urlString.endsWith("/accounts")) {
      const stored = await loadAccounts();
      const manager = new AccountManager(latestAuth, stored);
      return new Response(JSON.stringify({
        service: "antigravity-sidecar",
        accounts: manager.getAccountInfos(),
        timestamp: Date.now()
      }, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    const storedAccounts = options.singleAccountMode ? null : await loadAccounts();
    const accountManager = options.accountManager ?? new AccountManager(latestAuth, storedAccounts);
    const accountCount = accountManager.getAccountCount();

    const resolveProjectContext = async (authRecord: OAuthAuthDetails): Promise<ProjectContextResult> => {
      return ensureProjectContext(authRecord);
    };

    const abortSignal = init?.signal ?? undefined;

    while (true) {
      const previousAccount = accountManager.getCurrentAccount();
      const account = accountManager.getCurrentOrNextForFamily(family);

      if (!account) {
        const waitTimeMs = accountManager.getMinWaitTimeForFamily(family) || 60000;
        const waitTimeSec = Math.ceil(waitTimeMs / 1000);
        const waitTimeHuman = formatWaitTimeMs(waitTimeMs);

        log.info(`All ${accountCount} account(s) are rate-limited for ${family}, waiting...`, {
          accountCount,
          waitTimeSec,
          family,
        });

        printAntigravityConsole(
          "error",
          `All ${accountCount} account(s) are rate-limited for ${family}. Retrying after ${waitTimeHuman}...`,
        );

        try {
          await client.tui.showToast({
            body: {
              message: `Antigravity Rate Limited (${family}). Retrying after ${waitTimeHuman}...`,
              variant: "warning",
            },
          });
        } catch { }

        await sleepWithBackoff(waitTimeMs, abortSignal);
        continue;
      }

      const isSwitch = !previousAccount || previousAccount.index !== account.index;

      if (isSwitch) {
        const wasRateLimited = previousAccount
          ? (previousAccount.rateLimitResetTimes[family] ?? 0) > Date.now()
          : false;
        const switchReason = previousAccount ? (wasRateLimited ? "rate-limit" : "rotation") : "initial";
        accountManager.markSwitched(account, switchReason, family);

        log.info(
          `Using account ${account.index + 1}/${accountCount}${account.email ? ` (${account.email})` : ""} for ${family}`,
          {
            accountIndex: account.index,
            accountEmail: account.email,
            accountCount,
            reason: switchReason,
            family,
          },
        );

        try {
          await accountManager.save();
        } catch (error) {
          log.warn("Failed to save account switch state", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let authRecord = accountManager.accountToAuth(account);

      if (accessTokenExpired(authRecord)) {
        const refreshed = await refreshAccessToken(authRecord, client, ANTIGRAVITY_PROVIDER_ID);
        if (!refreshed) continue;
        authRecord = refreshed;
        const parts = parseRefreshParts(authRecord.refresh ?? "");
        accountManager.updateAccount(account, authRecord.access ?? "", authRecord.expires ?? 0, parts);

        try {
          await accountManager.save();
        } catch (error) {
          log.warn("Failed to save account state after token refresh", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const accessToken = authRecord.access;
      if (!accessToken) continue;

      const projectContext = await resolveProjectContext(authRecord);

      const result = await tryEndpointFallbacks(
        input,
        init,
        accessToken,
        projectContext,
        account,
        accountManager,
        accountCount,
        client,
        abortSignal,
        getRateLimitDelay,
        family,
      );

      if (result.type === "retry-soon") {
        continue;
      }

      if (result.type === "rate-limit") {
        if (accountCount === 1) {
          const waitMs = result.retryAfterMs || accountManager.getMinWaitTimeForFamily(family) || 1000;
          log.info("Single account rate-limited, retrying after backoff", { waitMs, waitSec: Math.ceil(waitMs / 1000), family });
          await sleepWithBackoff(waitMs, abortSignal);
        }
        continue;
      }

      if (result.type === "success" && result.response) {
        resetRateLimitState(account.index);

        try {
          await client.auth.set({
            path: { id: ANTIGRAVITY_PROVIDER_ID },
            body: accountManager.accountToAuth(account) as any,
          });
          await accountManager.save();
        } catch (saveError) {
          log.error("Failed to save updated auth", {
            error: saveError instanceof Error ? saveError.message : String(saveError),
          });
        }

        const { streaming, requestedModel, effectiveModel } = result.attemptInfo ?? { streaming: false, requestedModel: undefined, effectiveModel: undefined };
        const debugContext = startAntigravityDebugRequest({
          originalUrl: toUrlStr(input),
          resolvedUrl: result.attemptInfo?.resolvedUrl ?? toUrlStr(input),
          method: result.attemptInfo?.method,
          headers: result.attemptInfo?.headers,
          body: result.attemptInfo?.body,
          streaming,
          projectId: projectContext.effectiveProjectId,
          sessionId: getPluginSessionId(),
        });

        return transformAntigravityResponse(
          result.response,
          streaming,
          debugContext,
          requestedModel,
          projectContext.effectiveProjectId,
          undefined,
          effectiveModel,
          getPluginSessionId()
        );
      }

      if (result.type === "all-failed") {
        if (result.response && result.attemptInfo) {
          const debugContext = startAntigravityDebugRequest({
            originalUrl: toUrlStr(input),
            resolvedUrl: result.attemptInfo.resolvedUrl,
            method: result.attemptInfo.method,
            headers: result.attemptInfo.headers,
            body: result.attemptInfo.body,
            streaming: result.attemptInfo.streaming,
            projectId: projectContext.effectiveProjectId,
            sessionId: getPluginSessionId(),
          });

          return transformAntigravityResponse(
            result.response,
            result.attemptInfo.streaming,
            debugContext,
            result.attemptInfo.requestedModel,
            projectContext.effectiveProjectId,
            undefined,
            result.attemptInfo.effectiveModel,
            getPluginSessionId(),
          );
        }

        throw result.error || new Error("All Antigravity endpoints failed");
      }
    }
  };
}
