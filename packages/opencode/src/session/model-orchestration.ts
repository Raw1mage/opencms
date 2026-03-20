import { ModelScoring } from "@/agent/score"
import { Provider } from "@/provider/provider"
import { Account, findFallback } from "@/account"
import { getHealthTracker, getRateLimitTracker } from "@/account/rotation"
import { ProviderHealth } from "@/provider/health"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { debugCheckpoint } from "@/util/debug"

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

export function shouldAutoSwitchMainModel(input: {
  session: Pick<Session.Info, "workflow">
  lastUserParts: MessageV2.Part[]
}) {
  if (!input.session.workflow?.autonomous.enabled) return false
  return input.lastUserParts.some((part) => part.type === "text" && part.synthetic)
}

/**
 * Subagent model selection: session identity is law.
 *
 * Subagents MUST use the parent session's exact account/provider/model.
 * No scoring, no rotation, no rescue, no downgrade.
 * The fallbackModel (parent's pinned execution identity) is returned unconditionally.
 *
 * Only exception: explicitModel or agentModel override (both must match parent's provider+account).
 */
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
      source: "parent_inherit",
    },
    candidates: [],
  }

  debugCheckpoint("syslog.subagent", "orchestrateModelSelection: session identity enforced", {
    agentName: input.agentName,
    parentModel: input.fallbackModel,
    explicitModel: input.explicitModel,
    agentModel: input.agentModel,
  })

  // Explicit override — must match parent's provider; account must match or be unset (inherit parent's)
  if (input.explicitModel) {
    const sameProvider = input.explicitModel.providerId === input.fallbackModel.providerId
    const accountOk = !input.explicitModel.accountId || !input.fallbackModel.accountId ||
      input.explicitModel.accountId === input.fallbackModel.accountId
    if (sameProvider && accountOk) {
      const model = { ...input.explicitModel, accountId: input.fallbackModel.accountId }
      trace.candidates.push({ ...model, source: "explicit" })
      trace.selected = { ...model, source: "explicit" }
      return { model, trace }
    }
    debugCheckpoint("syslog.subagent", "orchestrateModelSelection: explicit model rejected (identity mismatch)", {
      explicit: input.explicitModel,
      parent: input.fallbackModel,
    })
  }

  // Agent pinned model — must match parent's provider; account must match or be unset
  if (input.agentModel) {
    const sameProvider = input.agentModel.providerId === input.fallbackModel.providerId
    const accountOk = !input.agentModel.accountId || !input.fallbackModel.accountId ||
      input.agentModel.accountId === input.fallbackModel.accountId
    if (sameProvider && accountOk) {
      const model = { ...input.agentModel, accountId: input.fallbackModel.accountId }
      trace.candidates.push({ ...model, source: "agent_pinned" })
      trace.selected = { ...model, source: "agent_pinned" }
      return { model, trace }
    }
    debugCheckpoint("syslog.subagent", "orchestrateModelSelection: agent model rejected (identity mismatch)", {
      agentModel: input.agentModel,
      parent: input.fallbackModel,
    })
  }

  // Default: use parent's exact model. No scoring, no rotation, no downgrade.
  trace.candidates.push({ ...input.fallbackModel, source: "parent_inherit", operational: true })
  trace.selected = { ...input.fallbackModel, source: "parent_inherit" }
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
