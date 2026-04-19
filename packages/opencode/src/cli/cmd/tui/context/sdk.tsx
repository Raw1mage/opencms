import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createSignal, onCleanup, onMount } from "solid-js"

export type EventSource = {
  on: (handler: (event: Event) => void) => () => void
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { url: string; directory?: string; fetch?: typeof fetch; events?: EventSource }) => {
    const [activeDirectory, setActiveDirectory] = createSignal(props.directory)

    let currentAbort = new AbortController()

    const buildClient = (dir?: string) =>
      createOpencodeClient({
        baseUrl: props.url,
        signal: currentAbort.signal,
        directory: dir,
        fetch: props.fetch,
      })

    const [currentClient, setCurrentClient] = createSignal(buildClient(props.directory))

    const emitter = createGlobalEmitter<{
      [key in Event["type"]]: Extract<Event, { type: key }>
    }>()

    let queue: Event[] = []
    let timer: Timer | undefined
    let last = 0

    const flush = () => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (queue.length === 0) return

      const events = queue
      queue = []
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit(event.type, event)
        }
      })
    }

    const handleEvent = (event: Event) => {
      queue.push(event)
      if (timer) return

      const elapsed = Date.now() - last
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16 - elapsed)
        return
      }
      flush()
    }

    // SSE loop — can be (re-)invoked after directory switch
    const runSSE = async (client: ReturnType<typeof buildClient>, signal: AbortSignal) => {
      while (true) {
        if (signal.aborted) break
        try {
          const events = await client.event.subscribe({}, { signal })

          for await (const event of events.stream) {
            handleEvent(event)
          }

          // Flush any remaining events
          if (timer) clearTimeout(timer)
          if (queue.length > 0) {
            flush()
          }
        } catch (e) {
          // If aborted, just break
          if (signal.aborted) break

          // Log specific error but don't crash
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    }

    onMount(async () => {
      // If an event source is provided, use it instead of SSE
      if (props.events) {
        const unsub = props.events.on(handleEvent)
        onCleanup(unsub)
        return
      }

      runSSE(currentClient(), currentAbort.signal)
    })

    onCleanup(() => {
      currentAbort.abort()
      if (timer) clearTimeout(timer)
    })

    const switchDirectory = (newDir: string) => {
      // Tear down old connection
      currentAbort.abort()
      currentAbort = new AbortController()

      setActiveDirectory(newDir)
      const next = buildClient(newDir)
      setCurrentClient(next)

      // Re-establish SSE unless using external event source
      if (!props.events) {
        runSSE(next, currentAbort.signal)
      }
    }

    return {
      get client() {
        return currentClient()
      },
      event: emitter,
      url: props.url,
      get fetch() {
        return props.fetch ?? fetch
      },
      get directory() {
        return activeDirectory()
      },
      switchDirectory,
      ready: true,
    }
  },
})
