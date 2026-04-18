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
    // Use SDK HTTP call instead of in-process Account.listAll() — in attach mode
    // the TUI process doesn't have the Account storage layer initialized.
    const [accountFamilies] = createResource(async () => {
      const res = await sdk.client.account.listAll()
      if (!res.data) return undefined
      // SDK returns { providers, families } — use providers (canonical)
      return (res.data as { providers?: Record<string, Account.ProviderData> }).providers
    })
    const accountDisplayNames = createMemo(() => {
      const families = accountFamilies()
      if (!families) return {}
      const map: Record<string, { label: string; providerKey: string }> = {}
      for (const [providerKey, data] of Object.entries(families)) {
        for (const [id, info] of Object.entries(data.accounts)) {
          map[id] = {
            label: Account.getDisplayName(id, info, providerKey),
            providerKey,
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
      const providerAccounts = accountFamilies()
      const providerKey = Account.parseProvider(providerId)
      if (providerKey && providerAccounts?.[providerKey]?.activeAccount) {
        const active = providerAccounts[providerKey]!.activeAccount
        if (active && labels[active]) return labels[active].label
      }
      return fallback
    }

    function availableAccountIds(providerId: string) {
      const providerAccounts = accountFamilies()
      const providerKey = Account.parseProvider(providerId) ?? providerId
      return Object.keys(providerAccounts?.[providerKey]?.accounts ?? {})
    }

    function replacementAccountId(providerId: string, currentAccountId?: string) {
      const providerAccounts = accountFamilies()
      const providerKey = Account.parseProvider(providerId) ?? providerId
      const providerData = providerAccounts?.[providerKey]
      const active = providerData?.activeAccount
      const ids = Object.keys(providerData?.accounts ?? {})
      if (active && active !== currentAccountId && ids.includes(active)) return active
      return ids.find((id) => id !== currentAccountId) ?? ids[0]
    }

    function sanitizeModelIdentity(model: {
      providerId: string
      modelID: string
      accountId?: string
    }): { providerId: string; modelID: string; accountId?: string } | undefined {
      const normalized = normalizeModelIdentity(model)
      if (!isModelAvailable(normalized)) return undefined
      if (!normalized.accountId) return normalized
      const ids = availableAccountIds(normalized.providerId)
      if (ids.length === 0) return { providerId: normalized.providerId, modelID: normalized.modelID }
      if (ids.includes(normalized.accountId)) return normalized
      const nextAccountId = replacementAccountId(normalized.providerId, normalized.accountId)
      if (!nextAccountId) return undefined
      return { ...normalized, accountId: nextAccountId }
    }

    function formatModelAnnouncement(model: { providerId: string; modelID: string; accountId?: string }) {
      const providerInfo = sync.data.provider.find((x) => x.id === model.providerId)
      const providerKey = Account.parseProvider(model.providerId) ?? model.providerId
      const providerKeyInfo = sync.data.provider.find((x) => x.id === providerKey)
      const providerLabel = providerKeyInfo?.name ?? providerInfo?.name ?? providerKey
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

    function normalizeModelIdentity(model: { providerId: string; modelID: string; accountId?: string }) {
      const normalizedProviderId = Account.parseProvider(model.providerId) ?? model.providerId
      return {
        providerId: normalizedProviderId,
        modelID: model.modelID,
        accountId: getModelAccountId(model),
      }
    }

    function getFirstValidModel(
      ...modelFns: (() => { providerId: string; modelID: string; accountId?: string } | undefined)[]
    ) {
      for (const modelFn of modelFns) {
        const raw = modelFn()
        if (!raw) continue
        const model = sanitizeModelIdentity(raw)
        if (model) return model
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
      const buildModelScopeKey = (agentName: string, sessionID?: string) => `${sessionID ?? "__global__"}::${agentName}`
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
                      if (Array.isArray(x.recent)) {
                        setModelStore("recent", x.recent.map(normalizeModelIdentity))
                      }
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
              if (Array.isArray(x.recent)) setModelStore("recent", x.recent.map(normalizeModelIdentity))
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

      const resolveScopedModel = (sessionID?: string) => {
        const a = agent.current()
        if (!a) return fallbackModel()
        if (sessionID) {
          return (
            getFirstValidModel(
              () => {
                const exec = sync.data.session.find((s) => s.id === sessionID)?.execution
                if (!exec) return undefined
                return {
                  providerId: exec.providerId,
                  modelID: exec.modelID,
                  accountId: exec.accountId,
                }
              },
              () => modelStore.model[buildModelScopeKey(a.name, sessionID)],
              () => a.model,
              fallbackModel,
            ) ?? undefined
          )
        }
        return (
          getFirstValidModel(
            () => modelStore.model[buildModelScopeKey(a.name, sessionID)],
            () => modelStore.model[a.name],
            () => a.model,
            fallbackModel,
          ) ?? undefined
        )
      }

      const currentModel = createMemo(() => resolveScopedModel())

      const currentAccountId = createMemo(() => currentModel()?.accountId)

      return {
        current(sessionID?: string) {
          return sessionID ? resolveScopedModel(sessionID) : currentModel()
        },
        currentAccountId(sessionID?: string) {
          return sessionID ? resolveScopedModel(sessionID)?.accountId : currentAccountId()
        },
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
          const providerKey = Account.parseProvider(value.providerId) ?? value.providerId
          const providerKeyInfo = sync.data.provider.find((x) => x.id === providerKey)
          const info = provider?.models[value.modelID]
          return {
            provider: providerKeyInfo?.name ?? provider?.name ?? providerKey,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1, sessionID?: string) {
          const current = sessionID ? resolveScopedModel(sessionID) : currentModel()
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
          setModelStore("model", buildModelScopeKey(agent.current().name, sessionID), { ...val })
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
          setModelStore("model", buildModelScopeKey(agent.current().name), { ...next })
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
        async set(
          model: { providerId: string; modelID: string; accountId?: string },
          options?: {
            recent?: boolean
            skipValidation?: boolean
            announce?: boolean
            interrupt?: boolean
            syncSessionExecution?: boolean
          },
          sessionID?: string,
        ) {
          if (sessionID && options?.interrupt) {
            await sdk.client.session.abort({ sessionID }).catch(() => {})
          }
          const normalized = normalizeModelIdentity(model)
          batch(() => {
            if (!options?.skipValidation && !isModelAvailable(normalized)) {
              toast.show({
                message: `Model ${normalized.providerId}/${normalized.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            setModelStore("model", buildModelScopeKey(agent.current().name, sessionID), normalized)
            if (options?.recent) {
              const uniq = uniqueBy(
                [normalized, ...modelStore.recent.map(normalizeModelIdentity)],
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
                message: formatModelAnnouncement(normalized),
                duration: 3000,
              })
            }
          })
          if (sessionID && options?.syncSessionExecution) {
            await sdk.client.session.update({
              sessionID,
              execution: {
                providerId: normalized.providerId,
                modelID: normalized.modelID,
                accountId: normalized.accountId,
              },
            })
          }
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
        toggleHiddenProvider(providerKey: string) {
          batch(() => {
            const exists = modelStore.hiddenProviders.includes(providerKey)
            const next = exists
              ? modelStore.hiddenProviders.filter((x) => x !== providerKey)
              : [providerKey, ...modelStore.hiddenProviders]
            setModelStore("hiddenProviders", next)
            save()
          })
        },
        isProviderHidden(providerKey: string) {
          return modelStore.hiddenProviders.includes(providerKey)
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
          current(sessionID?: string) {
            const m = sessionID ? resolveScopedModel(sessionID) : currentModel()
            if (!m) return undefined
            const key = `${m.providerId}/${m.modelID}`
            return modelStore.variant[key]
          },
          list(sessionID?: string) {
            const m = sessionID ? resolveScopedModel(sessionID) : currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((x) => x.id === m.providerId)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined, sessionID?: string) {
            const m = sessionID ? resolveScopedModel(sessionID) : currentModel()
            if (!m) return
            const key = `${m.providerId}/${m.modelID}`
            setModelStore("variant", key, value)
            save()
          },
          cycle(sessionID?: string) {
            const variants = this.list(sessionID)
            if (variants.length === 0) return
            const current = this.current(sessionID)
            if (!current) {
              this.set(variants[0], sessionID)
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined, sessionID)
              return
            }
            this.set(variants[index + 1], sessionID)
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
      resolveAccountLabel(accountId?: string, providerId?: string) {
        if (!accountId) return undefined
        return getAccountLabel(providerId ?? "", accountId, accountId)
      },
    }
    return result
  },
})
