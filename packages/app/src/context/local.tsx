import { createStore } from "solid-js/store"
import { batch, createMemo } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useGlobalSync } from "./global-sync"
import { base64Encode } from "@opencode-ai/util/encode"
import { useProviders } from "@/hooks/use-providers"
import { useModels } from "@/context/models"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./model-variant"
import { providerKeyOf } from "@/components/model-selector-state"

export type ModelKey = { providerID: string; modelID: string; accountID?: string }

function buildModelScopeKey(agentName: string, sessionID?: string) {
  return `${sessionID ?? "__global__"}::${agentName}`
}

function parseConfiguredModel(input: unknown): ModelKey | undefined {
  if (!input) return undefined
  if (typeof input === "string") {
    const [providerID, modelID] = input.split("/")
    if (!providerID || !modelID) return undefined
    return { providerID, modelID }
  }
  if (typeof input !== "object") return undefined

  const record = input as {
    providerID?: string
    providerId?: string
    modelID?: string
    modelId?: string
    id?: string
    accountID?: string
    accountId?: string
  }
  const providerID = record.providerID ?? record.providerId
  const modelID = record.modelID ?? record.modelId ?? record.id
  if (!providerID || !modelID) return undefined
  return { providerID, modelID, accountID: record.accountID ?? record.accountId }
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const globalSync = useGlobalSync()
    const providers = useProviders()
    const connected = createMemo(() => new Set(providers.connected().map((provider) => provider.id)))

    function resolveProviderKey(providerID: string) {
      return providerKeyOf(providerID) || providerID
    }

    function availableAccountIds(providerID: string) {
      const providerKey = resolveProviderKey(providerID)
      const providers = globalSync.data.account_families
      return Object.keys(providers[providerKey]?.accounts ?? {})
    }

    /**
     * Returns true if the account is not currently rate-limit cooled down.
     * Reads SSOT from globalSync.data.account_families which is fed by the
     * server-side rate-limit tracker (rotation-state.json). When the cooldown
     * window expires the account becomes healthy again automatically; no
     * manual reset is needed. An unknown account (no account_families entry)
     * is treated as healthy — the caller's later validity checks will catch
     * a truly missing account.
     */
    function isAccountHealthy(providerID: string, accountID?: string) {
      if (!accountID) return true
      const providerKey = resolveProviderKey(providerID)
      const account = globalSync.data.account_families?.[providerKey]?.accounts?.[accountID] as
        | { coolingDownUntil?: number }
        | undefined
      const until = account?.coolingDownUntil
      if (typeof until !== "number") return true
      return until <= Date.now()
    }

    function replacementAccountID(providerID: string, currentAccountID?: string) {
      const providerKey = resolveProviderKey(providerID)
      const providerData = globalSync.data.account_families[providerKey]
      const active = providerData?.activeAccount
      const ids = Object.keys(providerData?.accounts ?? {})
      // Prefer the active account, then any other healthy account, then the
      // currently cooling-down current as last resort (so we don't break a
      // session whose entire family is cooling down).
      if (active && active !== currentAccountID && ids.includes(active) && isAccountHealthy(providerID, active))
        return active
      const healthy = ids.find((id) => id !== currentAccountID && isAccountHealthy(providerID, id))
      if (healthy) return healthy
      return ids.find((id) => id !== currentAccountID) ?? ids[0]
    }

    function sanitizeModel(model: ModelKey): ModelKey | undefined {
      if (!isModelValid(model)) return undefined
      if (!model.accountID) return model
      const ids = availableAccountIds(model.providerID)
      if (ids.length === 0) return model
      // If the requested account is no longer in the family, swap it.
      if (!ids.includes(model.accountID)) {
        const nextAccountID = replacementAccountID(model.providerID, model.accountID)
        if (!nextAccountID) return undefined
        return { ...model, accountID: nextAccountID }
      }
      // Account is in the family but cooling down — swap to a healthy sibling
      // when one exists. This is what stops new sessions from inheriting a
      // dead default and getting bounced through preflight rotation, which is
      // what produced the "rate limit toast spam on every new session" RCA.
      if (!isAccountHealthy(model.providerID, model.accountID)) {
        const nextAccountID = replacementAccountID(model.providerID, model.accountID)
        if (nextAccountID && nextAccountID !== model.accountID) {
          return { ...model, accountID: nextAccountID }
        }
      }
      return model
    }

    function isModelValid(model: ModelKey) {
      const provider = providers.all().find((x) => x.id === model.providerID)
      return !!provider?.models[model.modelID] && connected().has(model.providerID)
    }

    function getFirstValidModel(...modelFns: (() => ModelKey | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        const sanitized = sanitizeModel(model)
        if (sanitized) return sanitized
      }
    }

    let setModel: (model: ModelKey | undefined, options?: { recent?: boolean }) => void = () => undefined

    const agent = (() => {
      const list = createMemo(() => sync.data.agent.filter((x) => x.mode !== "subagent" && !x.hidden))
      const [store, setStore] = createStore<{
        current?: string
      }>({
        current: list()[0]?.name,
      })
      return {
        list,
        current() {
          const available = list()
          if (available.length === 0) return undefined
          return available.find((x) => x.name === store.current) ?? available[0]
        },
        set(name: string | undefined) {
          const available = list()
          if (available.length === 0) {
            setStore("current", undefined)
            return
          }
          if (name && available.some((x) => x.name === name)) {
            setStore("current", name)
            return
          }
          setStore("current", available[0].name)
        },
        move(direction: 1 | -1) {
          const available = list()
          if (available.length === 0) {
            setStore("current", undefined)
            return
          }
          let next = available.findIndex((x) => x.name === store.current) + direction
          if (next < 0) next = available.length - 1
          if (next >= available.length) next = 0
          const value = available[next]
          if (!value) return
          setStore("current", value.name)
          if (value.model)
            setModel({
              providerID: value.model.providerId,
              modelID: value.model.modelID,
            })
        },
      }
    })()

    const model = (() => {
      const models = useModels()

      const [ephemeral, setEphemeral] = createStore<{
        model: Record<string, ModelKey | undefined>
      }>({
        model: {},
      })

      const resolveConfigured = () => {
        const key = parseConfiguredModel(sync.data.config.model)
        if (!key) return
        if (isModelValid(key)) return key
      }

      const resolveRecent = () => {
        for (const item of models.recent.list()) {
          if (isModelValid(item)) return item
        }
      }

      const resolveDefault = () => {
        const defaults = providers.default()
        for (const provider of providers.connected()) {
          const configured = defaults[provider.id]
          if (configured) {
            const key = { providerID: provider.id, modelID: configured }
            if (isModelValid(key)) return key
          }

          const first = Object.values(provider.models)[0]
          if (!first) continue
          const key = { providerID: provider.id, modelID: first.id }
          if (isModelValid(key)) return key
        }
      }

      const fallbackModel = createMemo<ModelKey | undefined>(() => {
        return resolveConfigured() ?? resolveRecent() ?? resolveDefault()
      })

      const resolveScopedSelection = (sessionID?: string) => {
        const a = agent.current()
        if (!a) return undefined
        if (sessionID) {
          const m1 = ephemeral.model[buildModelScopeKey(a.name, sessionID)]
          return getFirstValidModel(
            () => {
              const exec = sync.data.session.find((s: { id: string }) => s.id === sessionID)?.execution
              if (!exec) return undefined
              return {
                providerID: exec.providerId,
                modelID: exec.modelID,
                accountID: exec.accountId,
              }
            },
            () => m1,
            () => (a.model ? { providerID: a.model.providerId, modelID: a.model.modelID } : undefined),
            fallbackModel,
          )
        }
        return getFirstValidModel(
          () => ephemeral.model[buildModelScopeKey(a.name, sessionID)],
          () => ephemeral.model[a.name],
          () => (a.model ? { providerID: a.model.providerId, modelID: a.model.modelID } : undefined),
          fallbackModel,
        )
      }

      const currentSelection = createMemo(() => resolveScopedSelection())

      const current = createMemo(() => {
        const key = currentSelection()
        if (!key) return undefined
        return models.find(key)
      })

      const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

      const cycle = (direction: 1 | -1, sessionID?: string) => {
        const recentList = recent()
        const currentModel = sessionID
          ? models.find(resolveScopedSelection(sessionID) ?? { providerID: "", modelID: "" })
          : current()
        if (!currentModel) return

        const index = recentList.findIndex(
          (x) => x?.provider.id === currentModel.provider.id && x?.id === currentModel.id,
        )
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = recentList.length - 1
        if (next >= recentList.length) next = 0

        const val = recentList[next]
        if (!val) return

        model.set(
          {
            providerID: val.provider.id,
            modelID: val.id,
          },
          undefined,
          sessionID,
        )
      }

      const syncSessionExecution = async (sessionID: string, model: ModelKey | undefined) => {
        if (!model) return
        await sdk.client.session.update({
          sessionID,
          execution: {
            providerId: model.providerID,
            modelID: model.modelID,
            accountId: model.accountID,
          },
        })
      }

      const set = async (
        model: ModelKey | undefined,
        options?: { recent?: boolean; interrupt?: boolean; syncSessionExecution?: boolean },
        sessionID?: string,
      ) => {
        if (sessionID && options?.interrupt) {
          await sdk.client.session.abort({ sessionID }).catch(() => {})
        }
        batch(() => {
          const currentAgent = agent.current()
          const next = model ?? fallbackModel()
          if (currentAgent) setEphemeral("model", buildModelScopeKey(currentAgent.name, sessionID), next)
          if (model) models.setVisibility(model, true)
          if (options?.recent && model) models.recent.push(model)
        })
        if (sessionID && options?.syncSessionExecution) {
          await syncSessionExecution(sessionID, model ?? fallbackModel())
        }
      }

      setModel = ((model: ModelKey | undefined, options?: { recent?: boolean }, sessionID?: string) => {
        void set(model, options, sessionID)
      }) as typeof setModel

      return {
        ready: models.ready,
        current(sessionID?: string) {
          const key = sessionID ? resolveScopedSelection(sessionID) : currentSelection()
          if (!key) return undefined
          return models.find(key)
        },
        selection(sessionID?: string) {
          return sessionID ? resolveScopedSelection(sessionID) : currentSelection()
        },
        recent,
        list: models.list,
        cycle,
        set,
        visible(model: ModelKey) {
          return models.visible(model)
        },
        setVisibility(model: ModelKey, visible: boolean) {
          models.setVisibility(model, visible)
        },
        variant: {
          configured(sessionID?: string) {
            const a = agent.current()
            const m = sessionID ? result.model.current(sessionID) : result.model.current()
            if (!a || !m) return undefined
            const agentModel = a.model as
              | {
                  providerId?: string
                  providerID?: string
                  modelID?: string
                  modelId?: string
                }
              | undefined
            const providerID = agentModel?.providerID ?? agentModel?.providerId
            const modelID = agentModel?.modelID ?? agentModel?.modelId
            const model = providerID && modelID ? { providerID, modelID } : undefined
            return getConfiguredAgentVariant({
              agent: { model, variant: a.variant },
              model: { providerID: m.provider.id, modelID: m.id, variants: m.variants },
            })
          },
          selected(sessionID?: string) {
            const m = sessionID ? result.model.current(sessionID) : result.model.current()
            if (!m) return undefined
            return models.variant.get({ providerID: m.provider.id, modelID: m.id })
          },
          current(sessionID?: string) {
            return resolveModelVariant({
              variants: this.list(sessionID),
              selected: this.selected(sessionID),
              configured: this.configured(sessionID),
            })
          },
          list(sessionID?: string) {
            const m = sessionID ? result.model.current(sessionID) : result.model.current()
            if (!m) return []
            if (!m.variants) return []
            return Object.keys(m.variants)
          },
          set(value: string | undefined, sessionID?: string) {
            const m = sessionID ? result.model.current(sessionID) : result.model.current()
            if (!m) return
            models.variant.set({ providerID: m.provider.id, modelID: m.id }, value)
          },
          cycle(sessionID?: string) {
            const variants = this.list(sessionID)
            if (variants.length === 0) return
            this.set(
              cycleModelVariant({
                variants,
                selected: this.selected(sessionID),
                configured: this.configured(sessionID),
              }),
              sessionID,
            )
          },
        },
      }
    })()

    const result = {
      slug: createMemo(() => base64Encode(sdk.directory)),
      model,
      agent,
    }
    return result
  },
})
