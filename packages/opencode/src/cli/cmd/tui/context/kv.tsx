import { Global } from "@/global"
import { createSignal, type Setter } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import path from "path"

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, any>>({})
    const file = Bun.file(path.join(Global.Path.state, "kv.json"))

    file
      .json()
      .then((x) => {
        if (x && typeof x === "object") {
          try {
            setStore(reconcile(x))
          } catch (e) {
            console.error("KV setStore failed", e)
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        try {
          setReady(true)
        } catch (e) {}
      })

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name)
          },
          function setter(next: Setter<T>) {
            result.set(name, next)
          },
        ] as const
      },
      get(key: string, defaultValue?: any) {
        return store[key] ?? defaultValue
      },
      set(key: string, value: any) {
        setStore(key, value)
        Bun.write(file, JSON.stringify(store, null, 2))
      },
    }
    return result
  },
})
