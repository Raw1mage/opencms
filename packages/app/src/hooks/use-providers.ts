import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { isSupportedProviderKey } from "@/utils/provider-registry"
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
  const all = createMemo(() => providers().all.filter((p) => isSupportedProviderKey(p.id)))
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
