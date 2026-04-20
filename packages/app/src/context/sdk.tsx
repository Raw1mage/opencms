import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createEffect, createMemo, onCleanup, type Accessor } from "solid-js"
import { useGlobalSDK } from "./global-sdk"

function normalizeDirectoryKey(value: string) {
  if (!value || value === "global") return "global"
  const normalized = value.replaceAll("\\", "/")
  if (normalized === "/") return normalized
  return normalized.replace(/\/+$/, "")
}

type SDKEventMap = {
  [key in Event["type"]]: Extract<Event, { type: key }>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { directory: Accessor<string> }) => {
    const globalSDK = useGlobalSDK()

    const directory = createMemo(() => normalizeDirectoryKey(props.directory()))
    const client = createMemo(() =>
      createOpencodeClient({
        baseUrl: globalSDK.url,
        fetch: globalSDK.fetch,
        directory: directory(),
        throwOnError: true,
      }),
    )

    const emitter = createGlobalEmitter<SDKEventMap>()

    createEffect(() => {
      const unsub = globalSDK.event.on(directory(), (event) => {
        emitter.emit(event.type, event)
      })
      onCleanup(unsub)
    })

    return {
      get directory() {
        return directory()
      },
      get client() {
        return client()
      },
      get fetch() {
        return globalSDK.fetch
      },
      event: emitter,
      get url() {
        return globalSDK.url
      },
      // SSE liveness + manual reconnect — forwarded from globalSDK so submit
      // path can verify the inbound channel is alive before a prompt POST
      // (prevents the "send OK but reply never arrives" silent failure when
      // an idle SSE has been NAT-dropped upstream).
      lastEventAt: globalSDK.lastEventAt,
      forceSseReconnect: globalSDK.forceSseReconnect,
    }
  },
})
