import { createStore } from "solid-js/store"
import { batch, createEffect, createMemo, createResource } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { uniqueBy } from "remeda"
import path from "path"
import { Global } from "@/global"
import { iife } from "@/util/iife"
import { createSimpleContext } from "./helper"
import { useToast } from "../ui/toast"
import { Provider } from "@/provider/provider"
import { Account } from "@/account"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const [accountFamilies] = createResource(() => Account.listAll())
    const accountDisplayNames = createMemo(() => {
      const families = accountFamilies()
      if (!families) return {}
      const map: Record<string, { label: string; family: string }> = {}
      for (const [family, data] of Object.entries(families)) {
        for (const [id, info] of Object.entries(data.accounts)) {
          map[id] = {
            label: Account.getDisplayName(id, info, family),
            family,
          }
        }
      }
      return map
    })

    function getAccountLabel(providerID: string, fallback: string) {
      const labels = accountDisplayNames()
      if (!labels || Object.keys(labels).length === 0) return fallback
      if (labels[providerID]) return labels[providerID].label
      const families = accountFamilies()
      const family = Account.parseProvider(providerID)
      if (family && families?.[family]?.activeAccount) {
        const active = families[family]!.activeAccount
        if (active && labels[active]) return labels[active].label
      }
      return fallback
    }

    function formatModelAnnouncement(model: { providerID: string; modelID: string }) {
      const providerInfo = sync.data.provider.find((x) => x.id === model.providerID)
      const providerLabel = providerInfo?.name ?? model.providerID
      const modelLabel = providerInfo?.models[model.modelID]?.name ?? model.modelID
      const accountLabel = getAccountLabel(model.providerID, "default account")
      return `《${providerLabel}, ${accountLabel}, ${modelLabel}》`
    }

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((x) => x.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    const agent = iife(() => {
      const agents = createMemo(() => sync.data.agent.filter((x) => x.mode !== "subagent" && !x.hidden))
      const [agentStore, setAgentStore] = createStore<{
        current: string
      }>({
        current: agents()[0]?.name ?? "",
      })
      const { theme } = useTheme()
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) || agents()[0]
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            let next = agents().findIndex((x) => x.name === agentStore.current) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const all = sync.data.agent
          const agent = all.find((x) => x.name === name)
          if (agent?.color) return RGBA.fromHex(agent.color)
          const index = all.findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          return colors()[index % colors().length]
        },
      }
    })

    const model = iife(() => {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        hidden: {
          providerID: string
          modelID: string
        }[]
        hiddenProviders: string[]
        variant: Record<string, string | undefined>
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        hidden: [],
        hiddenProviders: [],
        variant: {},
      })

      const file = Bun.file(path.join(Global.Path.state, "model.json"))
      const state = {
        pending: false,
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        Bun.write(
          file,
          JSON.stringify({
            recent: modelStore.recent,
            favorite: modelStore.favorite,
            hidden: modelStore.hidden,
            hiddenProviders: modelStore.hiddenProviders,
            variant: modelStore.variant,
          }),
        )
      }

      // Auto-cleanup: Remove models from favorites/recent that no longer exist in providers
      function cleanupInvalidModels() {
        if (!modelStore.ready) return
        const providerIds = new Set(sync.data.provider.map((p) => p.id))
        if (providerIds.size === 0) return // Don't cleanup if providers not loaded yet

        let changed = false

        // Cleanup favorites
        const validFavorites = modelStore.favorite.filter((item) => {
          const provider = sync.data.provider.find((p) => p.id === item.providerID)
          const isValid = !!provider?.models[item.modelID]
          if (!isValid && provider) {
            // Provider exists but model doesn't - remove it
            console.log(`[auto-cleanup] Removing invalid favorite: ${item.providerID}/${item.modelID}`)
            changed = true
            return false
          }
          return true // Keep if provider not loaded or model valid
        })

        // Cleanup recent
        const validRecent = modelStore.recent.filter((item) => {
          const provider = sync.data.provider.find((p) => p.id === item.providerID)
          const isValid = !!provider?.models[item.modelID]
          if (!isValid && provider) {
            console.log(`[auto-cleanup] Removing invalid recent: ${item.providerID}/${item.modelID}`)
            changed = true
            return false
          }
          return true
        })

        if (changed) {
          setModelStore("favorite", validFavorites)
          setModelStore("recent", validRecent)
          save()
        }
      }

      // Run cleanup when provider data changes
      createEffect(() => {
        // Track provider data changes
        const _providers = sync.data.provider
        if (_providers.length > 0 && modelStore.ready) {
          cleanupInvalidModels()
        }
      })

      file
        .json()
        .then((x) => {
          if (Array.isArray(x.recent)) setModelStore("recent", x.recent)
          if (Array.isArray(x.favorite)) setModelStore("favorite", x.favorite)
          if (Array.isArray(x.hidden)) setModelStore("hidden", x.hidden)
          if (Array.isArray(x.hiddenProviders)) setModelStore("hiddenProviders", x.hiddenProviders)
          if (typeof x.variant === "object" && x.variant !== null) setModelStore("variant", x.variant)
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
          // Run initial cleanup after loading
          cleanupInvalidModels()
        })

      const args = useArgs()
      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = Provider.parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        if (sync.data.config.model) {
          const { providerID, modelID } = Provider.parseModel(sync.data.config.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const currentModel = createMemo(() => {
        const a = agent.current()
        if (!a) return fallbackModel()
        return (
          getFirstValidModel(
            () => modelStore.model[a.name],
            () => a.model,
            fallbackModel,
          ) ?? undefined
        )
      })

      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        hidden() {
          return modelStore.hidden
        },
        hiddenProviders() {
          return modelStore.hiddenProviders
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((x) => x.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          setModelStore("model", agent.current().name, { ...val })
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          setModelStore("model", agent.current().name, { ...next })
          const uniq = uniqueBy([next, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
          if (uniq.length > 10) uniq.pop()
          setModelStore(
            "recent",
            uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
          )
          save()
        },
        set(
          model: { providerID: string; modelID: string },
          options?: { recent?: boolean; skipValidation?: boolean; announce?: boolean },
        ) {
          batch(() => {
            // Skip validation for dynamic models (e.g., Google API models fetched from API)
            if (!options?.skipValidation && !isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            setModelStore("model", agent.current().name, model)
            if (options?.recent) {
              const uniq = uniqueBy([model, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
              if (uniq.length > 10) uniq.pop()
              setModelStore(
                "recent",
                uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
              )
              save()
            }
            if (options?.announce) {
              toast.show({
                variant: "info",
                message: formatModelAnnouncement(model),
                duration: 3000,
              })
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }, options?: { skipValidation?: boolean }) {
          batch(() => {
            // Skip validation for dynamic models (e.g., Google API models fetched from API)
            // These models are already validated at their source and won't be in provider.models
            if (!options?.skipValidation && !isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
            save()
          })
        },
        toggleHidden(model: { providerID: string; modelID: string }) {
          batch(() => {
            const exists = modelStore.hidden.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.hidden.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.hidden]
            setModelStore(
              "hidden",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        toggleHiddenProvider(family: string) {
          batch(() => {
            const exists = modelStore.hiddenProviders.includes(family)
            const next = exists
              ? modelStore.hiddenProviders.filter((x) => x !== family)
              : [family, ...modelStore.hiddenProviders]
            setModelStore("hiddenProviders", next)
            save()
          })
        },
        isProviderHidden(family: string) {
          return modelStore.hiddenProviders.includes(family)
        },
        removeFromRecent(model: { providerID: string; modelID: string }) {
          batch(() => {
            const next = modelStore.recent.filter(
              (x) => x.providerID !== model.providerID || x.modelID !== model.modelID,
            )
            setModelStore("recent", next)
            save()
          })
        },
        variant: {
          current() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key]
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((x) => x.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            setModelStore("variant", key, value)
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    })

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    // Automatically update model when agent changes
    createEffect(() => {
      const value = agent.current()
      if (value?.model) {
        if (isModelValid(value.model))
          model.set({
            providerID: value.model.providerID,
            modelID: value.model.modelID,
          })
        else
          toast.show({
            variant: "warning",
            message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
            duration: 3000,
          })
      }
    })

    const result = {
      model,
      agent,
      mcp,
    }
    return result
  },
})
