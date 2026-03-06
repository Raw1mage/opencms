import { createEffect, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { uniqueBy } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { useGlobalSDK } from "./global-sdk"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility?: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

const KNOWN_PROVIDER_FAMILIES = [
  "opencode",
  "anthropic",
  "claude-cli",
  "openai",
  "github-copilot",
  "gemini-cli",
  "google-api",
  "antigravity",
  "gmicloud",
  "openrouter",
  "vercel",
  "gitlab",
] as const

function normalizeProviderFamily(id: unknown): string {
  if (typeof id !== "string") return ""
  const raw = id.trim().toLowerCase()
  if (!raw) return ""
  if (raw.includes(":")) return normalizeProviderFamily(raw.split(":")[0]!)
  if (raw === "google") return "google-api"

  for (const provider of KNOWN_PROVIDER_FAMILIES) {
    if (raw === provider || raw.startsWith(`${provider}-`)) return provider
  }

  const apiMatch = raw.match(/^(.+)-api-/)
  if (apiMatch) return apiMatch[1]!
  const subscriptionMatch = raw.match(/^(.+)-subscription-/)
  if (subscriptionMatch) return subscriptionMatch[1]!
  return raw
}

function modelKey(model: ModelKey) {
  return `${normalizeProviderFamily(model.providerID)}:${model.modelID ?? ""}`
}

function normalizeModel(model: ModelKey): ModelKey {
  const providerID = normalizeProviderFamily(model.providerID) || String(model.providerID ?? "")
  return {
    providerID,
    modelID: String(model.modelID ?? ""),
  }
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  init: () => {
    const providers = useProviders()
    const globalSDK = useGlobalSDK()

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
      }),
    )

    const remoteSync = {
      loaded: false,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      retryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
      hiddenProviders: [] as string[],
    }
    const [remoteRetryTick, setRemoteRetryTick] = createSignal(0)

    const available = createMemo(() =>
      providers.all().flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
        })),
      ),
    )

    const list = createMemo(() =>
      available().map((m) => ({
        ...m,
        name: m.name.replace("(latest)", "").trim(),
        latest: m.name.includes("(latest)"),
      })),
    )

    const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

    const update = (model: ModelKey, partial: Partial<Omit<User, "providerID" | "modelID">>) => {
      const normalized = normalizeModel(model)
      const key = modelKey(normalized)
      const index = store.user.findIndex((x) => modelKey(x) === key)
      if (index >= 0) {
        setStore("user", index, partial)
        return
      }
      setStore("user", store.user.length, {
        ...normalized,
        ...partial,
      })
    }

    const visible = (model: ModelKey) => {
      const key = modelKey(model)
      const user = store.user.find((x) => modelKey(x) === key)
      return user?.favorite ?? false
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
      const key = modelKey(model)
      const user = store.user.find((x) => modelKey(x) === key)
      return user?.favorite ?? false
    }

    const favoriteList = createMemo(() =>
      store.user.filter((x) => x.favorite).map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
    )

    const isEnabled = (model: ModelKey) => {
      const key = modelKey(model)
      const user = store.user.find((x) => modelKey(x) === key)
      return user?.visibility === "show"
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

    const applyRemotePreferences = (prefs: {
      favorite: Array<{ providerId: string; modelID: string }>
      hidden: Array<{ providerId: string; modelID: string }>
      hiddenProviders: string[]
    }) => {
      remoteSync.hiddenProviders = prefs.hiddenProviders
      const favoriteSet = new Set(
        prefs.favorite.map((item) => `${normalizeProviderFamily(item.providerId)}:${item.modelID}`),
      )
      const hiddenSet = new Set(
        prefs.hidden.map((item) => `${normalizeProviderFamily(item.providerId)}:${item.modelID}`),
      )
      const merged = new Map<string, User>()

      for (const key of hiddenSet) {
        const [providerID, modelID] = key.split(":")
        if (!providerID || !modelID) continue
        merged.set(key, {
          providerID,
          modelID,
          visibility: "hide",
          favorite: false,
        })
      }

      for (const key of favoriteSet) {
        const [providerID, modelID] = key.split(":")
        if (!providerID || !modelID) continue
        merged.set(key, {
          providerID,
          modelID,
          visibility: "show",
          favorite: true,
        })
      }

      setStore("user", Array.from(merged.values()))
    }

    const writeRemotePreferences = async () => {
      const favorite = new Map<string, { providerId: string; modelID: string }>()
      const hidden = new Map<string, { providerId: string; modelID: string }>()

      for (const item of store.user) {
        const providerId = normalizeProviderFamily(item.providerID)
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
          hiddenProviders: remoteSync.hiddenProviders,
        }),
      })
    }

    const scheduleRemoteSave = () => {
      if (!remoteSync.loaded) return
      if (remoteSync.timer) clearTimeout(remoteSync.timer)
      remoteSync.timer = setTimeout(() => {
        remoteSync.timer = undefined
        void writeRemotePreferences().catch(() => undefined)
      }, 150)
    }

    createEffect(() => {
      remoteRetryTick()
      if (!ready()) return
      if (remoteSync.loaded) return
      const url = globalSDK.url
      if (!url) return
      void readRemotePreferences()
        .then((prefs) => {
          applyRemotePreferences(prefs)
          remoteSync.loaded = true
        })
        .catch(() => {
          if (remoteSync.retryTimer) clearTimeout(remoteSync.retryTimer)
          remoteSync.retryTimer = setTimeout(() => setRemoteRetryTick((x) => x + 1), 1000)
        })
    })

    createEffect(() => {
      if (!ready()) return
      const normalized = store.user.map((item) => {
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
      const changed = normalized.some((item, index) => {
        const current = store.user[index]
        return current?.favorite !== item.favorite || current?.visibility !== item.visibility
      })
      if (changed) setStore("user", normalized)
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
