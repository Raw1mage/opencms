/**
 * Unified Quota Module — barrel exports.
 *
 * @event_20260216_quota_consolidation
 * Consolidates all quota-related code into a single import path:
 *   import { getOpenAIQuotas, refreshCodexAccessToken, ... } from "@/account/quota"
 *
 * Module Breakdown:
 * - openai.ts  — Codex/OpenAI quota (token refresh, usage fetch, helpers)
 *
 * Future additions:
 * - antigravity.ts — Antigravity cockpit quota (Phase 5)
 * - gemini.ts      — Gemini RPD/RPM tracking (when split from monitor.ts)
 */

// ============================================================================
// OpenAI / Codex Quota
// ============================================================================

export {
  // Main API
  getOpenAIQuotas,
  getOpenAIQuota,
  // Codex helpers (used by dialog-admin.tsx)
  refreshCodexAccessToken,
  extractAccountIdFromTokens,
  parseCodexUsage,
  computeCodexRemaining,
  clampPercentage,
  // Constants
  CODEX_ISSUER,
  CODEX_CLIENT_ID,
  CODEX_USAGE_URL,
  // Schemas & Types
  CodexUsageSchema,
} from "./openai"

export type { OpenAIQuota, CodexTokenResponse, CodexIdTokenClaims, CodexUsage } from "./openai"
