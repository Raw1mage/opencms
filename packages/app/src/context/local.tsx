import { createStore } from "solid-js/store"
import { batch, createMemo } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { base64Encode } from "@opencode-ai/util/encode"
import { useProviders } from "@/hooks/use-providers"
import { useModels } from "@/context/models"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./model-variant"

export type ModelKey = { providerID: string; modelID: string; accountID?: string }

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
    const providers = useProviders()
    const connected = createMemo(() => new Set(providers.connected().map((provider) => provider.id)))

    function isModelValid(model: ModelKey) {
      const provider = providers.all().find((x) => x.id === model.providerID)
      return !!provider?.models[model.modelID] && connected().has(model.providerID)
    }

    function getFirstValidModel(...modelFns: (() => ModelKey | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
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

      const currentSelection = createMemo(() => {
        const a = agent.current()
        if (!a) return undefined
        return getFirstValidModel(
          () => ephemeral.model[a.name],
          () => (a.model ? { providerID: a.model.providerId, modelID: a.model.modelID } : undefined),
          fallbackModel,
        )
      })

      const current = createMemo(() => {
        const key = currentSelection()
        if (!key) return undefined
        return models.find(key)
      })

      const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

      const cycle = (direction: 1 | -1) => {
        const recentList = recent()
        const currentModel = current()
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

        model.set({
          providerID: val.provider.id,
          modelID: val.id,
        })
      }

      const set = (model: ModelKey | undefined, options?: { recent?: boolean }) => {
        batch(() => {
          const currentAgent = agent.current()
          const next = model ?? fallbackModel()
          if (currentAgent) setEphemeral("model", currentAgent.name, next)
          if (model) models.setVisibility(model, true)
          if (options?.recent && model) models.recent.push(model)
        })
      }

      setModel = set

      return {
        ready: models.ready,
        current,
        selection: currentSelection,
        recent,
        list: models.list,
        cycle,
        set,
        visible(model: ModelKey) {
          return models.visible(model)
        },
        enabled(model: ModelKey) {
          return models.isEnabled(model)
        },
        favorite(model: ModelKey) {
          return models.isFavorite(model)
        },
        favoriteList() {
          return models.favoriteList()
        },
        setVisibility(model: ModelKey, visible: boolean) {
          models.setVisibility(model, visible)
        },
        toggleFavorite(model: ModelKey) {
          models.toggleFavorite(model)
        },
        variant: {
          configured() {
            const a = agent.current()
            const m = current()
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
          selected() {
            const m = current()
            if (!m) return undefined
            return models.variant.get({ providerID: m.provider.id, modelID: m.id })
          },
          current() {
            return resolveModelVariant({
              variants: this.list(),
              selected: this.selected(),
              configured: this.configured(),
            })
          },
          list() {
            const m = current()
            if (!m) return []
            if (!m.variants) return []
            return Object.keys(m.variants)
          },
          set(value: string | undefined) {
            const m = current()
            if (!m) return
            models.variant.set({ providerID: m.provider.id, modelID: m.id }, value)
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            this.set(
              cycleModelVariant({
                variants,
                selected: this.selected(),
                configured: this.configured(),
              }),
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
