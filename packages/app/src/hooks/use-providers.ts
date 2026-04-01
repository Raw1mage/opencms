import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { buildCustomProviderEntries } from "@/components/model-selector-state"
import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"

export const popularProviders = [
  "opencode",
  "claude-cli",
  "github-copilot",
  "openai",
  "gemini-cli",
  "google-api",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const currentDirectory = createMemo(() => decode64(params.dir) ?? "")
  const providers = createMemo(() => {
    if (currentDirectory()) {
      const [projectStore] = globalSync.child(currentDirectory())
      return projectStore.provider
    }
    return globalSync.data.provider
  })
  const connectedIDs = createMemo(() => new Set(providers().connected))
  const all = createMemo(() => {
    const base = providers().all
    const merged = new Map<string, (typeof base)[number]>()
    for (const provider of base) merged.set(provider.id, provider)
    for (const provider of buildCustomProviderEntries(globalSync.data.config.provider) as Array<
      (typeof base)[number]
    >) {
      if (!merged.has(provider.id)) merged.set(provider.id, provider)
    }
    return Array.from(merged.values())
  })
  const connected = createMemo(() => all().filter((p) => connectedIDs().has(p.id)))
  const paid = createMemo(() =>
    connected().filter((p) => p.id !== "opencode" || Object.values(p.models).find((m) => m.cost?.input)),
  )
  const popular = createMemo(() => all().filter((p) => popularProviderSet.has(p.id)))
  return {
    all,
    default: createMemo(() => providers().default),
    popular,
    connected,
    paid,
  }
}
