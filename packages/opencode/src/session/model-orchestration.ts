import { ModelScoring } from "@/agent/score"
import { Provider } from "@/provider/provider"
import { Account, findFallback } from "@/account"
import { getHealthTracker, getRateLimitTracker } from "@/account/rotation"
import { ProviderHealth } from "@/provider/health"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"

type RotationPurpose = "coding" | "reasoning" | "image" | "docs" | "audio" | "video" | "long-context" | "generic"

export type ModelArbitrationTrace = {
  agentName: string
  domain: string
  selected: { providerId: string; modelID: string; accountId?: string; source: string }
  candidates: Array<{
    providerId: string
    modelID: string
    accountId?: string
    source: string
    operational?: boolean
  }>
}

export function domainForAgent(agentName: string) {
  if (agentName === "review") return "review"
  if (agentName === "testing") return "testing"
  if (agentName === "docs") return "docs"
  if (agentName === "explore") return "explore"
  return "coding"
}

function purposeForAgent(agentName: string): RotationPurpose {
  const domain = domainForAgent(agentName)
  if (domain === "explore") return "reasoning"
  if (domain === "docs") return "docs"
  if (domain === "review") return "reasoning"
  if (domain === "testing") return "coding"
  return "coding"
}

async function activeAccountIdForProvider(providerId: string) {
  const family = await Account.resolveFamily(providerId)
  if (!family) return "public"
  return (await Account.getActive(family)) ?? "public"
}

async function isOperationalModel(model: { providerId: string; modelID: string; accountId?: string }) {
  const accountId = model.accountId ?? (await activeAccountIdForProvider(model.providerId))
  const rateLimitTracker = getRateLimitTracker()
  if (rateLimitTracker.isRateLimited(accountId, model.providerId, model.modelID)) return false

  const healthTracker = getHealthTracker()
  if (!healthTracker.isUsable(accountId, model.providerId, model.modelID)) return false

  const healthStatus = ProviderHealth.getStatus(model.providerId, model.modelID)
  return healthStatus === "AVAILABLE"
}

async function findOperationalFallback(input: {
  sourceModel: { providerId: string; modelID: string; accountId?: string }
  agentName: string
}) {
  const accountId = input.sourceModel.accountId ?? (await activeAccountIdForProvider(input.sourceModel.providerId))
  const candidate = await findFallback(
    {
      providerId: input.sourceModel.providerId,
      modelID: input.sourceModel.modelID,
      accountId,
    },
    {
      purpose: purposeForAgent(input.agentName),
      strategy: "model-first",
    },
  ).catch(() => null)

  if (!candidate) return null
  return {
    providerId: candidate.providerId,
    modelID: candidate.modelID,
    accountId: candidate.accountId,
  }
}

export function shouldAutoSwitchMainModel(input: {
  session: Pick<Session.Info, "workflow">
  lastUserParts: MessageV2.Part[]
}) {
  if (!input.session.workflow?.autonomous.enabled) return false
  return input.lastUserParts.some((part) => part.type === "text" && part.synthetic)
}

export async function orchestrateModelSelection(input: {
  agentName: string
  explicitModel?: { providerId: string; modelID: string; accountId?: string }
  agentModel?: { providerId: string; modelID: string; accountId?: string }
  fallbackModel: { providerId: string; modelID: string; accountId?: string }
  selectModel?: typeof ModelScoring.select
  isOperationalModel?: (model: { providerId: string; modelID: string; accountId?: string }) => Promise<boolean>
  findOperationalFallback?: (input: {
    sourceModel: { providerId: string; modelID: string; accountId?: string }
    agentName: string
  }) => Promise<{ providerId: string; modelID: string; accountId?: string } | null>
}): Promise<{ model: { providerId: string; modelID: string; accountId?: string }; trace: ModelArbitrationTrace }> {
  const trace: ModelArbitrationTrace = {
    agentName: input.agentName,
    domain: domainForAgent(input.agentName),
    selected: {
      providerId: input.fallbackModel.providerId,
      modelID: input.fallbackModel.modelID,
      source: "fallback",
    },
    candidates: [],
  }

  if (input.explicitModel) {
    trace.candidates.push({ ...input.explicitModel, source: "explicit" })
    trace.selected = { ...input.explicitModel, source: "explicit" }
    return { model: input.explicitModel, trace }
  }
  if (input.agentModel) {
    trace.candidates.push({ ...input.agentModel, source: "agent_pinned" })
    trace.selected = { ...input.agentModel, source: "agent_pinned" }
    return { model: input.agentModel, trace }
  }

  const selectModel = input.selectModel ?? ModelScoring.select
  const isOperational = input.isOperationalModel ?? isOperationalModel
  const resolveFallback = input.findOperationalFallback ?? findOperationalFallback
  const selected = await selectModel(domainForAgent(input.agentName)).catch(() => null)
  const scoredModel = selected
    ? {
        providerId: selected.providerId,
        modelID: selected.modelID,
        accountId: selected.accountId,
      }
    : null

  if (scoredModel) {
    const operational = await isOperational(scoredModel)
    trace.candidates.push({ ...scoredModel, source: "scored", operational })
    if (operational) {
      trace.selected = { ...scoredModel, source: "scored" }
      return { model: scoredModel, trace }
    }
  }

  const fallbackOperational = await isOperational(input.fallbackModel)
  trace.candidates.push({ ...input.fallbackModel, source: "fallback", operational: fallbackOperational })
  if (fallbackOperational) {
    trace.selected = { ...input.fallbackModel, source: "fallback" }
    return { model: input.fallbackModel, trace }
  }

  const rescued = await resolveFallback({
    sourceModel: scoredModel ?? input.fallbackModel,
    agentName: input.agentName,
  })
  if (rescued) {
    trace.candidates.push({ ...rescued, source: "rotation_rescue", operational: true })
    trace.selected = { ...rescued, source: "rotation_rescue" }
    return { model: rescued, trace }
  }

  trace.selected = { ...input.fallbackModel, source: "fallback_forced" }
  return { model: input.fallbackModel, trace }
}

export async function selectOrchestratedModel(input: {
  agentName: string
  explicitModel?: { providerId: string; modelID: string; accountId?: string }
  agentModel?: { providerId: string; modelID: string; accountId?: string }
  fallbackModel: { providerId: string; modelID: string; accountId?: string }
  selectModel?: typeof ModelScoring.select
  isOperationalModel?: (model: { providerId: string; modelID: string; accountId?: string }) => Promise<boolean>
  findOperationalFallback?: (input: {
    sourceModel: { providerId: string; modelID: string; accountId?: string }
    agentName: string
  }) => Promise<{ providerId: string; modelID: string; accountId?: string } | null>
}) {
  return (await orchestrateModelSelection(input)).model
}

export async function resolveProviderModel(input: {
  agentName: string
  explicitModel?: { providerId: string; modelID: string; accountId?: string }
  agentModel?: { providerId: string; modelID: string; accountId?: string }
  fallbackModel: { providerId: string; modelID: string; accountId?: string }
  selectModel?: typeof ModelScoring.select
  getModel?: typeof Provider.getModel
}) {
  const resolved = await selectOrchestratedModel(input)
  const getModel = input.getModel ?? Provider.getModel
  return getModel(resolved.providerId, resolved.modelID)
}
