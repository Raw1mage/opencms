import { EventEmitter } from "events"
import type { BusContext } from "./bus-context"

export const GlobalBus = new EventEmitter<{
  event: [
    {
      directory: string
      context: BusContext
      payload: any
    },
  ]
}>()
