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
import { getRateLimitTracker } from "../account/rotation"
import { Env } from "../env"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { Global } from "../global"
import { Installation } from "../installation"
import { debugCheckpoint } from "../util/debug"

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
import { createOpenaiCompatible as createGitHubCopilotOpenAICompatible } from "./sdk/copilot"
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
    "google/gemini-embedding-001",
    "google/text-embedding-004",
    "google/embedding-001",
  ])

  const ANTIGRAVITY_WHITELIST = new Set([
    "gemini-3-pro-high",
    "gemini-3-pro-low",
    "gemini-3-pro",
    "gemini-3-flash",
    "claude-3-7-sonnet",
    "claude-3-7-sonnet-thinking",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-thinking",
    "claude-opus-4-5",
    "claude-opus-4-5-thinking",
    "claude-opus-4-1",
    "claude-opus-4-2",
    "gpt-oss-120b-medium",
    "gpt-5.1-codex",
  ])
  const IGNORED_DYNAMIC = new Set<string>()

  /**
   * Bundled default models for GitHub Copilot.
   * Used as fallback when dynamic fetching fails.
   * NOTE: The actual available models depend on the user's Copilot subscription plan.
   * Free tier may only have access to limited models like claude-haiku-4.5.
   * This is a minimal conservative list; dynamic fetch will get the real list.
   */
  const GITHUB_COPILOT_DEFAULT_MODELS: Array<{
    id: string
    name: string
    family: string
    reasoning?: boolean
  }> = [
    // Free tier models (most likely available)
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", family: "claude" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini", family: "openai" },
    // Pro/Enterprise tier models (may require paid subscription)
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", family: "claude" },
    { id: "gpt-4o", name: "GPT-4o", family: "openai" },
    { id: "o1", name: "OpenAI o1", family: "openai", reasoning: true },
    { id: "o1-mini", name: "OpenAI o1 Mini", family: "openai", reasoning: true },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", family: "gemini" },
  ]

  /**
   * Fetch models dynamically from a provider's API.
   * Returns null if fetching fails (fallback to defaults).
   */
  async function fetchProviderModels(
    providerId: string,
    authToken: string,
    baseURL?: string,
  ): Promise<Array<{ id: string; name: string }> | null> {
    try {
      // Determine API endpoint based on provider
      let url: string
      const headers: Record<string, string> = {
        Authorization: `Bearer ${authToken}`,
      }

      if (providerId.startsWith("github-copilot")) {
        // GitHub Copilot uses OpenAI-compatible API with specific headers
        url = baseURL ? `${baseURL}/models` : "https://api.githubcopilot.com/models"
        // Add required headers for GitHub Copilot API
        headers["User-Agent"] = `opencode/${Installation.VERSION}`
        headers["Openai-Intent"] = "conversation-edits"
        headers["x-initiator"] = "user"
      } else {
        // Generic OpenAI-compatible endpoint
        url = baseURL ? `${baseURL}/models` : (null as any)
        if (!url) return null
      }

      log.info("Fetching models from provider", { providerId, url })

      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) {
        log.warn("Failed to fetch models from provider", {
          providerId,
          status: response.status,
        })
        return null
      }

      const data = await response.json()

      // Parse OpenAI-style /models response
      if (data.data && Array.isArray(data.data)) {
        return data.data.map((m: any) => ({
          id: m.id,
          name: m.name || m.id,
        }))
      }

      // Parse simple array response
      if (Array.isArray(data)) {
        return data.map((m: any) => ({
          id: typeof m === "string" ? m : m.id,
          name: typeof m === "string" ? m : m.name || m.id,
        }))
      }

      return null
    } catch (e) {
      log.warn("Error fetching models from provider", { providerId, error: e })
      return null
    }
  }

  /**
   * Create a Model object from bundled model definition
   */
  function createCopilotModel(
    providerId: string,
    model: { id: string; name: string; family?: string; reasoning?: boolean },
  ): Model {
    return {
      id: model.id,
      name: model.name,
      providerId,
      family: (model.family || "openai") as any,
      api: {
        id: model.id,
        url: "https://api.githubcopilot.com",
        npm: "@ai-sdk/github-copilot",
      },
      status: "active",
      capabilities: {
        temperature: true,
        reasoning: model.reasoning || false,
        attachment: true,
        toolcall: true,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 128000, output: 16384 },
      options: {},
      variants: {},
      headers: {},
      release_date: "2025-01-01",
    }
  }

  async function loadIgnoredDynamic() {
    IGNORED_DYNAMIC.clear()
    const file = Bun.file(`${Global.Path.user}/ignored-models.json`)
    const exists = await file.exists()
    if (!exists) return
    const data = await file.json().catch(() => [])
    if (!Array.isArray(data)) return
    for (const entry of data) {
      if (typeof entry === "string" && entry.length > 0) IGNORED_DYNAMIC.add(entry)
    }
  }

  export function isModelIgnored(providerId: string, modelID: string): boolean {
    if (IGNORED_DYNAMIC.has(providerId) || IGNORED_DYNAMIC.has(`${providerId}/*`)) return true
    if (IGNORED_DYNAMIC.has(`${providerId}/${modelID}`)) return true
    if (IGNORED_MODELS.has(providerId) || IGNORED_MODELS.has(`${providerId}/*`)) return true
    if (IGNORED_MODELS.has(`${providerId}/${modelID}`)) return true

    // Check for any ignored model ID that appears as the base model in any provider
    for (const ignored of IGNORED_MODELS) {
      if (ignored.includes("/")) {
        const [ignoredProvider, ignoredModel] = ignored.split("/")
        if (modelID === ignoredModel && (providerId === ignoredProvider || providerId.includes(ignoredProvider))) {
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
    // NOTE: User-Agent and anthropic-client headers are NOT set here
    // They are set by the npm package opencode-anthropic-auth through its custom fetch
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

      // TODO: Using process.env directly because Env.set only updates a process.env shallow copy,
      // until the scope of the Env API is clarified (test only or runtime?)
      const awsBearerToken = iife(() => {
        const envToken = process.env.AWS_BEARER_TOKEN_BEDROCK
        if (envToken) return envToken
        if (auth?.type === "api") {
          process.env.AWS_BEARER_TOKEN_BEDROCK = auth.key
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
      // TODO: Using process.env directly because Env.set only updates a shallow copy (not process.env),
      // until the scope of the Env API is clarified (test only or runtime?)
      const envServiceKey = iife(() => {
        const envAICoreServiceKey = process.env.AICORE_SERVICE_KEY
        if (envAICoreServiceKey) return envAICoreServiceKey
        if (auth?.type === "api") {
          process.env.AICORE_SERVICE_KEY = auth.key
          return auth.key
        }
        return undefined
      })
      const deploymentId = process.env.AICORE_DEPLOYMENT_ID
      const resourceGroup = process.env.AICORE_RESOURCE_GROUP

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
    gmicloud: async () => {
      // @event_2026-02-06:gmicloud_provider
      return {
        autoload: true,
        options: {
          baseURL: "https://api.gmi-serving.com/v1",
        },
      }
    },
  }

  export const Model = z
    .object({
      id: z.string(),
      providerId: z.string(),
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
      providerId: provider.id,
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
    debugCheckpoint("provider", "state init start")
    using _ = log.time("state")
    const config = await Config.get()
    const modelsDev = await ModelsDev.get()
    debugCheckpoint("provider", "models.dev loaded", { providerCount: Object.keys(modelsDev).length })
    const database = mapValues(modelsDev, fromModelsDevProvider)

    // Inject github-copilot with bundled default models if not in models.dev or if models are empty
    if (!database["github-copilot"] || Object.keys(database["github-copilot"].models || {}).length === 0) {
      debugCheckpoint("provider", "injecting copilot defaults")
      const copilotModels: Record<string, Model> = {}
      for (const m of GITHUB_COPILOT_DEFAULT_MODELS) {
        copilotModels[m.id] = createCopilotModel("github-copilot", m)
      }
      if (!database["github-copilot"]) {
        database["github-copilot"] = {
          id: "github-copilot",
          source: "custom",
          name: "GitHub Copilot",
          env: [],
          options: {},
          models: copilotModels,
        }
      } else {
        // Provider exists but has no models - inject bundled models
        database["github-copilot"].models = copilotModels
      }
      log.info("Injected bundled github-copilot models", { count: Object.keys(copilotModels).length })
    }
    if (
      !database["github-copilot-enterprise"] ||
      Object.keys(database["github-copilot-enterprise"].models || {}).length === 0
    ) {
      const copilotModels: Record<string, Model> = {}
      for (const m of GITHUB_COPILOT_DEFAULT_MODELS) {
        copilotModels[m.id] = createCopilotModel("github-copilot-enterprise", m)
      }
      if (!database["github-copilot-enterprise"]) {
        database["github-copilot-enterprise"] = {
          id: "github-copilot-enterprise",
          source: "custom",
          name: "GitHub Copilot Enterprise",
          env: [],
          options: {},
          models: copilotModels,
        }
      } else {
        // Provider exists but has no models - inject bundled models
        database["github-copilot-enterprise"].models = copilotModels
      }
      log.info("Injected bundled github-copilot-enterprise models", { count: Object.keys(copilotModels).length })
    }

    const disabled = new Set(config.disabled_providers ?? [])
    await loadIgnoredDynamic()

    // Simplified: only use blacklist (disabled_providers)
    // UI show/hide is handled separately in local storage
    function isProviderAllowed(providerId: string): boolean {
      return !disabled.has(providerId)
    }

    const providers: { [providerId: string]: Info } = {}
    const languages = new Map<string, LanguageModelV2>()
    const modelLoaders: {
      [providerId: string]: CustomModelLoader
    } = {}
    const sdk = new Map<number, SDK>()

    log.info("init")

    const configProviders = Object.entries(config.provider ?? {})

    function mergeProvider(providerId: string, provider: Partial<Info>) {
      const existing = providers[providerId]
      if (existing) {
        // @ts-expect-error
        providers[providerId] = mergeDeep(existing, provider)
        return
      }
      const match = database[providerId]
      if (!match) return
      // @ts-expect-error
      providers[providerId] = mergeDeep(match, provider)
    }

    // extend database from config
    for (const [providerId, provider] of configProviders) {
      const existing = database[providerId]
      const parsed: Info = {
        id: providerId,
        name: providerId === "google-api" ? "Google (API Key)" : (provider.name ?? existing?.name ?? providerId),
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
              modelsDev[providerId]?.npm ??
              "@ai-sdk/openai-compatible",
            url: provider?.api ?? existingModel?.api.url ?? modelsDev[providerId]?.api,
          },
          status: model.status ?? existingModel?.status ?? "active",
          name,
          providerId,
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
      database[providerId] = parsed
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
            const m = { ...model, providerId: targetID }
            if (patch.id === "gemini-cli" && m.api) {
              m.api = { ...m.api, npm: "@ai-sdk/google" }
            }
            return m
          }),
        }
      }
    }

    inheritFrom("github-copilot-enterprise", "github-copilot", { name: "GitHub Copilot Enterprise" })

    // ============================================================
    // SELF-BUILT PROVIDERS: antigravity and gemini-cli
    // These providers are completely self-built and do NOT inherit
    // from models.dev or google-api. All structure must be defined here.
    // ============================================================

    // Initialize Antigravity as a clean self-built provider
    database["antigravity"] = {
      id: "antigravity",
      name: "Antigravity",
      source: "custom",
      env: [],
      options: {},
      models: {},
    }

    // Initialize Gemini CLI as a clean self-built provider (do NOT inherit from google-api)
    database["gemini-cli"] = {
      id: "gemini-cli",
      name: "Gemini CLI",
      source: "custom",
      env: ["GEMINI_API_KEY"],
      options: {},
      models: {},
    }

    // Populate Gemini CLI models (official gemini-cli supported models)
    // Reference: https://geminicli.com/docs/cli/model/
    const geminiCliModels = [
      { id: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview", reasoning: true, context: 2097152 },
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview", reasoning: false, context: 1048576 },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, context: 2097152 },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", reasoning: false, context: 1048576 },
      { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", reasoning: false, context: 1048576 },
    ]

    for (const m of geminiCliModels) {
      database["gemini-cli"].models[m.id] = {
        id: m.id,
        name: m.name,
        providerId: "gemini-cli",
        family: "gemini",
        api: { id: m.id, url: "https://generativelanguage.googleapis.com", npm: "@ai-sdk/google" },
        status: "active",
        capabilities: {
          temperature: true,
          reasoning: m.reasoning,
          attachment: true,
          interleaved: false,
          input: { text: true, image: true, audio: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          toolcall: true,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: m.context, output: 8192 },
        options: {},
        variants: {},
        headers: {},
        release_date: "2025-01-01",
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
        { id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet (Latest)" },
      ]

      for (const m of anthropicModels) {
        database["anthropic"].models[m.id] = {
          id: m.id,
          name: m.name,
          providerId: "anthropic",
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
            toolcall: true,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 200000, output: 4096 },
          options: {},
          variants: {},
          headers: {},
          release_date: "2024-01-01",
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
          model.providerId = "antigravity"
          model.api = { ...model.api, npm: "@ai-sdk/google", url: "https://generativelanguage.googleapis.com" }
          database["antigravity"].models[id] = model
        }
      }

      const manualModels = [
        { id: "claude-opus-4-5-thinking", name: "Claude 4.5 Opus (Thinking)", family: "claude", reasoning: true },
        { id: "claude-opus-4-5", name: "Claude 4.5 Opus", family: "claude" },
        { id: "claude-sonnet-4-5-thinking", name: "Claude 4.5 Sonnet (Thinking)", family: "claude", reasoning: true },
        { id: "claude-sonnet-4-5", name: "Claude 4.5 Sonnet", family: "claude" },
        { id: "gemini-3-pro-high", name: "Gemini 3 Pro (High)", family: "gemini-pro", image: false },
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
          providerId: "antigravity",
          family: m.family as any,
          api: { id: m.id, url: "https://generativelanguage.googleapis.com", npm: "@ai-sdk/google" },
          status: "active",
          capabilities: {
            temperature: true,
            reasoning: m.reasoning || false,
            attachment: true,
            toolcall: true,
            input: { text: true, image: (m as any).image ?? true, audio: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 200000, output: 8192 },
          options: {},
          variants: {},
          headers: {},
          release_date: "2025-01-01",
        }
      }
    }

    // Initialize GMI Cloud
    // @event_2026-02-06:gmicloud_provider
    database["gmicloud"] = {
      id: "gmicloud",
      name: "GMI Cloud",
      source: "custom",
      env: ["GMI_API_KEY"],
      options: { baseURL: "https://api.gmi-serving.com/v1" },
      models: {
        "deepseek-ai/DeepSeek-R1": {
          id: "deepseek-ai/DeepSeek-R1",
          name: "DeepSeek R1",
          providerId: "gmicloud",
          family: "deepseek",
          api: {
            id: "deepseek-ai/DeepSeek-R1",
            url: "https://api.gmi-serving.com/v1",
            npm: "@ai-sdk/openai-compatible",
          },
          status: "active",
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: false,
            toolcall: true,
            input: { text: true, image: false, audio: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 64000, output: 8000 },
          options: {},
          variants: {},
          headers: {},
          release_date: "2025-01-01",
        },
      },
    }
    mergeProvider("gmicloud", { source: "custom" })

    // Ensure Antigravity provider is always available if populated (even if no account active)
    // This prevents fallback to Codex when account sync is flaky or during transitions
    if (database["antigravity"]) {
      log.info("Antigravity database entry", {
        modelCount: Object.keys(database["antigravity"].models).length,
        models: Object.keys(database["antigravity"].models),
      })
      mergeProvider("antigravity", { source: "custom" })
      log.info("Antigravity after merge", {
        inProviders: !!providers["antigravity"],
        modelCount: providers["antigravity"] ? Object.keys(providers["antigravity"].models).length : 0,
      })
    }

    // Ensure Gemini CLI provider is always available if populated
    if (database["gemini-cli"]) {
      log.info("Gemini CLI database entry", {
        modelCount: Object.keys(database["gemini-cli"].models).length,
        models: Object.keys(database["gemini-cli"].models),
      })
      mergeProvider("gemini-cli", { source: "custom" })
      log.info("Gemini CLI after merge", {
        inProviders: !!providers["gemini-cli"],
        modelCount: providers["gemini-cli"] ? Object.keys(providers["gemini-cli"].models).length : 0,
      })
    }

    // Ensure GitHub Copilot providers are available with bundled models
    if (database["github-copilot"]) {
      mergeProvider("github-copilot", { source: "custom" })
    }
    if (database["github-copilot-enterprise"]) {
      mergeProvider("github-copilot-enterprise", { source: "custom" })
    }

    // Ensure GitLab provider is available so tests and manual config work
    if (!database["gitlab"]) {
      database["gitlab"] = {
        id: "gitlab",
        name: "GitLab Duo",
        source: "custom",
        env: ["GITLAB_TOKEN"],
        options: {},
        models: {},
      }
    }

    // Inherit models for account-suffixed providers
    for (const [providerId, provider] of Object.entries(database)) {
      // Match pattern: "provider-accountname"
      const match = providerId.match(/^([a-z-]+)-[a-z0-9-]+$/)
      if (match) {
        const baseProviderID = match[1] // e.g., "google-api" from "google-api-work"
        const baseProvider = database[baseProviderID]

        // If base exists and account provider has no models, inherit everything
        if (baseProvider && Object.keys(provider.models).length === 0) {
          log.info("inheriting models", { from: baseProviderID, to: providerId })
          database[providerId] = {
            ...provider,
            name: provider.name || `${baseProvider.name} (${providerId.split("-").pop()})`,
            models: mapValues(baseProvider.models, (model) => ({
              ...model,
              providerId: providerId, // Update to account-specific provider
            })),
            env: baseProvider.env,
          }
        }
      }
    }

    // load env
    const env = Env.all()
    for (const [providerId, provider] of Object.entries(database)) {
      if (disabled.has(providerId)) continue
      const apiKey = provider.env.map((item) => env[item]).find(Boolean)
      if (!apiKey) continue
      mergeProvider(providerId, {
        source: "env",
        key: provider.env.length === 1 ? apiKey : undefined,
      })
    }

    // load apikeys and other auth
    for (const [providerId, provider] of Object.entries(await Auth.all())) {
      if (disabled.has(providerId)) continue
      if (provider.type === "api") {
        mergeProvider(providerId, {
          source: "api",
          key: provider.key,
        })
        // @ts-ignore
      } else if (provider.type === "oauth" || provider.type === "subscription") {
        mergeProvider(providerId, {
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
        let effectiveId = accountId
        if (family === "antigravity") {
          if (accountId !== familyData.activeAccount) {
            continue
          }
          effectiveId = "antigravity"
        } else if (
          family === "antigravity" &&
          accountId.startsWith("antigravity-subscription-") &&
          accountInfo.type === "subscription" &&
          accountInfo.email
        ) {
          // Fallback logic for safety (though the above if block covers it)
          const username = accountInfo.email.split("@")[0]
          effectiveId = `antigravity-${username}`
        }

        // Determine display name
        let displayName = Account.getDisplayName(accountId, accountInfo, family)
        if (
          family === "antigravity" &&
          effectiveId === "antigravity" &&
          accountInfo.type === "subscription" &&
          accountInfo.email
        ) {
          displayName = `Antigravity (${accountInfo.email})`
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

        if (family === "google-api") {
          options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const urlString = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
            debugCheckpoint("google-api", "Custom fetch called", { url: urlString, family })

            if (init?.body && typeof init.body === "string" && urlString.includes("generativelanguage")) {
              debugCheckpoint("google-api", "Processing generativelanguage request body")
              try {
                const body = JSON.parse(init.body) as Record<string, unknown>
                let signaturesAdded = 0

                const processContents = (contents: unknown, path: string): void => {
                  if (!contents || !Array.isArray(contents)) {
                    debugCheckpoint("google-api", `processContents: no contents at ${path}`)
                    return
                  }
                  debugCheckpoint("google-api", `processContents: ${path}`, {
                    contentCount: (contents as any[]).length,
                  })

                  for (const content of contents) {
                    if (content && typeof content === "object") {
                      const parts = (content as Record<string, unknown>).parts
                      if (parts && Array.isArray(parts)) {
                        for (const part of parts) {
                          if (part && typeof part === "object") {
                            const partObj = part as Record<string, unknown>
                            if (partObj.functionCall && !partObj.thoughtSignature) {
                              partObj.thoughtSignature = "skip_thought_signature_validator"
                              signaturesAdded++
                              debugCheckpoint("google-api", "Added thoughtSignature", {
                                functionName: (partObj.functionCall as any)?.name,
                              })
                            }
                          }
                        }
                      }
                    }
                  }
                }

                processContents(body.contents, "contents")
                if (body.request && typeof body.request === "object") {
                  processContents((body.request as Record<string, unknown>).contents, "request.contents")
                }

                debugCheckpoint("google-api", "Thought signatures processing complete", { signaturesAdded })
                init = { ...init, body: JSON.stringify(body) }
              } catch (e) {
                debugCheckpoint("google-api", "Error processing body", { error: String(e) })
                // Ignore json parse error
              }
            } else {
              debugCheckpoint("google-api", "Skipping body processing", {
                hasBody: !!init?.body,
                isString: typeof init?.body === "string",
                isGenerativelanguage: urlString.includes("generativelanguage"),
              })
            }
            return fetch(input, init)
          }
        }

        const blocked = undefined

        // Whitelist of truly supported Antigravity models
        const ANTIGRAVITY_WHITELIST = new Set([
          "gemini-3-pro-high",
          "gemini-3-pro-low",
          "gemini-3-pro",
          "gemini-3-flash",
          "claude-3-7-sonnet",
          "claude-3-7-sonnet-thinking",
          "claude-sonnet-4-5",
          "claude-sonnet-4-5-thinking",
          "claude-opus-4-5",
          "claude-opus-4-5-thinking",
          "claude-opus-4-1",
          "claude-opus-4-2",
          "gpt-oss-120b-medium",
          "gpt-5.1-codex",
        ])

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
              providerId: effectiveId,
            })),
            (model, id) =>
              (family !== "antigravity" || ANTIGRAVITY_WHITELIST.has(id)) && !isModelIgnored(effectiveId, id),
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

      const baseProvider = database["antigravity"] ?? database["google-api"]
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
            providerId: accountID,
          })),
          (model, id) =>
            (!accountID.includes("antigravity") || ANTIGRAVITY_WHITELIST.has(id)) && !isModelIgnored(accountID, id),
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
      if (family === "antigravity" || family === "google-api") {
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

        // Dynamic model fetching for github-copilot
        // Try to fetch models from the API, fallback to bundled defaults
        const copilotProviders = [family, enterpriseProviderID].filter((id) => !disabled.has(id) && providers[id])

        for (const copilotID of copilotProviders) {
          const auth = await Auth.get(copilotID)
          if (!auth || auth.type !== "oauth") continue

          const token = auth.refresh || auth.access
          if (!token) continue

          const baseURL = auth.enterpriseUrl
            ? `https://copilot-api.${auth.enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
            : undefined

          const fetchedModels = await fetchProviderModels(copilotID, token, baseURL)

          if (fetchedModels && fetchedModels.length > 0) {
            log.info("Fetched dynamic models from provider", {
              providerId: copilotID,
              count: fetchedModels.length,
            })

            // Merge fetched models into provider
            for (const fm of fetchedModels) {
              if (!providers[copilotID].models[fm.id]) {
                providers[copilotID].models[fm.id] = createCopilotModel(copilotID, fm)
              }
            }
          } else {
            log.info("Using bundled default models for provider", {
              providerId: copilotID,
              count: Object.keys(providers[copilotID]?.models || {}).length,
            })
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
        let effectiveId = accountId
        if (
          family === "antigravity" &&
          accountId.startsWith("antigravity-subscription-") &&
          accountInfo.type === "subscription" &&
          accountInfo.email
        ) {
          const username = accountInfo.email.split("@")[0]
          effectiveId = `antigravity-${username}`
        }

        if (providers[effectiveId]) {
          // Merge options, prioritizing account-specific options (from plugin loaders)
          providers[effectiveId].options = mergeDeep(baseProvider.options, providers[effectiveId].options ?? {}) as any
        }
      }
    }

    for (const [providerId, fn] of Object.entries(CUSTOM_LOADERS)) {
      if (disabled.has(providerId)) continue
      const data = database[providerId]
      if (!data) {
        log.error("Provider does not exist in model list " + providerId)
        continue
      }
      debugCheckpoint("provider", "custom loader start", { providerId })
      const result = await fn(data)
      debugCheckpoint("provider", "custom loader end", { providerId, autoload: result?.autoload })
      if (result && (result.autoload || providers[providerId])) {
        if (result.getModel) modelLoaders[providerId] = result.getModel
        const opts = result.options ?? {}
        const patch: Partial<Info> = providers[providerId] ? { options: opts } : { source: "custom", options: opts }
        mergeProvider(providerId, patch)
      }
    }

    // load config
    for (const [providerId, provider] of configProviders) {
      const partial: Partial<Info> = { source: "config" }
      if (provider.env) partial.env = provider.env
      if (provider.name) partial.name = provider.name
      if (provider.options) partial.options = provider.options
      mergeProvider(providerId, partial)
    }

    for (const [providerId, provider] of Object.entries(providers)) {
      debugCheckpoint("provider", "post-processing start", { providerId })
      if (!isProviderAllowed(providerId)) {
        debugCheckpoint("provider", "provider disabled", { providerId })
        delete providers[providerId]
        continue
      }

      const configProvider = config.provider?.[providerId]

      for (const [modelID, model] of Object.entries(provider.models)) {
        try {
          model.api.id = model.api.id ?? model.id ?? modelID
          if (modelID === "gpt-5-chat-latest" || (providerId === "openrouter" && modelID === "openai/gpt-5-chat")) {
            delete provider.models[modelID]
            continue
          }
          if (model.status === "alpha" && !Flag.OPENCODE_ENABLE_EXPERIMENTAL_MODELS) {
            delete provider.models[modelID]
            continue
          }
          if (model.status === "deprecated") {
            delete provider.models[modelID]
            continue
          }
          if (
            (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
            (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
          ) {
            delete provider.models[modelID]
            continue
          }

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
        } catch (e) {
          debugCheckpoint("provider", "model processing error", { providerId, modelID, error: String(e) })
          delete provider.models[modelID]
        }
      }

      for (const modelID of Object.keys(provider.models)) {
        if (isModelIgnored(providerId, modelID)) {
          delete provider.models[modelID]
        }
      }

      if (Object.keys(provider.models).length === 0 || IGNORED_MODELS.has(providerId)) {
        debugCheckpoint("provider", "deleting empty or ignored provider", {
          providerId,
          count: Object.keys(provider.models).length,
        })
        delete providers[providerId]
        continue
      }

      debugCheckpoint("provider", "post-processing end", { providerId })
      log.info("found", { providerId })
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
    await Plugin.discoverModels().catch((err) => {
      log.error("model discovery failed", { error: err })
    })

    return state().then((state) => state.providers)
  }

  export async function addDynamicModels(discovered: any[]) {
    const s = await state()
    for (const m of discovered) {
      const pID = m.providerId
      if (!s.providers[pID]) continue

      const provider = s.providers[pID]
      if (provider.models[m.id]) continue

      const template = Object.values(provider.models)[0]
      if (!template) continue

      provider.models[m.id] = {
        ...template,
        id: m.id,
        name: m.name,
        api: { ...template.api, id: m.id },
      }
    }
  }

  async function getSDK(model: Model) {
    try {
      using _ = log.time("getSDK", {
        providerId: model.providerId,
      })
      const s = await state()
      const provider = s.providers[model.providerId]
      const options = { ...provider.options }

      debugCheckpoint("provider", "getSDK called", {
        providerId: model.providerId,
        modelID: model.id,
        apiNpm: model.api.npm,
        providerSource: provider?.source,
        hasCustomFetch: typeof options.fetch === "function",
        optionKeys: Object.keys(options),
      })

      if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
        options["includeUsage"] = true
      }

      if (!options["baseURL"]) options["baseURL"] = model.api.url
      if (options["apiKey"] === undefined) {
        if (provider.key) {
          options["apiKey"] = provider.key
        } else if (
          options["fetch"] ||
          model.providerId.includes("subscription") ||
          model.providerId.includes("managed") ||
          model.providerId.includes("antigravity") ||
          model.providerId.includes("gemini-cli")
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
      if (Env.get("OPENCODE_SMOKE_DEBUG") && model.providerId.startsWith("anthropic-subscription")) {
        log.info("anthropic subscription sdk options", {
          providerId: model.providerId,
          hasFetch: typeof options["fetch"] === "function",
          headers: Object.keys(options["headers"] ?? {}),
          baseURL: options["baseURL"],
        })
      }

      const key = Bun.hash.xxHash32(JSON.stringify({ providerId: model.providerId, npm: model.api.npm, options }))
      const existing = s.sdk.get(key)
      if (existing) return existing

      const customFetch = options["fetch"]
      const wrappedProviderID = model.providerId
      const wrappedModelID = model.id
      options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
        const inputUrl = typeof input === "string" ? input : input?.url || String(input)
        debugCheckpoint("provider-fetch", "SDK fetch wrapper called", {
          providerId: wrappedProviderID,
          modelID: wrappedModelID,
          url: inputUrl,
          hasCustomFetch: !!customFetch,
          method: init?.method,
        })

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
          const isAzure = model.providerId.includes("azure")
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

        // Add thought signatures to Gemini API function calls
        // Gemini 3+ models with thinking require thoughtSignature on functionCall parts
        // This handles the "google" provider which doesn't have a custom fetch with signature handling
        if (inputUrl.includes("generativelanguage.googleapis.com") && opts.body && opts.method === "POST") {
          try {
            const body = JSON.parse(opts.body as string)
            let modified = false
            if (Array.isArray(body.contents)) {
              for (const content of body.contents) {
                if (content && Array.isArray(content.parts)) {
                  for (const part of content.parts) {
                    if (part && typeof part === "object" && "functionCall" in part && !part.thoughtSignature) {
                      part.thoughtSignature = "skip_thought_signature_validator"
                      modified = true
                    }
                  }
                }
              }
            }
            if (modified) {
              opts.body = JSON.stringify(body)
              debugCheckpoint("provider-fetch", "Added thought signatures to Gemini function calls", {
                providerId: wrappedProviderID,
                modelID: wrappedModelID,
              })
            }
          } catch {
            // If parsing fails, proceed with original body
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
        model.providerId === "google-vertex-anthropic" ? "@ai-sdk/google-vertex/anthropic" : model.api.npm
      const bundledFn = BUNDLED_PROVIDERS[bundledKey]
      if (bundledFn) {
        log.info("using bundled provider", { providerId: model.providerId, pkg: bundledKey })
        const loaded = bundledFn({
          name: model.providerId,
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
        name: model.providerId,
        ...options,
      })
      s.sdk.set(key, loaded)
      return loaded as SDK
    } catch (e) {
      log.error("getSDK failed", { providerId: model.providerId, modelID: model.id, error: e })
      throw new InitError({ providerId: model.providerId }, { cause: e })
    }
  }

  export async function getProvider(providerId: string) {
    return state().then((s) => s.providers[providerId])
  }

  export async function getModel(providerId: string, modelID: string) {
    const s = await state()
    const provider = s.providers[providerId]
    if (!provider) {
      const availableProviders = Object.keys(s.providers)
      const matches = fuzzysort.go(providerId, availableProviders, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerId, modelID, suggestions })
    }

    const info = provider.models[modelID]
    if (!info) {
      const availableModels = Object.keys(provider.models)
      const matches = fuzzysort.go(modelID, availableModels, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerId, modelID, suggestions })
    }
    return info
  }

  export async function getLanguage(model: Model): Promise<LanguageModelV2> {
    const s = await state()
    const key = `${model.providerId}/${model.id}`
    if (s.models.has(key)) return s.models.get(key)!

    const provider = s.providers[model.providerId]
    const sdk = await getSDK(model)

    try {
      const language = s.modelLoaders[model.providerId]
        ? await s.modelLoaders[model.providerId](sdk, model.api.id, provider.options)
        : sdk.languageModel(model.api.id)
      s.models.set(key, language)
      return language
    } catch (e) {
      if (e instanceof NoSuchModelError)
        throw new ModelNotFoundError(
          {
            modelID: model.id,
            providerId: model.providerId,
          },
          { cause: e },
        )
      throw e
    }
  }

  export async function closest(providerId: string, query: string[]) {
    const s = await state()
    const provider = s.providers[providerId]
    if (!provider) return undefined
    for (const item of query) {
      for (const modelID of Object.keys(provider.models)) {
        if (modelID.includes(item))
          return {
            providerId,
            modelID,
          }
      }
    }
  }

  /**
   * @event_2026-02-06:rotation_unify
   * Check if a model is available for a specific provider.
   * Uses RateLimitTracker with account dimension for per-account rate limiting.
   */
  async function isModelAvailable(pid: string, modelID: string): Promise<boolean> {
    const family = Account.parseFamily(pid)
    if (!family) return true // No family = no account tracking, assume available

    const accountId = await Account.getActive(family)
    if (!accountId) return true // No active account, assume available

    const tracker = getRateLimitTracker()
    return !tracker.isRateLimited(accountId, pid, modelID)
  }

  export async function getSmallModel(providerId: string) {
    const cfg = await Config.get()

    // User-configured small model takes priority (but check health)
    if (cfg.small_model) {
      const parsed = parseModel(cfg.small_model)
      if (await isModelAvailable(parsed.providerId, parsed.modelID)) {
        return getModel(parsed.providerId, parsed.modelID)
      }
      // Fall through to find healthy alternative
    }

    // Priority list of small models to try
    const priority = [
      "claude-haiku-4-5",
      "claude-haiku-4.5",
      "3-5-haiku",
      "3.5-haiku",
      "gemini-3-flash",
      "gemini-2.5-flash",
      "gpt-5-nano",
      "gpt-5-mini",
    ]

    // Collect all candidates from ALL available providers
    const candidates: Array<{ providerId: string; modelID: string; priorityIndex: number }> = []
    const providers = await state().then((s) => s.providers)

    for (const [pid, provider] of Object.entries(providers)) {
      if (!provider?.models) continue

      for (const modelID of Object.keys(provider.models)) {
        // Find priority index for this model
        const priorityIndex = priority.findIndex((p) => modelID.includes(p))
        if (priorityIndex === -1) continue

        // Check if model is healthy (not rate limited) - with account dimension
        if (!(await isModelAvailable(pid, modelID))) {
          continue
        }

        candidates.push({ providerId: pid, modelID, priorityIndex })
      }
    }

    // Sort by priority (lower index = higher priority)
    // Prefer the originally requested provider as tiebreaker
    candidates.sort((a, b) => {
      if (a.priorityIndex !== b.priorityIndex) {
        return a.priorityIndex - b.priorityIndex
      }
      // Prefer original provider
      if (a.providerId === providerId && b.providerId !== providerId) return -1
      if (b.providerId === providerId && a.providerId !== providerId) return 1
      return 0
    })

    // Return first healthy candidate
    if (candidates.length > 0) {
      const best = candidates[0]
      return getModel(best.providerId, best.modelID)
    }

    // Fallback: try opencode provider
    const opencodeProvider = providers["opencode"]
    if (opencodeProvider?.models?.["gpt-5-nano"]) {
      if (await isModelAvailable("opencode", "gpt-5-nano")) {
        return getModel("opencode", "gpt-5-nano")
      }
    }

    // Last resort: return any model from the original provider (even if rate limited)
    // This ensures we at least try something
    const originalProvider = providers[providerId]
    if (originalProvider) {
      for (const item of priority) {
        for (const model of Object.keys(originalProvider.models)) {
          if (model.includes(item)) {
            return getModel(providerId, model)
          }
        }
      }
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

  /**
   * Get the default model with subscription priority.
   *
   * Selection priority:
   * 1. Config-specified model
   * 2. Subscription-based accounts (opencode, anthropic OAuth, openai OAuth)
   * 3. API-key based accounts with best health score
   * 4. Fallback to any available provider
   */
  export async function defaultModel(): Promise<{ providerId: string; modelID: string }> {
    const cfg = await Config.get()
    if (cfg.model) return parseModel(cfg.model)

    // Try subscription-based selection first
    const subscriptionResult = await selectSubscriptionModel(cfg)
    if (subscriptionResult) return subscriptionResult

    // Fallback to original logic
    const provider = await list()
      .then((val) => Object.values(val))
      .then((x) => x.find((p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id)))
    if (!provider) throw new Error("no providers found")
    const [model] = sort(Object.values(provider.models))
    if (!model) throw new Error("no models found")
    return {
      providerId: provider.id,
      modelID: model.id,
    }
  }

  /**
   * Try to select a model from subscription-based accounts.
   * Returns undefined if no subscription accounts are available.
   */
  async function selectSubscriptionModel(
    cfg: Config.Info,
  ): Promise<{ providerId: string; modelID: string } | undefined> {
    const { getHealthTracker, getRateLimitTracker } = await import("../account/rotation")

    // Priority order for subscription providers
    const subscriptionPriority = ["opencode", "anthropic", "openai", "google-api", "github-copilot"]

    const healthTracker = getHealthTracker()
    const rateLimitTracker = getRateLimitTracker()
    const providers = await list()

    for (const family of subscriptionPriority) {
      // Skip if provider is disabled in config
      if (cfg.disabled_providers?.includes(family)) continue

      // Check if we have accounts for this family
      const accounts = await Account.list(family).catch(() => ({}))
      if (Object.keys(accounts).length === 0) continue

      // Find a healthy, non-rate-limited subscription account
      for (const [accountId, info] of Object.entries(accounts)) {
        // Only consider subscription/oauth accounts
        if (info.type !== "subscription" && (info.type as string) !== "oauth") continue

        // Check health and rate limit
        const healthScore = healthTracker.getScore(accountId)
        const isRateLimited = rateLimitTracker.isRateLimited(accountId, family)

        if (healthScore < 50 || isRateLimited) continue

        // Get the provider's default model
        const provider = providers[family]
        if (!provider?.models) continue

        const [model] = sort(Object.values(provider.models))
        if (!model) continue

        log.info("Selected subscription model", {
          provider: family,
          accountId,
          model: model.id,
          healthScore,
        })

        return {
          providerId: family,
          modelID: model.id,
        }
      }
    }

    return undefined
  }

  export function parseModel(model: string) {
    const [providerId, ...rest] = model.split("/")
    return {
      providerId: providerId,
      modelID: rest.join("/"),
    }
  }

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerId: z.string(),
      modelID: z.string(),
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerId: z.string(),
    }),
  )
}
