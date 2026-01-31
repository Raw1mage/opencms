import z from "zod"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "../util/log"
import { BunProc } from "../bun"
import { Plugin } from "../plugin"
import { ModelsDev } from "./models"
import { NamedError } from "@opencode-ai/util/error"
import { Auth } from "../auth"
import { Account } from "../account"
import { Env } from "../env"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { Global } from "../global"

// Direct imports for bundled providers
import { createAmazonBedrock, type AmazonBedrockProviderSettings } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter, type LanguageModelV2 } from "@openrouter/ai-sdk-provider"
import { createOpenaiCompatible as createGitHubCopilotOpenAICompatible } from "./sdk/openai-compatible/src"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createGateway } from "@ai-sdk/gateway"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createVercel } from "@ai-sdk/vercel"
import { createGitLab } from "@gitlab/gitlab-ai-provider"
import { ProviderTransform } from "./transform"


export namespace Provider {
  const log = Log.create({ service: "provider" })

  const IGNORED_MODELS = new Set([
    "google/gemini-1.5-pro",
    "google/gemini-1.0-pro",
  ])

  const ANTIGRAVITY_WHITELIST = new Set([
    "gemini-3-pro-high",
    "gemini-3-pro-low",
    "gemini-3-pro",
    "gemini-3-flash",
    "claude-3-7-sonnet",
    "claude-3-7-sonnet-thinking",
    "claude-4-5-sonnet",
    "claude-4-5-sonnet-thinking",
    "claude-4-5-opus",
    "claude-4-5-opus-thinking",
    "gpt-oss-120b-medium"
  ]);
  const IGNORED_DYNAMIC = new Set<string>()

  async function loadIgnoredDynamic() {
    IGNORED_DYNAMIC.clear()
    const file = Bun.file(`${Global.Path.data}/ignored-models.json`)
    const exists = await file.exists()
    if (!exists) return
    const data = await file.json().catch(() => [])
    if (!Array.isArray(data)) return
    for (const entry of data) {
      if (typeof entry === "string" && entry.length > 0) IGNORED_DYNAMIC.add(entry)
    }
  }

  export function isModelIgnored(providerID: string, modelID: string): boolean {
    if (IGNORED_DYNAMIC.has(providerID) || IGNORED_DYNAMIC.has(`${providerID}/*`)) return true
    if (IGNORED_DYNAMIC.has(`${providerID}/${modelID}`)) return true
    if (IGNORED_MODELS.has(providerID) || IGNORED_MODELS.has(`${providerID}/*`)) return true
    if (IGNORED_MODELS.has(`${providerID}/${modelID}`)) return true

    // Check for any ignored model ID that appears as the base model in any provider
    for (const ignored of IGNORED_MODELS) {
      if (ignored.includes("/")) {
        const [ignoredProvider, ignoredModel] = ignored.split("/")
        if (modelID === ignoredModel && (providerID === ignoredProvider || providerID.includes(ignoredProvider))) {
          return true
        }
      }
    }
    return false
  }




  function isGpt5OrLater(modelID: string): boolean {
    const match = /^gpt-(\d+)/.exec(modelID)
    if (!match) {
      return false
    }
    return Number(match[1]) >= 5
  }

  function shouldUseCopilotResponsesApi(modelID: string): boolean {
    return isGpt5OrLater(modelID) && !modelID.startsWith("gpt-5-mini")
  }

  const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
    "@ai-sdk/amazon-bedrock": createAmazonBedrock,
    "@ai-sdk/anthropic": createAnthropic,
    "@ai-sdk/azure": createAzure,
    "@ai-sdk/google": createGoogleGenerativeAI,
    "@ai-sdk/google-vertex": createVertex,
    "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
    "@ai-sdk/openai": createOpenAI,
    "@ai-sdk/openai-compatible": createOpenAICompatible,
    "@openrouter/ai-sdk-provider": createOpenRouter,
    "@ai-sdk/xai": createXai,
    "@ai-sdk/mistral": createMistral,
    "@ai-sdk/groq": createGroq,
    "@ai-sdk/deepinfra": createDeepInfra,
    "@ai-sdk/cerebras": createCerebras,
    "@ai-sdk/cohere": createCohere,
    "@ai-sdk/gateway": createGateway,
    "@ai-sdk/togetherai": createTogetherAI,
    "@ai-sdk/perplexity": createPerplexity,
    "@ai-sdk/vercel": createVercel,
    "@gitlab/gitlab-ai-provider": createGitLab,
    // @ts-ignore (TODO: kill this code so we dont have to maintain it)
    "@ai-sdk/github-copilot": createGitHubCopilotOpenAICompatible,
  }

  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
  type CustomLoader = (provider: Info) => Promise<{
    autoload: boolean
    getModel?: CustomModelLoader
    options?: Record<string, any>
  }>

  const CUSTOM_LOADERS: Record<string, CustomLoader> = {
    async anthropic() {
      return {
        autoload: false,
        options: {
          headers: {
            "User-Agent": "anthropic-claude-code/0.5.1",
            "anthropic-client": "claude-code/0.5.1",
            "anthropic-beta":
              "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }
    },
    async opencode(input) {
      const hasKey = await (async () => {
        const env = Env.all()
        if (input.env.some((item) => env[item])) return true
        if (await Auth.get(input.id)) return true
        const config = await Config.get()
        if (config.provider?.["opencode"]?.options?.apiKey) return true
        return false
      })()

      if (!hasKey) {
        for (const [key, value] of Object.entries(input.models)) {
          if (value.cost.input === 0) continue
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
          return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
        },
        options: {},
      }
    },
    "github-copilot-enterprise": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return shouldUseCopilotResponsesApi(modelID) ? sdk.responses(modelID) : sdk.chat(modelID)
        },
        options: {},
      }
    },
    azure: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {},
      }
    },
    "azure-cognitive-services": async () => {
      const resourceName = Env.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {
          baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
        },
      }
    },
    "gemini-cli": async () => {
      return {
        autoload: true,
        options: {},
      }
    },
    "amazon-bedrock": async () => {
      const config = await Config.get()
      const providerConfig = config.provider?.["amazon-bedrock"]

      const auth = await Auth.get("amazon-bedrock")

      // Region precedence: 1) config file, 2) env var, 3) default
      const configRegion = providerConfig?.options?.region
      const envRegion = Env.get("AWS_REGION")
      const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

      // Profile: config file takes precedence over env var
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

      if (!profile && !awsAccessKeyId && !awsBearerToken && !awsWebIdentityTokenFile) return { autoload: false }

      const providerOptions: AmazonBedrockProviderSettings = {
        region: defaultRegion,
      }

      // Only use credential chain if no bearer token exists
      // Bearer token takes precedence over credential chain (profiles, access keys, IAM roles, web identity tokens)
      if (!awsBearerToken) {
        const { fromNodeProviderChain } = await import(await BunProc.install("@aws-sdk/credential-providers"))

        // Build credential provider options (only pass profile if specified)
        const credentialProviderOptions = profile ? { profile } : {}

        providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
      }

      // Add custom endpoint if specified (endpoint takes precedence over baseURL)
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) {
        providerOptions.baseURL = endpoint
      }

      return {
        autoload: true,
        options: providerOptions,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          // Skip region prefixing if model already has a cross-region inference profile prefix
          if (modelID.startsWith("global.") || modelID.startsWith("jp.")) {
            return sdk.languageModel(modelID)
          }

          // Region resolution precedence (highest to lowest):
          // 1. options.region from opencode.json provider config
          // 2. defaultRegion from AWS_REGION environment variable
          // 3. Default "us-east-1" (baked into defaultRegion)
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
              if (modelRequiresPrefix && !isGovCloud) {
                modelID = `${regionPrefix}.${modelID}`
              }
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
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
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
                // Tokyo region uses jp. prefix for cross-region inference
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "jp"
                  modelID = `${regionPrefix}.${modelID}`
                }
              } else {
                // Other APAC regions use apac. prefix
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
    openrouter: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
          },
        },
      }
    },
    vercel: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "http-referer": "https://opencode.ai/",
            "x-title": "opencode",
          },
        },
      }
    },
    "google-vertex": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "us-east5"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "google-vertex-anthropic": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
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
    zenmux: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
          },
        },
      }
    },
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

      // Get API token from env or auth prompt
      const apiToken = await (async () => {
        const envToken = Env.get("CLOUDFLARE_API_TOKEN")
        if (envToken) return envToken
        const auth = await Auth.get(input.id)
        if (auth?.type === "api") return auth.key
        return undefined
      })()

      return {
        autoload: true,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.languageModel(modelID)
        },
        options: {
          baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/compat`,
          headers: {
            // Cloudflare AI Gateway uses cf-aig-authorization for authenticated gateways
            // This enables Unified Billing where Cloudflare handles upstream provider auth
            ...(apiToken ? { "cf-aig-authorization": `Bearer ${apiToken}` } : {}),
            "HTTP-Referer": "https://opencode.ai/",
            "X-Title": "opencode",
          },
          // Custom fetch to handle parameter transformation and auth
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers)
            // Strip Authorization header - AI Gateway uses cf-aig-authorization instead
            headers.delete("Authorization")

            // Transform max_tokens to max_completion_tokens for newer models
            if (init?.body && init.method === "POST") {
              try {
                const body = JSON.parse(init.body as string)
                if (body.max_tokens !== undefined && !body.max_completion_tokens) {
                  body.max_completion_tokens = body.max_tokens
                  delete body.max_tokens
                  init = { ...init, body: JSON.stringify(body) }
                }
              } catch (e) {
                // If body parsing fails, continue with original request
              }
            }

            return fetch(input, { ...init, headers })
          },
        },
      }
    },
    cerebras: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "opencode",
          },
        },
      }
    },
  }

  export const Model = z
    .object({
      id: z.string(),
      providerID: z.string(),
      api: z.object({
        id: z.string(),
        url: z.string(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      active: z.boolean().optional(),
      email: z.string().optional(),
      coolingDownUntil: z.number().optional(),
      cooldownReason: z.string().optional(),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    const m: Model = {
      id: model.id,
      providerID: provider.id,
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: provider.api!,
        npm: iife(() => {
          if (provider.id.startsWith("github-copilot")) return "@ai-sdk/github-copilot"
          if (provider.id.startsWith("anthropic")) return "@ai-sdk/anthropic"
          return model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible"
        }),
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0,
        },
        experimentalOver200K: model.cost?.context_over_200k
          ? {
            cache: {
              read: model.cost.context_over_200k.cache_read ?? 0,
              write: model.cost.context_over_200k.cache_write ?? 0,
            },
            input: model.cost.context_over_200k.input,
            output: model.cost.context_over_200k.output,
          }
          : undefined,
      },
      limit: {
        context: model.limit.context,
        input: model.limit.input,
        output: model.limit.output,
      },
      capabilities: {
        temperature: model.temperature,
        reasoning: model.reasoning,
        attachment: model.attachment,
        toolcall: model.tool_call,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
      release_date: model.release_date,
      variants: {},
    }

    m.variants = mapValues(ProviderTransform.variants(m), (v) => v)

    return m
  }

  export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
    return {
      id: provider.id,
      source: "custom",
      name: provider.name,
      env: provider.env ?? [],
      options: {},
      models: mapValues(provider.models, (model) => fromModelsDevModel(provider, model)),
    }
  }

  const state = Instance.state(async () => {
    using _ = log.time("state")
    const config = await Config.get()
    const modelsDev = await ModelsDev.get()
    const database = mapValues(modelsDev, fromModelsDevProvider)

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null
    await loadIgnoredDynamic()

    function isProviderAllowed(providerID: string): boolean {
      const accountFamily = Account.parseFamily(providerID)
      const family = accountFamily || providerID

      if (enabled && enabled.size === 0) return false

      const isAntigravity = family === "antigravity"
      const isGeminiCli = family === "gemini-cli"
      if (isAntigravity || isGeminiCli) {
        if (!enabled) return !disabled.has(providerID)
        if (enabled.has(family) || enabled.has("google")) return !disabled.has(providerID)
        return false
      }

      if (enabled && !enabled.has(family)) return false
      if (disabled.has(providerID)) return false
      return true
    }

    const providers: { [providerID: string]: Info } = {}
    const languages = new Map<string, LanguageModelV2>()
    const modelLoaders: {
      [providerID: string]: CustomModelLoader
    } = {}
    const sdk = new Map<number, SDK>()

    log.info("init")

    const configProviders = Object.entries(config.provider ?? {})


    function mergeProvider(providerID: string, provider: Partial<Info>) {
      const existing = providers[providerID]
      if (existing) {
        // @ts-expect-error
        providers[providerID] = mergeDeep(existing, provider)
        return
      }
      const match = database[providerID]
      if (!match) return
      // @ts-expect-error
      providers[providerID] = mergeDeep(match, provider)
    }

    // extend database from config
    for (const [providerID, provider] of configProviders) {
      const existing = database[providerID]
      const parsed: Info = {
        id: providerID,
        name: providerID === "google" ? "Google (API Key)" : (provider.name ?? existing?.name ?? providerID),
        env: provider.env ?? existing?.env ?? [],
        options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
        source: "config",
        models: existing?.models ?? {},
      }

      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        const existingModel = parsed.models[model.id ?? modelID]
        const name = iife(() => {
          if (model.name) return model.name
          if (model.id && model.id !== modelID) return modelID
          return existingModel?.name ?? modelID
        })
        const parsedModel: Model = {
          id: modelID,
          api: {
            id: model.id ?? existingModel?.api.id ?? modelID,
            npm:
              model.provider?.npm ??
              provider.npm ??
              existingModel?.api.npm ??
              modelsDev[providerID]?.npm ??
              "@ai-sdk/openai-compatible",
            url: provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
          },
          status: model.status ?? existingModel?.status ?? "active",
          name,
          providerID,
          capabilities: {
            temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
            reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
            attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
            toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
            input: {
              text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
              audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
              image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
              video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
              pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
            },
            output: {
              text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
              audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
              image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
              video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
              pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
            },
            interleaved: model.interleaved ?? false,
          },
          cost: {
            input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
            output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
            cache: {
              read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
              write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
            },
          },
          options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
          limit: {
            context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
            output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
          },
          headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
          family: model.family ?? existingModel?.family ?? "",
          release_date: model.release_date ?? existingModel?.release_date ?? "",
          variants: {},
        }
        const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
        parsedModel.variants = mapValues(
          pickBy(merged, (v) => !v.disabled),
          (v) => omit(v, ["disabled"]),
        )
        parsed.models[modelID] = parsedModel
      }
      database[providerID] = parsed
    }

    // Add virtual providers that inherit from base families (after config merge)
    const inheritFrom = (targetID: string, baseID: string, patch: Partial<Info> = {}) => {
      const base = database[baseID]
      if (base) {
        database[targetID] = {
          ...base,
          ...patch,
          id: targetID,
          models: mapValues(base.models, (model) => {
            const m = { ...model, providerID: targetID }
            if (patch.id === "gemini-cli" && m.api) {
              m.api = { ...m.api, npm: "@ai-sdk/google" }
            }
            return m
          }),
        }
      }
    }

    inheritFrom("github-copilot-enterprise", "github-copilot", { name: "GitHub Copilot Enterprise" })
    // inheritFrom("antigravity", "google", { name: "Antigravity", env: [] }) // Don't inherit all Google models

    // Initialize Antigravity as a clean provider
    database["antigravity"] = {
      id: "antigravity",
      name: "Antigravity",
      source: "custom",
      env: [],
      options: {},
      models: {}
    }
    inheritFrom("gemini-cli", "google", { id: "gemini-cli", name: "Gemini CLI", env: ["GEMINI_API_KEY"] })

    // If gemini-cli failed to inherit (e.g. google missing) OR it exists but has no models, populate manually
    if (!database["gemini-cli"] || Object.keys(database["gemini-cli"].models).length === 0) {
      if (!database["gemini-cli"]) {
        database["gemini-cli"] = {
          id: "gemini-cli",
          name: "Gemini CLI",
          source: "custom",
          env: ["GEMINI_API_KEY"],
          options: {},
          models: {},
        }
      }

      const geminiModels = [
        { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
        { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro" },
        { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash" },
        { id: "gemini-1.5-pro-latest", name: "Gemini 1.5 Pro (Latest)" },
        { id: "gemini-1.5-flash-latest", name: "Gemini 1.5 Flash (Latest)" },
        { id: "gemini-pro", name: "Gemini Pro" },
        { id: "gemini-ultra", name: "Gemini Ultra" }
      ]

      for (const m of geminiModels) {
        database["gemini-cli"].models[m.id] = {
          id: m.id,
          name: m.name,
          providerID: "gemini-cli",
          family: "gemini",
          api: { id: m.id, url: "https://generativelanguage.googleapis.com", npm: "@ai-sdk/google" },
          status: "active",
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: true,
            interleaved: false,
            input: { text: true, image: true, audio: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            toolcall: true
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 32000, output: 4096 },
          options: {},
          variants: {},
          headers: {},
          release_date: "2024-01-01"
        }
      }
    }

    // If anthropic failed to inherit or it exists but has no models, populate manually
    if (!database["anthropic"] || Object.keys(database["anthropic"].models).length === 0) {
      if (!database["anthropic"]) {
        database["anthropic"] = {
          id: "anthropic",
          name: "Anthropic",
          source: "custom",
          env: ["ANTHROPIC_API_KEY"],
          options: {},
          models: {},
        }
      }

      const anthropicModels = [
        { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet (New)" },
        { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },
        { id: "claude-3-opus-20240229", name: "Claude 3 Opus" },
        { id: "claude-3-sonnet-20240229", name: "Claude 3 Sonnet" },
        { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku" },
        { id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet (Latest)" }
      ]

      for (const m of anthropicModels) {
        database["anthropic"].models[m.id] = {
          id: m.id,
          name: m.name,
          providerID: "anthropic",
          family: "claude",
          api: { id: m.id, url: "", npm: "@ai-sdk/anthropic" },
          status: "active",
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: true,
            interleaved: false,
            input: { text: true, image: true, audio: false, video: false, pdf: true },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            toolcall: true
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 200000, output: 4096 },
          options: {},
          variants: {},
          headers: {},
          release_date: "2024-01-01"
        }
      }
    }

    // Populate Antigravity with extra models
    if (database["antigravity"]) {
      // Populate Antigravity with only specific models
      const extraModels = [
        "claude-sonnet-4-5",
        "claude-opus-4-5",
        "claude-sonnet-4-5-thinking",
        "claude-opus-4-5-thinking",
        "claude-opus-4-1",
        "claude-opus-4-2",
      ]

      const findModelInDev = (id: string) => {
        for (const p of Object.values(modelsDev)) {
          if (p.models[id]) return { provider: p, model: p.models[id] }
        }
        return undefined
      }

      for (const id of extraModels) {
        const found = findModelInDev(id)
        if (found) {
          const model = fromModelsDevModel(found.provider, found.model)
          model.providerID = "antigravity"
          model.api = { ...model.api, npm: "@ai-sdk/google", url: "https://generativelanguage.googleapis.com" }
          database["antigravity"].models[id] = model
        }
      }

      const manualModels = [
        { id: "claude-opus-4-5-thinking", name: "Claude 4.5 Opus (Thinking)", family: "claude", reasoning: true },
        { id: "claude-opus-4-5", name: "Claude 4.5 Opus", family: "claude" },
        { id: "claude-sonnet-4-5-thinking", name: "Claude 4.5 Sonnet (Thinking)", family: "claude", reasoning: true },
        { id: "claude-sonnet-4-5", name: "Claude 4.5 Sonnet", family: "claude" },
        { id: "gemini-3-pro-high", name: "Gemini 3 Pro (High)", family: "gemini-pro" },
        { id: "gemini-3-pro-low", name: "Gemini 3 Pro (Low)", family: "gemini-pro" },
        { id: "gemini-3-flash", name: "Gemini 3 Flash (New)", family: "gemini-flash" },
        { id: "claude-opus-4-1", name: "Claude Opus 4.1", family: "claude" },
        { id: "claude-opus-4-2", name: "Claude Opus 4.2", family: "claude" },
        { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", family: "gpt-oss" },
        { id: "gpt-5.1-codex", name: "GPT-5.1 Codex", family: "openai" },
        { id: "claude-3-7-sonnet-thinking", name: "Claude 3.7 Sonnet (Thinking)", family: "claude", reasoning: true },
        { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", family: "claude" },
      ]

      for (const m of manualModels) {
        database["antigravity"].models[m.id] = {
          id: m.id,
          name: m.name,
          providerID: "antigravity",
          family: m.family as any,
          api: { id: m.id, url: "https://generativelanguage.googleapis.com", npm: "@ai-sdk/google" },
          status: "active",
          capabilities: {
            temperature: true,
            reasoning: m.reasoning || false,
            attachment: true,
            toolcall: true,
            input: { text: true, image: true, audio: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 200000, output: 8192 },
          options: {},
          variants: {},
          headers: {},
          release_date: "2025-01-01"
        }
      }
    }

    // Ensure Antigravity provider is always available if populated (even if no account active)
    // This prevents fallback to Codex when account sync is flaky or during transitions
    if (database["antigravity"]) {
      mergeProvider("antigravity", { source: "custom" })
    }

    // Inherit models for account-suffixed providers
    for (const [providerID, provider] of Object.entries(database)) {
      // Match pattern: "provider-accountname"
      const match = providerID.match(/^([a-z-]+)-[a-z0-9-]+$/)
      if (match) {
        const baseProviderID = match[1] // e.g., "google" from "google-work"
        const baseProvider = database[baseProviderID]

        // If base exists and account provider has no models, inherit everything
        if (baseProvider && Object.keys(provider.models).length === 0) {
          log.info("inheriting models", { from: baseProviderID, to: providerID })
          database[providerID] = {
            ...provider,
            name: provider.name || `${baseProvider.name} (${providerID.split("-").pop()})`,
            models: mapValues(baseProvider.models, (model) => ({
              ...model,
              providerID: providerID, // Update to account-specific provider
            })),
            env: baseProvider.env,
          }
        }
      }
    }

    // load env
    const env = Env.all()
    for (const [providerID, provider] of Object.entries(database)) {
      if (disabled.has(providerID)) continue
      const apiKey = provider.env.map((item) => env[item]).find(Boolean)
      if (!apiKey) continue
      mergeProvider(providerID, {
        source: "env",
        key: provider.env.length === 1 ? apiKey : undefined,
      })
    }

    // load apikeys and other auth
    for (const [providerID, provider] of Object.entries(await Auth.all())) {
      if (disabled.has(providerID)) continue
      if (provider.type === "api") {
        mergeProvider(providerID, {
          source: "api",
          key: provider.key,
        })
        // @ts-ignore
      } else if (provider.type === "oauth" || provider.type === "subscription") {
        mergeProvider(providerID, {
          source: "custom",
        })
      }
    }

    // Load accounts from unified Account module
    const allFamilies = await Account.listAll()
    for (const [family, familyData] of Object.entries(allFamilies)) {
      const baseProvider = database[family]
      if (!baseProvider) continue

      for (const [accountId, accountInfo] of Object.entries(familyData.accounts)) {
        if (disabled.has(accountId)) continue
        if (!isProviderAllowed(accountId)) continue

        // For Antigravity, only register the ACTIVE account and map it to the generic 'antigravity' ID
        // This ensures /models shows a single 'Antigravity' entry that respects /accounts selection
        let effectiveId = accountId;
        if (family === "antigravity") {
          if (accountId !== familyData.activeAccount) {
            continue;
          }
          effectiveId = "antigravity";
        } else if (family === "antigravity" && accountId.startsWith("antigravity-subscription-") && accountInfo.type === "subscription" && accountInfo.email) {
          // Fallback logic for safety (though the above if block covers it)
          const username = accountInfo.email.split("@")[0];
          effectiveId = `antigravity-${username}`;
        }

        // Determine display name
        let displayName = Account.getDisplayName(accountId, accountInfo, family)
        if (family === "antigravity" && effectiveId === "antigravity" && accountInfo.type === "subscription" && accountInfo.email) {
          displayName = `Antigravity (${accountInfo.email})`;
        }

        // Add to database with models inherited from base provider
        const options: Record<string, any> = {}
        if (accountInfo.type === "subscription") {
          if (accountInfo.projectId) {
            options.projectId = accountInfo.projectId
          }
          if (accountInfo.managedProjectId) {
            options.managedProjectId = accountInfo.managedProjectId
          }
          if (accountInfo.accessToken && family !== "anthropic") {
            options.apiKey = accountInfo.accessToken
          }
          if (family === "anthropic") {
            options.headers = {
              "User-Agent": "anthropic-claude-code/0.5.1",
              "anthropic-client": "claude-code/0.5.1",
              "anthropic-beta":
                "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
            }
            if (accountInfo.accessToken) {
              options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
                const headers = new Headers(init?.headers)
                headers.set("Authorization", `Bearer ${accountInfo.accessToken}`)
                headers.delete("x-api-key")
                if (Env.get("OPENCODE_SMOKE_DEBUG")) {
                  log.info("anthropic subscription request", {
                    url: typeof input === "string" ? input : input.toString(),
                    headers: Array.from(headers.keys()),
                  })
                }
                return fetch(input, { ...init, headers })
              }
            }
          }
        }
        if (accountInfo.type === "api" && accountInfo.apiKey) {
          options.apiKey = accountInfo.apiKey
        }

        const blocked =
          family === "anthropic" && accountInfo.type === "subscription"
            ? "Claude Code subscription credentials are blocked for third-party tools. Use an Anthropic API key."
            : undefined

        // Whitelist of truly supported Antigravity models
        const ANTIGRAVITY_WHITELIST = new Set([
          "gemini-3-pro-high",
          "gemini-3-pro-low",
          "gemini-3-pro",
          "gemini-3-flash",
          "claude-3-7-sonnet",
          "claude-3-7-sonnet-thinking",
          "claude-4-5-sonnet",
          "claude-4-5-sonnet-thinking",
          "claude-4-5-opus",
          "claude-4-5-opus-thinking",
          "gpt-oss-120b-medium"
        ]);

        database[effectiveId] = {
          id: effectiveId,
          source: "custom",
          name: displayName,
          active: familyData.activeAccount === accountId,
          email: accountInfo.type === "subscription" ? accountInfo.email : undefined,
          coolingDownUntil: accountInfo.type === "subscription" ? accountInfo.coolingDownUntil : undefined,
          cooldownReason: blocked ?? (accountInfo.type === "subscription" ? accountInfo.cooldownReason : undefined),
          env: family === "antigravity" ? ["ANTIGRAVITY_Enabled"] : [],
          options,
          models: pickBy(
            mapValues(baseProvider.models, (model) => ({
              ...model,
              providerID: effectiveId,
            })),
            (model, id) => family !== "antigravity" || ANTIGRAVITY_WHITELIST.has(id)
          ),
        }

        mergeProvider(effectiveId, {
          source: "custom",
        })
      }
    }

    // Legacy: Load antigravity accounts for backward compatibility with plugins
    const antigravityAccounts = await Auth.listAntigravityAccounts()
    for (const [accountID, accountInfo] of Object.entries(antigravityAccounts)) {
      // Skip if already loaded from Account module
      if (database[accountID]) continue
      if (disabled.has(accountID)) continue

      const baseProvider = database["antigravity"] ?? database["google"]
      if (!baseProvider) continue

      database[accountID] = {
        id: accountID,
        source: "custom",
        name: accountInfo.email
          ? `Antigravity (${accountInfo.email})`
          : accountID === "antigravity" || accountID.includes("antigravity")
            ? "Antigravity"
            : `Antigravity (${accountID})`,
        env: [],
        options: {},
        models: pickBy(
          mapValues(baseProvider.models, (model) => ({
            ...model,
            providerID: accountID,
          })),
          (model, id) => !accountID.includes("antigravity") || ANTIGRAVITY_WHITELIST.has(id)
        ),
      }
      mergeProvider(accountID, {
        source: "custom",
      })
    }

    for (const plugin of await Plugin.list()) {
      if (!plugin.auth) continue
      const family = plugin.auth.provider
      if (disabled.has(family)) continue

      // For github-copilot plugin, check if auth exists for either github-copilot or github-copilot-enterprise
      let hasFamilyAuth = false
      const familyAuth = await Auth.get(family)
      if (familyAuth) hasFamilyAuth = true

      // Special handling for github-copilot: also check for enterprise auth
      if (family === "github-copilot" && !hasFamilyAuth) {
        const enterpriseAuth = await Auth.get("github-copilot-enterprise")
        if (enterpriseAuth) hasFamilyAuth = true
      }

      if (!hasFamilyAuth) continue
      if (!plugin.auth.loader) continue

      // 1. Load for the main provider family if it exists in providers
      if (familyAuth) {
        if (providers[family]) {
          log.info("loading plugin for family", { family })
          const options = await plugin.auth.loader(() => Auth.get(family) as any, providers[family])
          if (options) {
            providers[family].options = mergeDeep(providers[family].options, options) as any
          }
        } else {
          log.warn("family provider not found in providers list, skipping plugin load", { family })
        }
      } else {
        log.debug("no family auth found", { family })
      }

      // 2. Load for EVERY account belonging to this family (Parallelized)
      const familyData = allFamilies[family]
      if (familyData) {
        const accountLoaderPromises = Object.keys(familyData.accounts).map(async (accountId) => {
          if (!providers[accountId] || !plugin.auth?.loader) return

          const accountOptions = await plugin.auth.loader(() => Auth.get(accountId) as any, providers[accountId])
          if (accountOptions) {
            providers[accountId].options = mergeDeep(providers[accountId].options, accountOptions) as any
          }
        })
        await Promise.all(accountLoaderPromises)
      }

      // Special handling for legacy antigravity accounts (Parallelized)
      if (family === "antigravity" || family === "google") {
        const legacyLoaderPromises = Object.keys(antigravityAccounts).map(async (accountID) => {
          if (providers[accountID] && plugin.auth?.loader) {
            const accountOptions = await plugin.auth.loader(() => Auth.get(accountID) as any, providers[accountID])
            if (accountOptions) {
              providers[accountID].options = mergeDeep(providers[accountID].options, accountOptions) as any
            }
          }
        })
        await Promise.all(legacyLoaderPromises)
      }

      // Special handling for github-copilot-enterprise (legacy)
      if (family === "github-copilot") {
        const enterpriseProviderID = "github-copilot-enterprise"
        if (!disabled.has(enterpriseProviderID) && providers[enterpriseProviderID]) {
          const enterpriseAuth = await Auth.get(enterpriseProviderID)
          if (enterpriseAuth) {
            const enterpriseOptions = await plugin.auth.loader(
              () => Auth.get(enterpriseProviderID) as any,
              providers[enterpriseProviderID],
            )
            if (enterpriseOptions) {
              providers[enterpriseProviderID].options = mergeDeep(
                providers[enterpriseProviderID].options,
                enterpriseOptions,
              ) as any
            }
          }
        }
      }
    }

    // Propagate base provider options to account-based providers (only for families without specific plugins or as fallback)
    for (const family of Account.FAMILIES) {
      const baseProvider = providers[family]
      if (!baseProvider?.options) continue

      const fData = allFamilies[family]
      if (!fData) continue

      for (const [accountId, accountInfo] of Object.entries(fData.accounts)) {
        let effectiveId = accountId;
        if (family === "antigravity" && accountId.startsWith("antigravity-subscription-") && accountInfo.type === "subscription" && accountInfo.email) {
          const username = accountInfo.email.split("@")[0];
          effectiveId = `antigravity-${username}`;
        }

        if (providers[effectiveId]) {
          // Merge options, prioritizing account-specific options (from plugin loaders)
          providers[effectiveId].options = mergeDeep(baseProvider.options, providers[effectiveId].options ?? {}) as any
        }
      }
    }

    for (const [providerID, fn] of Object.entries(CUSTOM_LOADERS)) {
      if (disabled.has(providerID)) continue
      const data = database[providerID]
      if (!data) {
        log.error("Provider does not exist in model list " + providerID)
        continue
      }
      const result = await fn(data)
      if (result && (result.autoload || providers[providerID])) {
        if (result.getModel) modelLoaders[providerID] = result.getModel
        const opts = result.options ?? {}
        const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
        mergeProvider(providerID, patch)
      }
    }

    // load config
    for (const [providerID, provider] of configProviders) {
      const partial: Partial<Info> = { source: "config" }
      if (provider.env) partial.env = provider.env
      if (provider.name) partial.name = provider.name
      if (provider.options) partial.options = provider.options
      mergeProvider(providerID, partial)
    }

    for (const [providerID, provider] of Object.entries(providers)) {
      if (!isProviderAllowed(providerID)) {
        delete providers[providerID]
        continue
      }

      const configProvider = config.provider?.[providerID]

      for (const [modelID, model] of Object.entries(provider.models)) {
        model.api.id = model.api.id ?? model.id ?? modelID
        if (modelID === "gpt-5-chat-latest" || (providerID === "openrouter" && modelID === "openai/gpt-5-chat"))
          delete provider.models[modelID]
        if (model.status === "alpha" && !Flag.OPENCODE_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
        if (model.status === "deprecated") delete provider.models[modelID]
        if (
          (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
          (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
        )
          delete provider.models[modelID]

        model.variants = mapValues(ProviderTransform.variants(model), (v) => v)

        // Filter out disabled variants from config
        const configVariants = configProvider?.models?.[modelID]?.variants
        if (configVariants && model.variants) {
          const merged = mergeDeep(model.variants, configVariants)
          model.variants = mapValues(
            pickBy(merged, (v) => !v.disabled),
            (v) => omit(v, ["disabled"]),
          )
        }
      }

      for (const modelID of Object.keys(provider.models)) {
        if (isModelIgnored(providerID, modelID)) {
          delete provider.models[modelID];
        }
      }

      if (Object.keys(provider.models).length === 0 || IGNORED_MODELS.has(providerID)) {
        delete providers[providerID]
        continue
      }




      log.info("found", { providerID })
    }

    return {
      models: languages,
      providers,
      sdk,
      modelLoaders,
    }
  })

  export async function list() {
    await state() // Ensure plugins and loaders are initialized

    const { Plugin } = await import("../plugin")
    // Wait for model discovery so that the first call (e.g. during TUI boot) 
    // actually has the models from plugins.
    await Plugin.discoverModels().catch(err => {
      log.error("model discovery failed", { error: err })
    })

    return state().then((state) => state.providers)
  }

  export async function addDynamicModels(discovered: any[]) {
    const s = await state()
    for (const m of discovered) {
      const pID = m.providerID
      if (!s.providers[pID]) continue

      const provider = s.providers[pID]
      if (provider.models[m.id]) continue

      const template = Object.values(provider.models)[0]
      if (!template) continue

      provider.models[m.id] = {
        ...template,
        id: m.id,
        name: m.name,
        api: { ...template.api, id: m.id }
      }
    }
  }

  async function getSDK(model: Model) {
    try {
      using _ = log.time("getSDK", {
        providerID: model.providerID,
      })
      const s = await state()
      const provider = s.providers[model.providerID]
      const options = { ...provider.options }

      if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
        options["includeUsage"] = true
      }

      if (!options["baseURL"]) options["baseURL"] = model.api.url
      if (options["apiKey"] === undefined) {
        if (provider.key) {
          options["apiKey"] = provider.key
        } else if (
          options["fetch"] ||
          model.providerID.includes("subscription") ||
          model.providerID.includes("managed") ||
          model.providerID.includes("antigravity") ||
          model.providerID.includes("gemini-cli")
        ) {
          // If we have a custom fetch (plugin) OR it's a known managed account type, 
          // inject dummy to satisfy SDK validation
          options["apiKey"] = "dummy"
        }
      }
      if (model.headers)
        options["headers"] = {
          ...options["headers"],
          ...model.headers,
        }
      if (Env.get("OPENCODE_SMOKE_DEBUG") && model.providerID.startsWith("anthropic-subscription")) {
        log.info("anthropic subscription sdk options", {
          providerID: model.providerID,
          hasFetch: typeof options["fetch"] === "function",
          headers: Object.keys(options["headers"] ?? {}),
          baseURL: options["baseURL"],
        })
      }

      const key = Bun.hash.xxHash32(JSON.stringify({ providerID: model.providerID, npm: model.api.npm, options }))
      const existing = s.sdk.get(key)
      if (existing) return existing

      const customFetch = options["fetch"]
      options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
        // Preserve custom fetch if it exists, wrap it with timeout logic
        const fetchFn = customFetch ?? fetch
        const opts = init ?? {}

        if (options["timeout"] !== undefined && options["timeout"] !== null) {
          const signals: AbortSignal[] = []
          if (opts.signal) signals.push(opts.signal)
          if (options["timeout"] !== false) signals.push(AbortSignal.timeout(options["timeout"]))

          const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

          opts.signal = combined
        }

        // Strip openai itemId metadata following what codex does
        // Codex uses #[serde(skip_serializing)] on id fields for all item types:
        // Message, Reasoning, FunctionCall, LocalShellCall, CustomToolCall, WebSearchCall
        // IDs are only re-attached for Azure with store=true
        if (model.api.npm === "@ai-sdk/openai" && opts.body && opts.method === "POST") {
          const body = JSON.parse(opts.body as string)
          const isAzure = model.providerID.includes("azure")
          const keepIds = isAzure && body.store === true
          if (!keepIds && Array.isArray(body.input)) {
            for (const item of body.input) {
              if ("id" in item) {
                delete item.id
              }
            }
            opts.body = JSON.stringify(body)
          }
        }

        return fetchFn(input, {
          ...opts,
          // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
          timeout: false,
        })
      }

      // Special case: google-vertex-anthropic uses a subpath import
      const bundledKey =
        model.providerID === "google-vertex-anthropic" ? "@ai-sdk/google-vertex/anthropic" : model.api.npm
      const bundledFn = BUNDLED_PROVIDERS[bundledKey]
      if (bundledFn) {
        log.info("using bundled provider", { providerID: model.providerID, pkg: bundledKey })
        const loaded = bundledFn({
          name: model.providerID,
          ...options,
        })
        s.sdk.set(key, loaded)
        return loaded as SDK
      }

      let installedPath: string
      if (!model.api.npm.startsWith("file://")) {
        installedPath = await BunProc.install(model.api.npm, "latest")
      } else {
        log.info("loading local provider", { pkg: model.api.npm })
        installedPath = model.api.npm
      }

      const mod = await import(installedPath)

      const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
      const loaded = fn({
        name: model.providerID,
        ...options,
      })
      s.sdk.set(key, loaded)
      return loaded as SDK
    } catch (e) {
      log.error("getSDK failed", { providerID: model.providerID, modelID: model.id, error: e })
      throw new InitError({ providerID: model.providerID }, { cause: e })
    }
  }

  export async function getProvider(providerID: string) {
    return state().then((s) => s.providers[providerID])
  }

  export async function getModel(providerID: string, modelID: string) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) {
      const availableProviders = Object.keys(s.providers)
      const matches = fuzzysort.go(providerID, availableProviders, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }

    const info = provider.models[modelID]
    if (!info) {
      const availableModels = Object.keys(provider.models)
      const matches = fuzzysort.go(modelID, availableModels, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }
    return info
  }

  export async function getLanguage(model: Model): Promise<LanguageModelV2> {
    const s = await state()
    const key = `${model.providerID}/${model.id}`
    if (s.models.has(key)) return s.models.get(key)!

    const provider = s.providers[model.providerID]
    const sdk = await getSDK(model)

    try {
      const language = s.modelLoaders[model.providerID]
        ? await s.modelLoaders[model.providerID](sdk, model.api.id, provider.options)
        : sdk.languageModel(model.api.id)
      s.models.set(key, language)
      return language
    } catch (e) {
      if (e instanceof NoSuchModelError)
        throw new ModelNotFoundError(
          {
            modelID: model.id,
            providerID: model.providerID,
          },
          { cause: e },
        )
      throw e
    }
  }

  export async function closest(providerID: string, query: string[]) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) return undefined
    for (const item of query) {
      for (const modelID of Object.keys(provider.models)) {
        if (modelID.includes(item))
          return {
            providerID,
            modelID,
          }
      }
    }
  }

  export async function getSmallModel(providerID: string) {
    const cfg = await Config.get()

    if (cfg.small_model) {
      const parsed = parseModel(cfg.small_model)
      return getModel(parsed.providerID, parsed.modelID)
    }

    const provider = await state().then((state) => state.providers[providerID])
    if (provider) {
      let priority = [
        "claude-haiku-4-5",
        "claude-haiku-4.5",
        "3-5-haiku",
        "3.5-haiku",
        "gemini-3-flash",
        "gemini-2.5-flash",
        "gpt-5-nano",
      ]
      if (providerID.startsWith("opencode")) {
        priority = ["gpt-5-nano"]
      }
      if (providerID.startsWith("github-copilot")) {
        // prioritize free models for github copilot
        priority = ["gpt-5-mini", "claude-haiku-4.5", ...priority]
      }
      for (const item of priority) {
        for (const model of Object.keys(provider.models)) {
          if (model.includes(item)) return getModel(providerID, model)
        }
      }
    }

    // Check if opencode provider is available before using it
    const opencodeProvider = await state().then((state) => state.providers["opencode"])
    if (opencodeProvider && opencodeProvider.models["gpt-5-nano"]) {
      return getModel("opencode", "gpt-5-nano")
    }

    return undefined
  }

  const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
  export function sort(models: Model[]) {
    return sortBy(
      models,
      [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export async function defaultModel() {
    const cfg = await Config.get()
    if (cfg.model) return parseModel(cfg.model)

    const provider = await list()
      .then((val) => Object.values(val))
      .then((x) => x.find((p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id)))
    if (!provider) throw new Error("no providers found")
    const [model] = sort(Object.values(provider.models))
    if (!model) throw new Error("no models found")
    return {
      providerID: provider.id,
      modelID: model.id,
    }
  }

  export function parseModel(model: string) {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: providerID,
      modelID: rest.join("/"),
    }
  }

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: z.string(),
      modelID: z.string(),
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: z.string(),
    }),
  )
}
