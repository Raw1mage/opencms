import z from "zod"
import { emitDebug } from "../bus/sink"
import { DEBUG_LOG_PATH } from "./debug"

export namespace Log {
  export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
  export type Level = z.infer<typeof Level>

  const levelPriority: Record<Level, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  let level: Level = "INFO"

  function shouldLog(input: Level): boolean {
    return levelPriority[input] >= levelPriority[level]
  }

  export type Logger = {
    debug(message?: any, extra?: Record<string, any>): void
    info(message?: any, extra?: Record<string, any>): void
    error(message?: any, extra?: Record<string, any>): void
    warn(message?: any, extra?: Record<string, any>): void
    tag(key: string, value: string): Logger
    clone(): Logger
    time(
      message: string,
      extra?: Record<string, any>,
    ): {
      stop(): void
      [Symbol.dispose](): void
    }
  }

  const loggers = new Map<string, Logger>()

  export const Default = create({ service: "default" })

  export interface Options {
    print: boolean
    dev?: boolean
    level?: Level
  }

  export function file() {
    return DEBUG_LOG_PATH
  }

  let printToStderr = false

  export async function init(options: Options) {
    if (options.level) level = options.level
    printToStderr = options.print
  }

  function formatMessage(message: any): string {
    if (message instanceof Error) return message.stack ?? message.message
    if (typeof message === "string") return message
    if (message === undefined) return ""
    if (message === null) return "null"
    if (typeof message === "object") return JSON.stringify(message)
    return String(message)
  }

  export function create(tags?: Record<string, any>) {
    tags = tags || {}

    const service = tags["service"]
    if (service && typeof service === "string") {
      const cached = loggers.get(service)
      if (cached) {
        return cached
      }
    }

    const result: Logger = {
      debug(message?: any, extra?: Record<string, any>) {
        if (shouldLog("DEBUG")) {
          emitDebug("log", `DEBUG ${formatMessage(message)}`, extra ? { ...tags, ...extra } : tags)
          if (printToStderr) process.stderr.write(`DEBUG ${formatMessage(message)}\n`)
        }
      },
      info(message?: any, extra?: Record<string, any>) {
        if (shouldLog("INFO")) {
          emitDebug("log", `INFO ${formatMessage(message)}`, extra ? { ...tags, ...extra } : tags)
          if (printToStderr) process.stderr.write(`INFO  ${formatMessage(message)}\n`)
        }
      },
      error(message?: any, extra?: Record<string, any>) {
        if (shouldLog("ERROR")) {
          emitDebug("log", `ERROR ${formatMessage(message)}`, extra ? { ...tags, ...extra } : tags)
          if (printToStderr) process.stderr.write(`ERROR ${formatMessage(message)}\n`)
        }
      },
      warn(message?: any, extra?: Record<string, any>) {
        if (shouldLog("WARN")) {
          emitDebug("log", `WARN ${formatMessage(message)}`, extra ? { ...tags, ...extra } : tags)
          if (printToStderr) process.stderr.write(`WARN  ${formatMessage(message)}\n`)
        }
      },
      tag(key: string, value: string) {
        if (tags) tags[key] = value
        return result
      },
      clone() {
        return Log.create({ ...tags })
      },
      time(message: string, extra?: Record<string, any>) {
        const now = Date.now()
        result.info(message, { status: "started", ...extra })
        function stop() {
          result.info(message, {
            status: "completed",
            duration: Date.now() - now,
            ...extra,
          })
        }
        return {
          stop,
          [Symbol.dispose]() {
            stop()
          },
        }
      },
    }

    if (service && typeof service === "string") {
      loggers.set(service, result)
    }

    return result
  }
}
