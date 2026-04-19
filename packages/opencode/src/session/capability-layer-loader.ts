import { Log } from "@/util/log"
import {
  setCapabilityLayerLoader,
  type CapabilityLayerLoader,
  type LayerBundle,
} from "./capability-layer"
import { InstructionPrompt } from "./instruction"
import { loadAndPinAll } from "./mandatory-skills"

const log = Log.create({ service: "capability-layer-loader" })

export type CapabilityLoadContext = {
  sessionID: string
  epoch: number
  agent: { name: string }
  isSubagent: boolean
}

/**
 * Build the production capability-layer loader. Phase 4.6 wires this at
 * daemon startup. Other phases (tests) may inject alternative loaders via
 * `setCapabilityLayerLoader` directly.
 *
 * Layer contributions in the MVP scope:
 * - `agents_md` → `InstructionPrompt.system(sessionID)` (epoch-scoped per Phase 3.1)
 * - `skill_content` → `loadAndPinAll(...)` (runs resolve + reconcile + preload,
 *   pins into SkillLayerRegistry as side effect per DD-15)
 * - `driver` / `enablement` are not populated in this MVP loader; the in-memory
 *   bundle omits the fields. Phase 2 (future extend mode) can fill them.
 */
export function buildProductionCapabilityLoader(
  resolveAgentContext: (sessionID: string) => Promise<CapabilityLoadContext | undefined>,
): CapabilityLayerLoader {
  return {
    async load(input) {
      const ctx = await resolveAgentContext(input.sessionID)
      if (!ctx) {
        throw new Error(
          `capability-layer-loader: no agent context for session ${input.sessionID}`,
        )
      }

      // agents_md layer
      const instructionTexts = await InstructionPrompt.system(input.sessionID)
      const agentsMdText = instructionTexts.join("\n\n")
      const agentsMdSources = instructionTexts
        .map((t) => t.split("\n", 1)[0])
        .filter((line) => line.startsWith("Instructions from: "))
        .map((line) => line.replace("Instructions from: ", ""))

      // skill_content layer (resolves + reconciles + pins; side-effect on SkillLayerRegistry)
      const skillResult = await loadAndPinAll({
        sessionID: input.sessionID,
        agent: { name: ctx.agent.name },
        isSubagent: ctx.isSubagent,
      })

      const bundle: LayerBundle = {
        agents_md: {
          text: agentsMdText,
          sources: agentsMdSources,
        },
        skill_content: {
          pinnedSkills: skillResult.pinnedSkills,
          renderedText: "", // skill-layer-seam performs actual LLM injection; we don't duplicate text here
          missingSkills: skillResult.missingSkills,
        },
      }

      log.info("[capability-layer-loader] loaded bundle", {
        sessionID: input.sessionID,
        epoch: input.epoch,
        agentName: ctx.agent.name,
        isSubagent: ctx.isSubagent,
        pinnedCount: skillResult.pinnedSkills.length,
        missingCount: skillResult.missingSkills.length,
        agentsMdSources: agentsMdSources.length,
      })

      return bundle
    },
  }
}

/**
 * Register the production loader. Callers provide a context resolver that maps
 * sessionID → { agent, isSubagent }. runLoop has this info natively; silent
 * refresh endpoints fetch from Session.get.
 */
export function registerProductionCapabilityLoader(
  resolveAgentContext: (sessionID: string) => Promise<CapabilityLoadContext | undefined>,
) {
  const loader = buildProductionCapabilityLoader(resolveAgentContext)
  setCapabilityLayerLoader(loader)
  log.info("[capability-layer-loader] production loader registered")
}
