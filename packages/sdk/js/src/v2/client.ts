export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient } from "./gen/sdk.gen.js"
export { type Config as OpencodeClientConfig, OpencodeClient }

export function resolveProviderNpm(
  provider:
    | {
        npm?: string
      }
    | null
    | undefined,
  fallback = "@ai-sdk/openai-compatible",
) {
  return provider?.npm ?? fallback
}

export function resolveModelProviderNpm(
  model:
    | {
        provider?: {
          npm?: string
        }
      }
    | null
    | undefined,
  fallback = "@ai-sdk/openai-compatible",
) {
  return model?.provider?.npm ?? fallback
}

export function loginGlobalWebAuth(
  client: OpencodeClient,
  credentials: {
    username: string
    password: string
  },
) {
  return client.global.auth.login(credentials)
}

export function createOpencodeClient(config?: Config & { directory?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    const isNonASCII = /[^\x00-\x7F]/.test(config.directory)
    const encodedDirectory = isNonASCII ? encodeURIComponent(config.directory) : config.directory
    config.headers = {
      ...config.headers,
      "x-opencode-directory": encodedDirectory,
    }
  }

  const client = createClient(config)
  return new OpencodeClient({ client })
}
