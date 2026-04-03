import { createEffect, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { uniqueBy } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { useGlobalSDK } from "./global-sdk"
import { useGlobalSync } from "./global-sync"
import {
  buildHiddenSetFromRemote,
  normalizePreferenceModel,
  preferenceModelKey,
} from "./model-preferences"

export type ModelKey = { providerID: string; modelID: string }

type Store = {
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  init: () => {
    const providers = useProviders()
    const globalSDK = useGlobalSDK()
    const globalSync = useGlobalSync()

    // recent + variant stay in localStorage (per-browser UX)
    const [store, setStore] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        recent: [],
        variant: {},
      }),
    )

    // Server-sourced visibility state
    const [hiddenModels, setHiddenModels] = createSignal(new Set<string>())
    const [hiddenProviders, setHiddenProviders] = createSignal<string[]>([])
    // Pass-through: TUI's favorite[] — webapp never modifies this
    const [tuiFavorites, setTuiFavorites] = createSignal<Array<{ providerId: string; modelID: string }>>([])
    const [serverReady, setServerReady] = createSignal(false)
    const ready = serverReady

    const remoteSync = {
      loaded: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      retryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      mutationVersion: 0,
      writeVersion: 0,
    }
    const [remoteRetryTick, setRemoteRetryTick] = createSignal(0)

    const modelProviders = createMemo(() => {
      const merged = new Map<string, any>()

      for (const provider of providers.all()) {
        merged.set(provider.id, provider)
      }

      for (const [providerId, provider] of Object.entries(globalSync.data.config.provider ?? {})) {
        if (merged.has(providerId)) continue
        if (provider?.npm !== "@ai-sdk/openai-compatible") continue
        if (!provider.models || typeof provider.models !== "object") continue

        merged.set(providerId, {
          id: providerId,
          name: provider.name ?? providerId,
          source: "custom",
          models: Object.fromEntries(
            Object.entries(provider.models).map(([modelId, model]) => [
              modelId,
              {
                id: modelId,
                name: model.name ?? modelId,
                limit: {
                  context: model.limit?.context ?? 0,
                  output: model.limit?.output ?? 0,
                },
                cost: { input: 0, output: 0 },
                capabilities: {
                  reasoning: false,
                  input: { text: true, image: false, audio: false, video: false, pdf: false },
                  output: { text: true, image: false, audio: false, video: false, pdf: false },
                  temperature: false,
                  toolcall: true,
                  interleaved: false,
                },
              },
            ]),
          ),
        })
      }

      return Array.from(merged.values())
    })

    const available = createMemo<any[]>(() =>
      modelProviders().flatMap((p) =>
        Object.values(p.models as Record<string, Record<string, unknown>>).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )

    const list = createMemo<any[]>(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    /** true = visible (default), false = hidden */
    const visible = (model: ModelKey) => {
      const key = preferenceModelKey(model)
      return !hiddenModels().has(key)
    }

    const setVisibility = (model: ModelKey, show: boolean) => {
      const key = preferenceModelKey(normalizePreferenceModel(model))
      setHiddenModels((prev) => {
        const next = new Set(prev)
        if (show) next.delete(key)
        else next.add(key)
        return next
      })
      remoteSync.mutationVersion += 1
      scheduleRemoteSave()
    }

    const readRemotePreferences = async () => {
      const response = await globalSDK.fetch(`${globalSDK.url}/api/v2/model/preferences`)
      if (!response.ok) throw new Error(`model preferences fetch failed (${response.status})`)
      const payload = (await response.json()) as {
        favorite?: Array<{ providerId: string; modelID: string }>
        hidden?: Array<{ providerId: string; modelID: string }>
        hiddenProviders?: string[]
      }
      return {
        favorite: Array.isArray(payload.favorite) ? payload.favorite : [],
        hidden: Array.isArray(payload.hidden) ? payload.hidden : [],
        hiddenProviders: Array.isArray(payload.hiddenProviders) ? payload.hiddenProviders : [],
      }
    }

    const applyRemotePreferences = (prefs: {
      favorite: Array<{ providerId: string; modelID: string }>
      hidden: Array<{ providerId: string; modelID: string }>
      hiddenProviders: string[]
    }) => {
      setHiddenModels(buildHiddenSetFromRemote(prefs.hidden))
      setHiddenProviders(prefs.hiddenProviders)
      setTuiFavorites(prefs.favorite)
    }

    const writeRemotePreferences = async (writeVersion: number) => {
      const hidden = Array.from(hiddenModels()).map((key) => {
        const [providerId, modelID] = key.split(":")
        return { providerId: providerId ?? "", modelID: modelID ?? "" }
      })
      await globalSDK.fetch(`${globalSDK.url}/api/v2/model/preferences`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          favorite: tuiFavorites(), // pass-through: never modified by webapp
          hidden,
          hiddenProviders: hiddenProviders(),
        }),
      })
      if (writeVersion !== remoteSync.writeVersion) return
    }

    const scheduleRemoteSave = () => {
      if (!remoteSync.loaded) return
      if (remoteSync.timer) clearTimeout(remoteSync.timer)
      const writeVersion = ++remoteSync.writeVersion
      remoteSync.timer = setTimeout(() => {
        remoteSync.timer = undefined
        void writeRemotePreferences(writeVersion).catch(() => undefined)
      }, 150)
    }

    createEffect(() => {
      remoteRetryTick()
      if (remoteSync.loaded) return
      const url = globalSDK.url
      if (!url) return
      void readRemotePreferences()
        .then((prefs) => {
          if (remoteSync.mutationVersion === 0) applyRemotePreferences(prefs)
          remoteSync.loaded = true
          setServerReady(true)
        })
        .catch(() => {
          if (remoteSync.retryTimer) clearTimeout(remoteSync.retryTimer)
          remoteSync.retryTimer = setTimeout(() => setRemoteRetryTick((x) => x + 1), 1000)
        })
    })

    const setProviderHidden = (providerKey: string, hidden: boolean) => {
      setHiddenProviders((prev) => {
        const next = prev.filter((k) => k !== providerKey)
        if (hidden) next.push(providerKey)
        return next
      })
      remoteSync.mutationVersion += 1
      scheduleRemoteSave()
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    return {
      ready,
      list,
      find,
      visible,
      setVisibility,
      hiddenProviders,
      setProviderHidden,
      recent: {
        list: createMemo(() => store.recent),
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})
