import { streamText } from "ai"
import { Provider } from "@/provider/provider"

export type ModelProbeResult = { ok: true; responseTime: number } | { ok: false; error: string }

export function probeModelAvailability(
  providerId: string,
  modelID: string,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ModelProbeResult> {
  const started = Date.now()

  return Provider.list()
    .then((providers) => {
      const provider = providers[providerId]
      if (!provider) return { ok: false as const, error: `Provider not found: ${providerId}` }

      const modelConfig = provider.models[modelID]
      if (!modelConfig) return { ok: false as const, error: `Model not found: ${providerId}/${modelID}` }

      return Provider.getLanguage(modelConfig).then((language) => {
        const controller = new AbortController()
        if (signal) {
          if (signal.aborted) controller.abort()
          else signal.addEventListener("abort", () => controller.abort(), { once: true })
        }

        const timeout = new Promise<never>((_, reject) => {
          const id = setTimeout(() => {
            controller.abort()
            reject(new Error(`Operation timed out after ${timeoutMs}ms`))
          }, timeoutMs)
          if (signal) {
            const clear = () => clearTimeout(id)
            if (signal.aborted) clear()
            else signal.addEventListener("abort", clear, { once: true })
          }
        })

        const run = async () => {
          const result = streamText({
            model: language,
            prompt,
            abortSignal: controller.signal,
            maxRetries: 0,
          })
          for await (const _ of result.textStream) return
        }

        return Promise.race([
          run().then(() => ({ ok: true as const, responseTime: Date.now() - started })),
          timeout,
        ]).catch((error) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        }))
      })
    })
    .catch((error) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    }))
}
