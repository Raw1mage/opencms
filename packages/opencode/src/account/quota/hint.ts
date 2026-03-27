import { Account } from "../index"
import { RequestMonitor } from "../monitor"
import { formatOpenAIQuotaDisplay, formatRequestMonitorQuotaDisplay, type QuotaDisplayFormat } from "./display"
import { getOpenAIQuotaForDisplay, getOpenAIQuota } from "./openai"

export async function getQuotaHint(input: {
  providerId: string
  accountId?: string
  modelID?: string
  format?: QuotaDisplayFormat
  fresh?: boolean
}) {
  const family = Account.parseFamily(input.providerId) ?? input.providerId
  const format = input.format ?? "footer"

  if (!input.accountId) {
    return {
      family,
      accountId: undefined,
      hint: undefined,
    }
  }

  if (family === "openai") {
    const quota = input.fresh
      ? await getOpenAIQuota(input.accountId, { waitFresh: true })
      : await getOpenAIQuotaForDisplay(input.accountId)
    return {
      family,
      accountId: input.accountId,
      hint: formatOpenAIQuotaDisplay(quota, format),
    }
  }

  if ((family === "google-api" || family === "gemini-cli") && input.modelID) {
    const monitor = RequestMonitor.get()
    const stats = monitor.getStats(input.providerId, input.accountId, input.modelID)
    const limits = monitor.getModelLimits(input.providerId, input.modelID)
    return {
      family,
      accountId: input.accountId,
      hint: formatRequestMonitorQuotaDisplay(stats, limits),
    }
  }

  return {
    family,
    accountId: input.accountId,
    hint: undefined,
  }
}

export async function getQuotaHintsForAccounts(input: {
  providerId: string
  accountIds: string[]
  modelID?: string
  format?: QuotaDisplayFormat
}) {
  const entries = await Promise.all(
    input.accountIds.map(async (accountId) => {
      const result = await getQuotaHint({
        providerId: input.providerId,
        accountId,
        modelID: input.modelID,
        format: input.format,
      })
      return [accountId, result.hint ?? ""] as const
    }),
  )
  return Object.fromEntries(entries)
}
