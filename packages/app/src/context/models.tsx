import { createEffect, createMemo, createSignal } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { uniqueBy } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { useGlobalSDK } from "./global-sdk"
import { useGlobalSync } from "./global-sync"
import {
  buildUsersFromRemotePreferences,
  normalizePreferenceModel,
  preferenceModelKey,
  sameUserPreferences,
} from "./model-preferences"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility?: Visibility; favorite?: boolean }
type Store = {
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}
type UserStore = {
  user: User[]
}

const RECENT_LIMIT = 5

function normalizeUsers(input: User[]) {
  return input.map((item) => {
    if (item.favorite === true) {
      if (item.visibility === "show") return item
      return { ...item, visibility: "show" as const }
    }
    if (item.visibility === "hide" && item.favorite === false) return item
    if (item.visibility === "show") {
      return { ...item, favorite: true }
    }
    if (item.visibility === "hide") {
      return { ...item, favorite: false }
    }
    return item
  })
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  init: () => {
    const providers = useProviders()
    const globalSDK = useGlobalSDK()
    const globalSync = useGlobalSync()

    const [userStore, setUserStore] = createStore<UserStore>({ user: [] })
    const [store, setStore] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        recent: [],
        variant: {},
      }),
    )
    const [serverReady, setServerReady] = createSignal(false)
    const ready = serverReady

    const remoteSync = {
      loaded: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      retryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      hiddenProviders: [] as string[],
      mutationVersion: 0,
      readVersion: 0,
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

    const replaceUsers = (next: User[]) => {
      const normalized = normalizeUsers(next)
      if (sameUserPreferences(userStore.user, normalized)) return
      setUserStore("user", normalized)
    }

    const mutateUsers = (updater: (current: User[]) => User[]) => {
      remoteSync.mutationVersion += 1
      replaceUsers(updater(userStore.user))
    }

    const update = (model: ModelKey, partial: Partial<Omit<User, "providerID" | "modelID">>) => {
      mutateUsers((current) => {
        const normalized = normalizePreferenceModel(model)
        const key = preferenceModelKey(normalized)
        const index = current.findIndex((x) => preferenceModelKey(x) === key)
        if (index >= 0) {
          const next = current.slice()
          next[index] = { ...next[index], ...partial }
          return next
        }
        return [
          ...current,
          {
            ...normalized,
            ...partial,
          },
        ]
      })
    }

    const visible = (model: ModelKey) => {
      const key = preferenceModelKey(model)
      const user = userStore.user.find((x) => preferenceModelKey(x) === key)
      return user?.favorite ?? true
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      if (state) {
        update(model, { visibility: "show", favorite: true })
      } else {
        update(model, { visibility: "hide", favorite: false })
      }
      scheduleRemoteSave()
    }

    const isFavorite = (model: ModelKey) => {
      const key = preferenceModelKey(model)
      const user = userStore.user.find((x) => preferenceModelKey(x) === key)
      return user?.favorite ?? true
    }

    const favoriteList = createMemo(() =>
      userStore.user.filter((x) => x.favorite).map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
    )

    const isEnabled = (model: ModelKey) => {
      const key = preferenceModelKey(model)
      const user = userStore.user.find((x) => preferenceModelKey(x) === key)
      return user ? user.visibility === "show" : true
    }

    const toggleFavorite = (model: ModelKey) => {
      setVisibility(model, !isFavorite(model))
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

    const applyRemotePreferences = (
      prefs: {
        favorite: Array<{ providerId: string; modelID: string }>
        hidden: Array<{ providerId: string; modelID: string }>
        hiddenProviders: string[]
      },
      readVersion: number,
    ) => {
      remoteSync.hiddenProviders = prefs.hiddenProviders
      if (readVersion !== remoteSync.readVersion) return
      if (remoteSync.mutationVersion > readVersion) return
      replaceUsers(buildUsersFromRemotePreferences(prefs))
    }

    const writeRemotePreferences = async (writeVersion: number, snapshot: readonly User[], hiddenProviders: string[]) => {
      const favorite = new Map<string, { providerId: string; modelID: string }>()
      const hidden = new Map<string, { providerId: string; modelID: string }>()

      for (const item of snapshot) {
        const providerId = normalizePreferenceModel(item).providerID
        const key = `${providerId}:${item.modelID}`
        if (item.favorite) favorite.set(key, { providerId, modelID: item.modelID })
        if (item.visibility === "hide") hidden.set(key, { providerId, modelID: item.modelID })
      }

      await globalSDK.fetch(`${globalSDK.url}/api/v2/model/preferences`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          favorite: Array.from(favorite.values()),
          hidden: Array.from(hidden.values()),
          hiddenProviders,
        }),
      })
      if (writeVersion !== remoteSync.writeVersion) return
    }

    const scheduleRemoteSave = () => {
      if (!remoteSync.loaded) return
      if (remoteSync.timer) clearTimeout(remoteSync.timer)
      const writeVersion = ++remoteSync.writeVersion
      const snapshot = unwrap(userStore.user)
      const hiddenProviders = [...remoteSync.hiddenProviders]
      remoteSync.timer = setTimeout(() => {
        remoteSync.timer = undefined
        void writeRemotePreferences(writeVersion, snapshot, hiddenProviders).catch(() => undefined)
      }, 150)
    }

    createEffect(() => {
      remoteRetryTick()
      if (remoteSync.loaded) return
      const url = globalSDK.url
      if (!url) return
      const readVersion = remoteSync.mutationVersion
      remoteSync.readVersion = readVersion
      void readRemotePreferences()
        .then((prefs) => {
          applyRemotePreferences(prefs, readVersion)
          remoteSync.loaded = true
          setServerReady(true)
        })
        .catch(() => {
          if (remoteSync.retryTimer) clearTimeout(remoteSync.retryTimer)
          remoteSync.retryTimer = setTimeout(() => setRemoteRetryTick((x) => x + 1), 1000)
        })
    })

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
      isFavorite,
      favoriteList,
      toggleFavorite,
      isEnabled,
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
