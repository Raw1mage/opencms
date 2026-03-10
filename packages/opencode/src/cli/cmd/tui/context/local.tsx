import { createStore } from "solid-js/store"
import { batch, createEffect, createMemo, createResource, onCleanup } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { uniqueBy } from "remeda"
import path from "path"
import { watch } from "fs"
import { mkdir } from "fs/promises"
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

    const mcpRefreshState: {
      inFlight: boolean
      pending: boolean
      timer?: ReturnType<typeof setTimeout>
    } = {
      inFlight: false,
      pending: false,
      timer: undefined,
    }

    async function refreshMcpStatus() {
      if (mcpRefreshState.inFlight) {
        mcpRefreshState.pending = true
        return
      }
      mcpRefreshState.inFlight = true
      const status = await sdk.client.mcp.status().catch(() => undefined)
      if (status?.data) {
        sync.set("mcp", status.data)
      }
      mcpRefreshState.inFlight = false
      if (mcpRefreshState.pending) {
        mcpRefreshState.pending = false
        queueMicrotask(() => {
          refreshMcpStatus().catch(() => {})
        })
      }
    }

    function scheduleMcpStatusRefresh(delay = 150) {
      if (mcpRefreshState.timer) clearTimeout(mcpRefreshState.timer)
      mcpRefreshState.timer = setTimeout(() => {
        mcpRefreshState.timer = undefined
        refreshMcpStatus().catch(() => {})
      }, delay)
    }

    onCleanup(() => {
      if (mcpRefreshState.timer) clearTimeout(mcpRefreshState.timer)
    })

    function getAccountLabel(providerId: string, fallback: string, accountId?: string) {
      const labels = accountDisplayNames()
      if (!labels || Object.keys(labels).length === 0) return fallback
      if (accountId && labels[accountId]) return labels[accountId].label
      if (labels[providerId]) return labels[providerId].label
      const families = accountFamilies()
      const family = Account.parseProvider(providerId)
      if (family && families?.[family]?.activeAccount) {
        const active = families[family]!.activeAccount
        if (active && labels[active]) return labels[active].label
      }
      return fallback
    }

    function formatModelAnnouncement(model: { providerId: string; modelID: string; accountId?: string }) {
      const providerInfo = sync.data.provider.find((x) => x.id === model.providerId)
      const familyId = Account.parseProvider(model.providerId) ?? model.providerId
      const familyProviderInfo = sync.data.provider.find((x) => x.id === familyId)
      const providerLabel = familyProviderInfo?.name ?? providerInfo?.name ?? familyId
      const modelLabel = providerInfo?.models[model.modelID]?.name ?? model.modelID
      const accountLabel = getAccountLabel(model.providerId, "default account", model.accountId)
      return `《${providerLabel}, ${accountLabel}, ${modelLabel}》`
    }

    function isModelAvailable(model: { providerId: string; modelID: string; accountId?: string }) {
      const provider = sync.data.provider.find((x) => x.id === model.providerId)
      return !!provider
    }

    function getModelAccountId(model: { providerId: string; modelID: string; accountId?: string }) {
      return "accountId" in model ? model.accountId : undefined
    }

    function getFirstValidModel(
      ...modelFns: (() => { providerId: string; modelID: string; accountId?: string } | undefined)[]
    ) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelAvailable(model)) return model
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
            providerId: string
            modelID: string
            accountId?: string
          }
        >
        recent: {
          providerId: string
          modelID: string
          accountId?: string
        }[]
        favorite: {
          providerId: string
          modelID: string
        }[]
        hidden: {
          providerId: string
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

      const modelPath = path.join(Global.Path.state, "model.json")
      const file = Bun.file(modelPath)
      const state = {
        pending: false,
      }

      async function ensureModelStateFile() {
        await mkdir(Global.Path.state, { recursive: true })
        if (!(await file.exists())) {
          await Bun.write(
            file,
            JSON.stringify({
              recent: [],
              favorite: [],
              hidden: [],
              hiddenProviders: [],
              variant: {},
            }),
          )
        }
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

      let watcher: ReturnType<typeof watch> | undefined

      ensureModelStateFile()
        .catch(() => undefined)
        .finally(() => {
          try {
            watcher = watch(modelPath, (event) => {
              if (event === "change") {
                file
                  .json()
                  .then((x) => {
                    batch(() => {
                      if (Array.isArray(x.recent)) setModelStore("recent", x.recent)
                      if (Array.isArray(x.favorite)) setModelStore("favorite", x.favorite)
                      if (Array.isArray(x.hidden)) setModelStore("hidden", x.hidden)
                      if (Array.isArray(x.hiddenProviders)) setModelStore("hiddenProviders", x.hiddenProviders)
                      if (typeof x.variant === "object" && x.variant !== null) setModelStore("variant", x.variant)
                    })
                  })
                  .catch(() => {})
              }
            })
          } catch {}
        })

      onCleanup(() => {
        watcher?.close()
      })

      // Watch for external changes to opencode.json for default_agent updates
      iife(() => {
        const configPath = path.join(Global.Path.config, "opencode.json")
        try {
          const watcher = watch(configPath, (event) => {
            if (event === "change") {
              Bun.file(configPath)
                .json()
                .then((config) => {
                  if (config.default_agent) {
                    agent.set(config.default_agent)
                  }
                })
                .catch(() => {})

              // Keep TUI MCP taskbar in sync when MCP enabled state is changed
              // externally (eg. system-manager toggle_mcp).
              scheduleMcpStatusRefresh()
            }
          })
          onCleanup(() => watcher.close())
        } catch (e) {}
      })

      // Auto-cleanup removed: allow favorites/recent even if model ID is not in provider.models

      ensureModelStateFile()
        .catch(() => undefined)
        .finally(() =>
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
            }),
        )

      const args = useArgs()
      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerId, modelID } = Provider.parseModel(args.model)
          if (isModelAvailable({ providerId, modelID })) {
            return {
              providerId,
              modelID,
            }
          }
        }

        if (sync.data.config.model) {
          const parsed =
            typeof sync.data.config.model === "string"
              ? Provider.parseModel(sync.data.config.model)
              : {
                  providerId: sync.data.config.model.providerId,
                  modelID: sync.data.config.model.id,
                }
          const { providerId, modelID } = parsed
          if (isModelAvailable({ providerId, modelID })) {
            return {
              providerId,
              modelID,
            }
          }
        }

        for (const item of modelStore.recent) {
          if (isModelAvailable(item)) {
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
          providerId: provider.id,
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

      const currentAccountId = createMemo(() => currentModel()?.accountId)

      return {
        current: currentModel,
        currentAccountId,
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
          const provider = sync.data.provider.find((x) => x.id === value.providerId)
          const familyId = Account.parseProvider(value.providerId) ?? value.providerId
          const familyProvider = sync.data.provider.find((x) => x.id === familyId)
          const info = provider?.models[value.modelID]
          return {
            provider: familyProvider?.name ?? provider?.name ?? familyId,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex(
            (x) =>
              x.providerId === current.providerId &&
              x.modelID === current.modelID &&
              getModelAccountId(x) === current.accountId,
          )
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          setModelStore("model", agent.current().name, { ...val })
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelAvailable(item))
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
            index = favorites.findIndex((x) => x.providerId === current.providerId && x.modelID === current.modelID)
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
          const uniq = uniqueBy(
            [next, ...modelStore.recent],
            (x) => `${x.providerId}/${x.modelID}/${getModelAccountId(x) ?? ""}`,
          )
          if (uniq.length > 10) uniq.pop()
          setModelStore(
            "recent",
            uniq.map((x) => ({ providerId: x.providerId, modelID: x.modelID, accountId: getModelAccountId(x) })),
          )
          save()
        },
        set(
          model: { providerId: string; modelID: string; accountId?: string },
          options?: { recent?: boolean; skipValidation?: boolean; announce?: boolean },
        ) {
          batch(() => {
            if (!options?.skipValidation && !isModelAvailable(model)) {
              toast.show({
                message: `Model ${model.providerId}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            setModelStore("model", agent.current().name, model)
            if (options?.recent) {
              const uniq = uniqueBy(
                [model, ...modelStore.recent],
                (x) => `${x.providerId}/${x.modelID}/${x.accountId ?? ""}`,
              )
              if (uniq.length > 10) uniq.pop()
              setModelStore(
                "recent",
                uniq.map((x) => ({ providerId: x.providerId, modelID: x.modelID, accountId: x.accountId })),
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
        toggleFavorite(model: { providerId: string; modelID: string }, options?: { skipValidation?: boolean }) {
          batch(() => {
            if (!options?.skipValidation && !isModelAvailable(model)) {
              toast.show({
                message: `Model ${model.providerId}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerId === model.providerId && x.modelID === model.modelID,
            )
            const isHidden = modelStore.hidden.some(
              (x) => x.providerId === model.providerId && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerId !== model.providerId || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            const nextHidden =
              !exists && isHidden
                ? modelStore.hidden.filter((x) => x.providerId !== model.providerId || x.modelID !== model.modelID)
                : modelStore.hidden
            setModelStore(
              "favorite",
              next.map((x) => ({ providerId: x.providerId, modelID: x.modelID })),
            )
            if (!exists && isHidden) {
              setModelStore(
                "hidden",
                nextHidden.map((x) => ({ providerId: x.providerId, modelID: x.modelID })),
              )
            }
            save()
            toast.show({
              message: exists ? `${model.modelID} removed` : `${model.modelID} added`,
              variant: "info",
              duration: 2000,
            })
          })
        },
        toggleHidden(model: { providerId: string; modelID: string }) {
          batch(() => {
            const exists = modelStore.hidden.some(
              (x) => x.providerId === model.providerId && x.modelID === model.modelID,
            )
            const wasFavorite = modelStore.favorite.some(
              (x) => x.providerId === model.providerId && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.hidden.filter((x) => x.providerId !== model.providerId || x.modelID !== model.modelID)
              : [model, ...modelStore.hidden]
            const nextFavorite =
              !exists && wasFavorite
                ? modelStore.favorite.filter((x) => x.providerId !== model.providerId || x.modelID !== model.modelID)
                : modelStore.favorite
            setModelStore(
              "hidden",
              next.map((x) => ({ providerId: x.providerId, modelID: x.modelID })),
            )
            if (!exists && wasFavorite) {
              setModelStore(
                "favorite",
                nextFavorite.map((x) => ({ providerId: x.providerId, modelID: x.modelID })),
              )
            }
            save()
            toast.show({
              message: exists ? `${model.modelID} unhidden` : `${model.modelID} hidden`,
              variant: "info",
              duration: 2000,
            })
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
        removeFromRecent(model: { providerId: string; modelID: string }) {
          batch(() => {
            const next = modelStore.recent.filter(
              (x) => x.providerId !== model.providerId || x.modelID !== model.modelID,
            )
            setModelStore("recent", next)
            save()
          })
        },
        variant: {
          current() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerId}/${m.modelID}`
            return modelStore.variant[key]
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((x) => x.id === m.providerId)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerId}/${m.modelID}`
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
      async refresh() {
        await refreshMcpStatus()
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
        await refreshMcpStatus()
      },
    }

    // Automatically update model when agent changes
    createEffect(() => {
      const value = agent.current()
      if (value?.model) {
        if (isModelAvailable(value.model))
          model.set({
            providerId: value.model.providerId,
            modelID: value.model.modelID,
          })
        else
          toast.show({
            variant: "warning",
            message: `Agent ${value.name}'s configured model ${value.model.providerId}/${value.model.modelID} is not valid`,
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
