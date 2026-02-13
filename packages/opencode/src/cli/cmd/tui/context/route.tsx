import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../component/prompt/history"
import { Env } from "@/env"

function createInitPromptToken() {
  return `init_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export type HomeRoute = {
  type: "home"
  initialPrompt?: PromptInfo
  initialPromptToken?: string
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  initialPrompt?: PromptInfo
  initialPromptToken?: string
}

export type Route = HomeRoute | SessionRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: () => {
    const [store, setStore] = createStore<Route>(
      Env.get("OPENCODE_ROUTE")
        ? JSON.parse(Env.get("OPENCODE_ROUTE")!)
        : {
            type: "home",
          },
    )

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        if (route.initialPrompt && !route.initialPromptToken) {
          setStore({ ...route, initialPromptToken: createInitPromptToken() })
          return
        }
        setStore(route)
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
