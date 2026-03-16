import { createGitLab } from "@gitlab/gitlab-ai-provider"
import { type AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
import { Auth } from "@/auth"
import { BunProc } from "@/bun"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { iife } from "@/util/iife"

function isGpt5OrLater(modelID: string): boolean {
  const match = /^gpt-(\d+)/.exec(modelID)
  if (!match) return false
  return Number(match[1]) >= 5
}

function shouldUseCopilotResponsesApi(modelID: string): boolean {
  return isGpt5OrLater(modelID) && !modelID.startsWith("gpt-5-mini")
}

export type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
type CustomLoader = (provider: any) => Promise<{
  autoload: boolean
  getModel?: CustomModelLoader
  options?: Record<string, any>
}>

export const CUSTOM_LOADERS: Record<string, CustomLoader> = {
  async anthropic() {
    return {
      autoload: false,
      options: {
        headers: {
          "User-Agent": "claude-cli/2.1.29 (external, npm)",
          "x-app": "cli",
          "x-anthropic-additional-protection": "true",
          "anthropic-beta":
            "claude-code-20250219,oauth-2025-04-20,prompt-caching-scope-2026-01-05,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
        },
      },
    }
  },
  async opencode(input) {
    const hasKey = await (async () => {
      const env = Env.all()
      if (input.env.some((item: string) => env[item])) return true
      if (await Auth.get(input.id)) return true
      const config = await Config.get()
      if (config.provider?.["opencode"]?.options?.apiKey) return true
      return false
    })()

    if (!hasKey) {
      for (const [key, value] of Object.entries(input.models)) {
        if ((value as any).cost.input === 0) continue
        delete input.models[key]
      }
    }

    return {
      autoload: Object.keys(input.models).length > 0,
      options: hasKey ? {} : { apiKey: "public" },
    }
  },
  openai: async () => {
    return {
      autoload: false,
      async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
        return sdk.responses(modelID)
      },
      options: {},
    }
  },
  "github-copilot": async () => {
    return {
      autoload: false,
      async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
        if (sdk.responses === undefined && sdk.chat === undefined) return sdk.languageModel(modelID)
        return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
      },
      options: {},
    }
  },
  "github-copilot-enterprise": async () => {
    return {
      autoload: false,
      async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
        if (sdk.responses === undefined && sdk.chat === undefined) return sdk.languageModel(modelID)
        return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
      },
      options: {},
    }
  },
  azure: async () => {
    return {
      autoload: false,
      async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
        if (options?.["useCompletionUrls"]) return sdk.chat(modelID)
        return sdk.responses(modelID)
      },
      options: {},
    }
  },
  "azure-cognitive-services": async () => {
    const resourceName = Env.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
    return {
      autoload: false,
      async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
        if (options?.["useCompletionUrls"]) return sdk.chat(modelID)
        return sdk.responses(modelID)
      },
      options: {
        baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
      },
    }
  },
  "gemini-cli": async () => ({ autoload: true, options: {} }),
  "amazon-bedrock": async () => {
    const config = await Config.get()
    const providerConfig = config.provider?.["amazon-bedrock"]
    const auth = await Auth.get("amazon-bedrock")
    const configRegion = providerConfig?.options?.region
    const envRegion = Env.get("AWS_REGION")
    const defaultRegion = configRegion ?? envRegion ?? "us-east-1"
    const configProfile = providerConfig?.options?.profile
    const envProfile = Env.get("AWS_PROFILE")
    const profile = configProfile ?? envProfile
    const awsAccessKeyId = Env.get("AWS_ACCESS_KEY_ID")

    const awsBearerToken = iife(() => {
      const envToken = Env.get("AWS_BEARER_TOKEN_BEDROCK")
      if (envToken) return envToken
      if (auth?.type === "api") {
        Env.set("AWS_BEARER_TOKEN_BEDROCK", auth.key)
        return auth.key
      }
      return undefined
    })

    const awsWebIdentityTokenFile = Env.get("AWS_WEB_IDENTITY_TOKEN_FILE")
    const containerCreds = Boolean(
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
    )
    if (!profile && !awsAccessKeyId && !awsBearerToken && !awsWebIdentityTokenFile && !containerCreds) {
      return { autoload: false }
    }

    const providerOptions: AmazonBedrockProviderSettings = { region: defaultRegion }
    if (!awsBearerToken) {
      const { fromNodeProviderChain } = await import(await BunProc.install("@aws-sdk/credential-providers"))
      const credentialProviderOptions = profile ? { profile } : {}
      providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
    }
    const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
    if (endpoint) providerOptions.baseURL = endpoint

    return {
      autoload: true,
      options: providerOptions,
      async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
        const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]
        if (crossRegionPrefixes.some((prefix) => modelID.startsWith(prefix))) return sdk.languageModel(modelID)
        const region = options?.region ?? defaultRegion
        let regionPrefix = region.split("-")[0]
        switch (regionPrefix) {
          case "us": {
            const modelRequiresPrefix = [
              "nova-micro",
              "nova-lite",
              "nova-pro",
              "nova-premier",
              "nova-2",
              "claude",
              "deepseek",
            ].some((m) => modelID.includes(m))
            const isGovCloud = region.startsWith("us-gov")
            if (modelRequiresPrefix && !isGovCloud) modelID = `${regionPrefix}.${modelID}`
            break
          }
          case "eu": {
            const regionRequiresPrefix = [
              "eu-west-1",
              "eu-west-2",
              "eu-west-3",
              "eu-north-1",
              "eu-central-1",
              "eu-south-1",
              "eu-south-2",
            ].some((r) => region.includes(r))
            const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
              modelID.includes(m),
            )
            if (regionRequiresPrefix && modelRequiresPrefix) modelID = `${regionPrefix}.${modelID}`
            break
          }
          case "ap": {
            const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
            const isTokyoRegion = region === "ap-northeast-1"
            if (
              isAustraliaRegion &&
              ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
            ) {
              regionPrefix = "au"
              modelID = `${regionPrefix}.${modelID}`
            } else if (isTokyoRegion) {
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                modelID.includes(m),
              )
              if (modelRequiresPrefix) {
                regionPrefix = "jp"
                modelID = `${regionPrefix}.${modelID}`
              }
            } else {
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                modelID.includes(m),
              )
              if (modelRequiresPrefix) {
                regionPrefix = "apac"
                modelID = `${regionPrefix}.${modelID}`
              }
            }
            break
          }
        }
        return sdk.languageModel(modelID)
      },
    }
  },
  openrouter: async () => ({
    autoload: false,
    options: { headers: { "HTTP-Referer": "https://opencode.ai/", "X-Title": "opencode" } },
  }),
  vercel: async () => ({
    autoload: false,
    options: { headers: { "http-referer": "https://opencode.ai/", "x-title": "opencode" } },
  }),
  "google-vertex": async () => {
    const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
    const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "us-east5"
    if (!project) return { autoload: false }
    return {
      autoload: true,
      options: { project, location },
      async getModel(sdk: any, modelID: string) {
        return sdk.languageModel(String(modelID).trim())
      },
    }
  },
  "google-vertex-anthropic": async () => {
    const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
    const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "global"
    if (!project) return { autoload: false }
    return {
      autoload: true,
      options: { project, location },
      async getModel(sdk: any, modelID: string) {
        return sdk.languageModel(String(modelID).trim())
      },
    }
  },
  "sap-ai-core": async () => {
    const auth = await Auth.get("sap-ai-core")
    const envServiceKey = iife(() => {
      const envAICoreServiceKey = Env.get("AICORE_SERVICE_KEY")
      if (envAICoreServiceKey) return envAICoreServiceKey
      if (auth?.type === "api") {
        Env.set("AICORE_SERVICE_KEY", auth.key)
        return auth.key
      }
      return undefined
    })
    const deploymentId = Env.get("AICORE_DEPLOYMENT_ID")
    const resourceGroup = Env.get("AICORE_RESOURCE_GROUP")
    return {
      autoload: !!envServiceKey,
      options: envServiceKey ? { deploymentId, resourceGroup } : {},
      async getModel(sdk: any, modelID: string) {
        return sdk(modelID)
      },
    }
  },
  zenmux: async () => ({
    autoload: false,
    options: { headers: { "HTTP-Referer": "https://opencode.ai/", "X-Title": "opencode" } },
  }),
  gitlab: async (input) => {
    const instanceUrl = Env.get("GITLAB_INSTANCE_URL") || "https://gitlab.com"
    const auth = await Auth.get(input.id)
    const apiKey = await (async () => {
      if (auth?.type === "oauth") return auth.access
      if (auth?.type === "api") return auth.key
      return Env.get("GITLAB_TOKEN")
    })()
    const config = await Config.get()
    const providerConfig = config.provider?.["gitlab"]
    return {
      autoload: !!apiKey,
      options: {
        instanceUrl,
        apiKey,
        featureFlags: {
          duo_agent_platform_agentic_chat: true,
          duo_agent_platform: true,
          ...(providerConfig?.options?.featureFlags || {}),
        },
      },
      async getModel(sdk: ReturnType<typeof createGitLab>, modelID: string) {
        return sdk.agenticChat(modelID, {
          featureFlags: {
            duo_agent_platform_agentic_chat: true,
            duo_agent_platform: true,
            ...(providerConfig?.options?.featureFlags || {}),
          },
        })
      },
    }
  },
  "cloudflare-ai-gateway": async (input) => {
    const accountId = Env.get("CLOUDFLARE_ACCOUNT_ID")
    const gateway = Env.get("CLOUDFLARE_GATEWAY_ID")
    if (!accountId || !gateway) return { autoload: false }
    const apiToken = await (async () => {
      const envToken = Env.get("CLOUDFLARE_API_TOKEN")
      if (envToken) return envToken
      const auth = await Auth.get(input.id)
      if (auth?.type === "api") return auth.key
      return undefined
    })()
    return {
      autoload: true,
      async getModel(sdk: any, modelID: string) {
        return sdk.languageModel(modelID)
      },
      options: {
        baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/compat`,
        headers: {
          ...(apiToken ? { "cf-aig-authorization": `Bearer ${apiToken}` } : {}),
          "HTTP-Referer": "https://opencode.ai/",
          "X-Title": "opencode",
        },
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          headers.delete("Authorization")
          if (init?.body && init.method === "POST") {
            try {
              const body = JSON.parse(init.body as string)
              if (body.max_tokens !== undefined && !body.max_completion_tokens) {
                body.max_completion_tokens = body.max_tokens
                delete body.max_tokens
                init = { ...init, body: JSON.stringify(body) }
              }
            } catch {
              // noop
            }
          }
          return fetch(input, { ...init, headers })
        },
      },
    }
  },
  cerebras: async () => ({
    autoload: false,
    options: { headers: { "X-Cerebras-3rd-Party-Integration": "opencode" } },
  }),
  gmicloud: async (input) => {
    const apiKey = await (async () => {
      const envKey = Env.get("GMI_API_KEY")
      if (envKey) return envKey
      const auth = await Auth.get(input.id)
      if (auth?.type === "api") return auth.key
      return undefined
    })()
    return {
      autoload: !!apiKey,
      options: {
        baseURL: "https://api.gmi-serving.com/v1",
        apiKey: apiKey ?? "",
      },
    }
  },
}
