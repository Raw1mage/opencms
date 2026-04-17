import z from "zod"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "../util/log"
import { BunProc } from "../bun"
import { Plugin } from "../plugin"
import { ModelsDev } from "./models"
import { applyProviderModelCorrections } from "./model-curation"
import { ProviderAvailability } from "./availability"
import { NamedError } from "@opencode-ai/util/error"
import { Auth } from "../auth"
import { Account } from "../account"
import { getRateLimitTracker, getHealthTracker } from "../account/rotation"
import { Env } from "../env"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { Global } from "../global"
import { Installation } from "../installation"
import { debugCheckpoint } from "../util/debug"
import path from "path"
import { ProviderBillingMode } from "./billing-mode"

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
import type { Auth as SDKAuth } from "@opencode-ai/sdk"
import { ProviderTransform } from "./transform"
import { ToolCallBridgeManager } from "./toolcall-bridge"
import { CUSTOM_LOADERS as IMPORTED_CUSTOM_LOADERS } from "./custom-loaders-def"

export namespace Provider {
  const log = Log.create({ service: "provider" })

  function summarizeResponsesRequestBody(body: unknown) {
    if (!body || typeof body !== "object" || !("input" in body) || !Array.isArray(body.input)) return undefined
    const typeCounts: Record<string, number> = {}
    let idCount = 0
    let itemReferenceCount = 0
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue
      const key = "type" in item ? String(item.type) : "role" in item ? `role:${String(item.role)}` : "unknown"
      typeCounts[key] = (typeCounts[key] ?? 0) + 1
      if ("id" in item && typeof item.id === "string" && item.id.length > 0) idCount++
      if ("type" in item && item.type === "item_reference") itemReferenceCount++
    }
    return {
      store: "store" in body ? body.store === true : undefined,
      inputCount: body.input.length,
      idCount,
      itemReferenceCount,
      typeCounts,
    }
  }

  function summarizeErrorBody(body: string) {
    const compact = body.replace(/\s+/g, " ").trim()
    if (!compact) return undefined
    return compact.slice(0, 240)
  }

  const IGNORED_MODELS = new Set([
    "google/gemini-1.5-pro",
    "google/gemini-1.0-pro",
    "google/gemini-embedding-001",
    "google/text-embedding-004",
    "google/embedding-001",
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
    // Fast and lightweight
    { id: "gpt-5.4-mini", name: "GPT-5.4 mini", family: "openai", reasoning: true },
    { id: "gpt-5-mini", name: "GPT-5 mini", family: "openai", reasoning: true },
    { id: "grok-code-fast-1", name: "Grok Code Fast 1", family: "xai" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash", family: "gemini" },
    // Versatile and highly intelligent
    { id: "gpt-5.1", name: "GPT-5.1", family: "openai" },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", family: "claude" },
    { id: "gpt-5.2", name: "GPT-5.2", family: "openai" },
    { id: "gpt-4.1", name: "GPT-4.1", family: "openai" },
    { id: "gpt-4o", name: "GPT-4o", family: "openai" },
    // Most powerful at complex tasks
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", family: "gemini" },
    { id: "gpt-5.2-codex", name: "GPT-5.2-Codex", family: "openai", reasoning: true },
    { id: "gpt-5.3-codex", name: "GPT-5.3-Codex", family: "openai", reasoning: true },
    { id: "gpt-5.1-codex-max", name: "GPT-5.1-Codex-Max", family: "openai", reasoning: true },
    { id: "gemini-3-pro", name: "Gemini 3 Pro", family: "gemini" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", family: "gemini" },
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
        if (!baseURL) return null
        url = `${baseURL}/models`
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

      const normalizeModelEntry = (entry: unknown): { id: string; name: string } | null => {
        if (typeof entry === "string" && entry.trim().length > 0) {
          const id = entry.trim()
          return { id, name: id }
        }
        if (!entry || typeof entry !== "object") return null
        const idRaw = (entry as Record<string, unknown>).id
        if (typeof idRaw !== "string" || idRaw.trim().length === 0) return null
        const id = idRaw.trim()
        const nameRaw = (entry as Record<string, unknown>).name
        const name = typeof nameRaw === "string" && nameRaw.trim().length > 0 ? nameRaw.trim() : id
        return { id, name }
      }

      // Parse OpenAI-style /models response
      if (data.data && Array.isArray(data.data)) {
        const models = data.data
          .map(normalizeModelEntry)
          .filter((x: ReturnType<typeof normalizeModelEntry>): x is { id: string; name: string } => x !== null)
        return models.length > 0 ? models : null
      }

      // Parse simple array response
      if (Array.isArray(data)) {
        const models = data
          .map(normalizeModelEntry)
          .filter((x: ReturnType<typeof normalizeModelEntry>): x is { id: string; name: string } => x !== null)
        return models.length > 0 ? models : null
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
      family: model.family || "openai",
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
    // GitHub Copilot provider with custom OpenAI-compatible implementation
    // Type cast needed because OpenaiCompatibleProvider has a subset of SDK interface
    // We only use language model capabilities, not embeddings or image models
    "@ai-sdk/github-copilot": createGitHubCopilotOpenAICompatible as unknown as (options: any) => SDK,
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

      // AWS SDK and credential providers read from global process.env
      // Env.set() now updates both instance state and process.env for SDK compatibility
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

      if (!profile && !awsAccessKeyId && !awsBearerToken && !awsWebIdentityTokenFile && !containerCreds)
        return { autoload: false }

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
          // Models from models.dev may already include prefixes like us., eu., global., etc.
          const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]
          if (crossRegionPrefixes.some((prefix) => modelID.startsWith(prefix))) {
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
      // SAP AI Core SDK reads from global process.env
      // Env.set() now updates both instance state and process.env for SDK compatibility
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
    gmicloud: async (input) => {
      // @event_2026-02-06:gmicloud_provider
      log.info("gmicloud loader called", { inputId: input.id, inputKeys: Object.keys(input) })
      const apiKey = await (async () => {
        const envKey = Env.get("GMI_API_KEY")
        log.info("gmicloud env check", { hasEnvKey: !!envKey })
        if (envKey) return envKey
        const auth = await Auth.get(input.id)
        log.info("gmicloud auth check", {
          inputId: input.id,
          authType: auth?.type,
          hasKey: auth?.type === "api" ? "yes" : "no",
        })
        if (auth?.type === "api") return auth.key
        return undefined
      })()
      log.info("gmicloud loader result", { hasApiKey: !!apiKey, autoload: !!apiKey })
      return {
        autoload: !!apiKey,
        options: {
          baseURL: "https://api.gmi-serving.com/v1",
          apiKey: apiKey ?? "",
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
        reasoning: z.number().optional(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            reasoning: z.number().optional(),
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
      billingMode: ProviderBillingMode.optional(),
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
        reasoning: model.cost?.reasoning,
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
              reasoning: model.cost.context_over_200k.reasoning,
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

  // Use simple cache instead of Instance.state to avoid directory-key issues during reset
  let stateCache: ReturnType<typeof initState> | undefined
  const state = () => {
    if (!stateCache) stateCache = initState()
    return stateCache
  }
  state.reset = () => {
    stateCache = undefined
  }

  async function initState() {
    debugCheckpoint("provider", "state init start")
    using _ = log.time("state")
    const config = await Config.get()
    const modelsDev = await ModelsDev.get()
    debugCheckpoint("provider", "models.dev loaded", { providerCount: Object.keys(modelsDev).length })
    const database = mapValues(modelsDev, fromModelsDevProvider)

    // Remove legacy 'anthropic' provider entirely to prevent user confusion
    delete database["anthropic"]

    // Always replace github-copilot models with curated bundled defaults.
    // models.dev is NOT an official source; dynamic fetch is disabled for non-enterprise.
    {
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
        database["github-copilot"].models = copilotModels
      }
      log.info("Injected bundled github-copilot models", { count: Object.keys(copilotModels).length })
    }

    // @plans/config-restructure Phase 2: availability is now derived from
    // accounts.json; `disabled_providers` survives as the explicit operator
    // override ("I have accounts but do not want this to load"). Phase 3 will
    // move the override into providers.json.
    const availabilitySnapshot = await ProviderAvailability.snapshot()
    const disabled = availabilitySnapshot.overrideDisabled
    await loadIgnoredDynamic()

    function isProviderAllowed(providerId: string): boolean {
      // The old semantics: only `disabled_providers` (override) blocked a
      // provider. That is still the user-visible contract for providers the
      // operator can actually use (has accounts / declared in config.provider).
      // The "no-account → hide" derivation is layered on top separately, since
      // the existing code also uses isProviderAllowed as a per-account filter
      // where account presence is checked elsewhere.
      return !disabled.has(providerId)
    }

    const providers: { [providerId: string]: Info } = {}
    const languages = new Map<string, LanguageModelV2>()
    const modelLoaders: {
      [providerId: string]: CustomModelLoader
    } = {}
    // @event_20260319_daemonization Phase θ.2 — SDK cache with LRU eviction (MAX=50)
    const SDK_CACHE_MAX = 50
    const sdk = new Map<number, SDK>()
    function sdkSet(key: number, value: SDK) {
      if (sdk.has(key)) sdk.delete(key)
      sdk.set(key, value)
      if (sdk.size > SDK_CACHE_MAX) {
        const oldest = sdk.keys().next().value
        if (oldest !== undefined) sdk.delete(oldest)
      }
    }

    log.info("init")

    const configProviders = Object.entries(config.provider ?? {})

    function mergeProvider(providerId: string, provider: Partial<Info>) {
      const existing = providers[providerId]
      if (existing) {
        providers[providerId] = mergeDeep(existing, provider) as Info
        return
      }
      const match = database[providerId]
      if (!match) return
      providers[providerId] = mergeDeep(match, provider) as Info
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
            toolcall: provider.lite ? false : (model.tool_call ?? existingModel?.capabilities.toolcall ?? true),
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
    // SELF-BUILT PROVIDERS: gemini-cli and claude-cli
    // These providers are self-built and do NOT inherit from models.dev.
    // ============================================================

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

    // Initialize claude-cli provider (Official Protocol Mimicry)
    // Replacing the legacy 'anthropic' provider entirely.
    const claudeCliModels = [
      { id: "claude-3-haiku-20240307", name: "Claude Haiku 3", reasoning: false, context: 200000 },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: false, context: 200000 },
      { id: "claude-3-opus-20240229", name: "Claude Opus 3", reasoning: true, context: 200000 },
      { id: "claude-opus-4-5", name: "Claude Opus 4.5", reasoning: true, context: 200000 },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: true, context: 200000 },
      { id: "claude-3-5-sonnet-latest", name: "Claude Sonnet 4", reasoning: true, context: 200000 },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, context: 200000 },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true, context: 200000 },
    ]

    database["claude-cli"] = {
      id: "claude-cli",
      name: "claude-cli",
      source: "custom",
      env: ["ANTHROPIC_API_KEY"],
      options: {},
      models: {},
    }

    for (const m of claudeCliModels) {
      database["claude-cli"].models[m.id] = {
        id: m.id,
        name: m.name,
        providerId: "claude-cli",
        family: "claude",
        // Native LanguageModelV2 provider — no @ai-sdk/anthropic in call path.
        // Model is created by CUSTOM_LOADERS["claude-cli"].getModel()
        api: { id: m.id, url: "https://api.anthropic.com", npm: "@opencode-ai/claude-provider" },
        status: "active",
        capabilities: {
          temperature: true,
          reasoning: m.reasoning,
          attachment: true,
          interleaved: m.reasoning ? { field: "reasoning_content" } : false,
          input: { text: true, image: true, audio: false, video: false, pdf: true },
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

    // Initialize Codex Provider (native C transport)
    // @event_2026-03-28:codex_native_provider
    const codexModels = [
      { id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", reasoning: false },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", reasoning: true },
      { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", reasoning: true },
      { id: "gpt-5.2", name: "GPT-5.2", reasoning: true },
      { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max", reasoning: true },
      { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini", reasoning: false },
    ]

    database["codex"] = {
      id: "codex",
      name: "Codex",
      source: "custom",
      env: [],
      options: {},
      models: {},
    }

    for (const m of codexModels) {
      database["codex"].models[m.id] = {
        id: m.id,
        name: m.name,
        providerId: "codex",
        family: "openai",
        api: { id: m.id, url: "https://chatgpt.com/backend-api/codex", npm: "@opencode-ai/codex-provider" },
        status: "active",
        capabilities: {
          temperature: false,
          reasoning: m.reasoning,
          attachment: false,
          interleaved: false,
          input: { text: true, image: true, audio: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          toolcall: true,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 400000, output: 128000 },
        options: {},
        variants: {},
        headers: {},
        release_date: "2026-03-01",
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
        "deepseek-ai/DeepSeek-R1-0528": {
          id: "deepseek-ai/DeepSeek-R1-0528",
          name: "DeepSeek R1",
          providerId: "gmicloud",
          family: "deepseek",
          api: {
            id: "deepseek-ai/DeepSeek-R1-0528",
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
    // NOTE: Do NOT call mergeProvider("gmicloud") here.
    // gmicloud requires an API key; the custom loader at line ~1906 will merge it
    // only when autoload=true (i.e., GMI_API_KEY is set or auth is stored).

    // Ensure Gemini CLI provider is always available if populated
    // @event_2026-02-17: ensure gemini-cli inherits from google-api if missing from database
    if (!database["gemini-cli"] && (database["google-api"] || database["google"])) {
      const base = database["google-api"] || database["google"]
      database["gemini-cli"] = {
        ...base,
        id: "gemini-cli",
        name: "Gemini CLI",
        models: mapValues(base.models, (m) => ({ ...m, providerId: "gemini-cli" })),
      }
    }

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

    // Ensure claude-cli provider is available with bundled models
    if (database["claude-cli"]) {
      mergeProvider("claude-cli", { source: "custom" })
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

    // Inherit models for account/provider instances via canonical provider-key resolver.
    // This replaces legacy regex-based `provider-accountname` guessing.
    for (const [providerId, provider] of Object.entries(database)) {
      if (Object.keys(provider.models).length > 0) continue

      const resolveProviderKey = (Account as any).resolveProvider ?? (Account as any).resolveFamily
      const providerKey = await resolveProviderKey(providerId)
      if (!providerKey || providerKey === providerId) continue

      const baseProvider = database[providerKey]
      if (!baseProvider || Object.keys(baseProvider.models).length === 0) continue

      log.info("inheriting models", { from: providerKey, to: providerId })
      database[providerId] = {
        ...provider,
        name: provider.name || `${baseProvider.name} (${providerId.split("-").pop()})`,
        models: mapValues(baseProvider.models, (model) => ({
          ...model,
          providerId,
        })),
        env: baseProvider.env,
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
      } else if (provider.type === "oauth" || provider.type === "wellknown") {
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

        let effectiveId = accountId

        // Determined display name
        let displayName = Account.getDisplayName(accountId, accountInfo, family)

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
          // REMOVED: Anthropic subscription logic moved to AnthropicAuthPlugin
          // to ensure strict Claude Code protocol compliance.
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
                    contentCount: contents.length,
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
                              const functionCall = partObj.functionCall
                              const functionName =
                                functionCall && typeof functionCall === "object" && "name" in functionCall
                                  ? (functionCall as { name?: unknown }).name
                                  : undefined
                              debugCheckpoint("google-api", "Added thoughtSignature", {
                                functionName,
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

        // Whitelist of supported Google API models
        // @event_20260215_google_api_model_cleanup
        const GOOGLE_API_WHITELIST = new Set([
          "gemini-3-pro-preview",
          "gemini-3-flash-preview",
          "gemini-2.5-pro",
          "gemini-2.5-flash",
          "gemini-2.5-flash-lite",
          "gemini-2.0-pro",
          "gemini-2.0-flash",
          "gemini-2.0-flash-lite",
          "gemini-1.5-pro",
          "gemini-1.5-flash",
          "gemini-1.5-flash-8b",
          "gemini-1.5-pro-latest",
          "gemini-1.5-flash-latest",
        ])

        database[effectiveId] = {
          id: effectiveId,
          source: "custom",
          name: displayName,
          active: familyData.activeAccount === accountId,
          email: accountInfo.type === "subscription" ? accountInfo.email : undefined,
          coolingDownUntil: accountInfo.type === "subscription" ? accountInfo.coolingDownUntil : undefined,
          cooldownReason: blocked ?? (accountInfo.type === "subscription" ? accountInfo.cooldownReason : undefined),
          env: [],
          options: mergeDeep(baseProvider.options ?? {}, options) as Info["options"],
          models: pickBy(
            mapValues(baseProvider.models, (model) => ({
              ...model,
              providerId: effectiveId,
            })),
            (model, id) => {
              if (family === "google-api") return GOOGLE_API_WHITELIST.has(id) || id.startsWith("gemini-")
              return !isModelIgnored(effectiveId, id)
            },
          ),
        }

        mergeProvider(effectiveId, {
          source: "custom",
        })
      }
    }

    for (const plugin of await Plugin.list()) {
      if (!plugin.auth) continue
      const family = plugin.auth.provider
      if (disabled.has(family)) continue

      const loadAuth = async (providerId: string): Promise<SDKAuth> => {
        const auth = await Auth.get(providerId)
        if (!auth) {
          throw new Error(`Auth not found for provider: ${providerId}`)
        }
        return auth
      }

      // Check if auth exists at family level OR at any account level
      // FIX: Auth may be stored under account ID (e.g., "claude-cli-subscription-xxx")
      // rather than base family ID (e.g., "claude-cli")
      // @event_20260209_fix_model_activities_account_select
      let hasFamilyAuth = false
      const familyAuth = await Auth.get(family)
      if (familyAuth) hasFamilyAuth = true

      // Check account-level auth if no family-level auth
      if (!hasFamilyAuth) {
        const familyData = allFamilies[family]
        if (familyData) {
          for (const accountId of Object.keys(familyData.accounts)) {
            const accountAuth = await Auth.get(accountId)
            if (accountAuth) {
              hasFamilyAuth = true
              break
            }
          }
        }
      }

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
          const options = await plugin.auth.loader(() => loadAuth(family), providers[family])
          if (options) {
            // Extract getModel from auth loader result (native providers provide their own model factory)
            const { getModel, ...rest } = options as Record<string, any> & { getModel?: CustomModelLoader }
            if (getModel) {
              modelLoaders[family] = getModel
              log.info("auth loader provided getModel for family", { family })
            }
            providers[family].options = mergeDeep(providers[family].options, rest) as Info["options"]
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

          debugCheckpoint("provider", "account loader start", { family, accountId })
          const accountOptions = await plugin.auth.loader(() => loadAuth(accountId), providers[accountId])
          debugCheckpoint("provider", "account loader end", { family, accountId, hasResult: !!accountOptions })
          if (accountOptions) {
            const { getModel: acctGetModel, ...acctRest } = accountOptions as Record<string, any> & {
              getModel?: CustomModelLoader
            }
            // Account-level getModel not needed — accounts inherit from family's modelLoaders
            // via canonicalProviderId resolution in getLanguage(). Only merge options.
            providers[accountId].options = mergeDeep(providers[accountId].options, acctRest) as Info["options"]
          }
        })
        await Promise.all(accountLoaderPromises)

        // Inherit custom fetch from the active account only.
        // Never use object insertion order as an execution policy.
        if (providers[family] && !providers[family].options?.fetch) {
          const activeAccountId = familyData.activeAccount
          if (activeAccountId && providers[activeAccountId]?.options?.fetch) {
            log.info("inheriting custom fetch from active account to base provider", {
              family,
              accountId: activeAccountId,
            })
            providers[family].options = mergeDeep(providers[family].options, {
              fetch: providers[activeAccountId].options.fetch,
              apiKey: providers[activeAccountId].options.apiKey,
              // Auth credentials for native claude-cli provider
              ...(providers[activeAccountId].options.type && {
                type: providers[activeAccountId].options.type,
                refresh: providers[activeAccountId].options.refresh,
                access: providers[activeAccountId].options.access,
                expires: providers[activeAccountId].options.expires,
                orgID: providers[activeAccountId].options.orgID,
                email: providers[activeAccountId].options.email,
                accountId: providers[activeAccountId].options.accountId,
              }),
            }) as Info["options"]
          } else {
            log.warn("base provider fetch inheritance skipped: no active account fetch", {
              family,
              activeAccountId,
              accountCount: Object.keys(familyData.accounts).length,
            })
          }
        }
      }

      // Special handling for github-copilot-enterprise (legacy)
      if (family === "github-copilot") {
        const enterpriseProviderID = "github-copilot-enterprise"
        if (!disabled.has(enterpriseProviderID) && providers[enterpriseProviderID]) {
          const enterpriseAuth = await Auth.get(enterpriseProviderID)
          if (enterpriseAuth) {
            const enterpriseOptions = await plugin.auth.loader(
              () => loadAuth(enterpriseProviderID),
              providers[enterpriseProviderID],
            )
            if (enterpriseOptions) {
              providers[enterpriseProviderID].options = mergeDeep(
                providers[enterpriseProviderID].options,
                enterpriseOptions,
              ) as Info["options"]
            }
          }
        }

        // Dynamic model fetching for github-copilot
        // Try to fetch models from the API, fallback to bundled defaults
        const copilotProviders = [family, enterpriseProviderID].filter((id) => !disabled.has(id) && providers[id])

        for (const copilotID of copilotProviders) {
          // Non-enterprise github-copilot: use bundled defaults only.
          // models.dev and api.githubcopilot.com/models both return stale/versioned
          // variants that pollute the model list. Only enterprise benefits from dynamic fetch.
          if (copilotID === family) {
            log.info("Using bundled defaults only for github-copilot (no dynamic fetch)", {
              count: Object.keys(providers[copilotID]?.models || {}).length,
            })
            continue
          }

          // Enterprise: dynamic fetch to discover org-specific models
          const auth = await Auth.get(copilotID)
          if (!auth || auth.type !== "oauth") continue

          const token = auth.refresh || auth.access
          if (!token) continue

          const baseURL = auth.enterpriseUrl
            ? `https://copilot-api.${auth.enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
            : undefined

          debugCheckpoint("provider", "fetching dynamic models start", { copilotID, baseURL })
          const fetchedModels = await fetchProviderModels(copilotID, token, baseURL)
          debugCheckpoint("provider", "fetching dynamic models end", { copilotID, count: fetchedModels?.length })

          if (fetchedModels && fetchedModels.length > 0) {
            const fetchedIds = new Set<string>()
            for (const fm of fetchedModels) {
              if (fetchedIds.has(fm.id)) continue
              fetchedIds.add(fm.id)
              if (!providers[copilotID].models[fm.id]) {
                providers[copilotID].models[fm.id] = createCopilotModel(copilotID, fm)
              }
            }
            log.info("Enterprise copilot models from API", {
              providerId: copilotID,
              total: Object.keys(providers[copilotID].models).length,
            })
          } else {
            log.info("Using inherited models for enterprise provider", {
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

        if (providers[effectiveId]) {
          // Merge options, prioritizing account-specific options (from plugin loaders)
          providers[effectiveId].options = mergeDeep(
            baseProvider.options,
            providers[effectiveId].options ?? {},
          ) as Info["options"]
        }
      }
    }

    // Merge inline CUSTOM_LOADERS with imported ones (imported takes precedence)
    const mergedCustomLoaders = { ...CUSTOM_LOADERS, ...IMPORTED_CUSTOM_LOADERS }
    for (const [providerId, fn] of Object.entries(mergedCustomLoaders)) {
      if (disabled.has(providerId)) continue
      const data = database[providerId]
      if (!data) {
        log.error("Provider does not exist in model list " + providerId)
        continue
      }
      debugCheckpoint("provider", "custom loader start", { providerId })
      const result = await fn(data)
      debugCheckpoint("provider", "custom loader end", {
        providerId,
        autoload: result?.autoload,
        hasOptions: !!result?.options,
        optionKeys: result?.options ? Object.keys(result.options) : [],
        hasApiKeyInResult: !!result?.options?.apiKey,
        providerExistsInProviders: !!providers[providerId],
      })
      if (result && (result.autoload || providers[providerId])) {
        if (result.getModel) modelLoaders[providerId] = result.getModel
        const opts = result.options ?? {}
        const patch: Partial<Info> = providers[providerId] ? { options: opts } : { source: "custom", options: opts }
        debugCheckpoint("provider", "merging custom loader result", {
          providerId,
          patchKeys: Object.keys(patch),
          patchHasOptions: !!patch.options,
          patchOptionsKeys: patch.options ? Object.keys(patch.options) : [],
        })
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

    // @plans/provider-hotfix Phase 4 — auto-hidden set. disabled_providers is
    // now a soft gate: the provider entry stays in `providers` so explicit
    // `getModel(providerId, modelId)` calls resolve, but auto pickers and
    // `Provider.list()` filter it out. Mirrors the manual-pin-bypass
    // philosophy shipped in plans/manual-pin-bypass-preflight/.
    const autoHidden = new Set<string>()
    for (const [providerId, provider] of Object.entries(providers)) {
      debugCheckpoint("provider", "post-processing start", { providerId })

      const configProvider = config.provider?.[providerId]
      provider.models = applyProviderModelCorrections(providerId, provider.models)

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

      // @plans/provider-hotfix Phase 4 — mark disabled providers as auto-hidden
      // AFTER curation, so explicit getModel still resolves to the fully
      // processed entry. AGENTS.md 第一條: log once per marking decision.
      if (!isProviderAllowed(providerId)) {
        autoHidden.add(providerId)
        log.info("provider auto-hidden (disabled_providers override); explicit getModel still resolves", {
          providerId,
          modelCount: Object.keys(provider.models).length,
        })
      }

      debugCheckpoint("provider", "post-processing end", { providerId })
      log.info("found", { providerId })
    }

    return {
      models: languages,
      providers,
      autoHidden,
      sdk,
      sdkSet,
      modelLoaders,
    }
  }

  export async function list() {
    await state() // Ensure plugins and loaders are initialized

    const { Plugin } = await import("../plugin")
    // Wait for model discovery so that the first call (e.g. during TUI boot)
    // actually has the models from plugins.
    await Plugin.discoverModels().catch((err) => {
      log.error("model discovery failed", { error: err })
    })

    // @plans/provider-hotfix Phase 4 — auto-hidden providers (those in
    // disabled_providers) are filtered out of the catalog surface so
    // TUI / CLI / REST iterators continue to see only active providers.
    // Explicit callers use `getModel(providerId, modelId)` which reads
    // `state().providers[id]` directly and bypasses this filter by design.
    const s = await state()
    if (s.autoHidden.size === 0) return s.providers
    const visible: Record<string, Info> = {}
    for (const [id, provider] of Object.entries(s.providers)) {
      if (!s.autoHidden.has(id)) visible[id] = provider
    }
    return visible
  }

  /**
   * @plans/provider-hotfix Phase 4 — internal accessor returning ALL
   * providers including auto-hidden ones. Used by callers that need to
   * explicitly target a disabled-but-pinned provider (e.g. UI tooltips
   * showing "disabled via disabled_providers" state).
   */
  export async function listAllIncludingHidden() {
    await state()
    return state().then((s) => s.providers)
  }

  export function reset() {
    state.reset()
    log.info("provider state reset")
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

      debugCheckpoint("provider", "getSDK start", {
        providerId: model.providerId,
        modelID: model.id,
        hasProvider: !!provider,
        providerSource: provider?.source,
        hasProviderKey: !!provider?.key,
        optionsApiKey: options.apiKey ? `exists (${options.apiKey.substring(0, 10)}...)` : "missing",
        optionKeys: Object.keys(options),
        baseURL: options.baseURL,
      })
      log.info("getSDK debug", {
        providerId: model.providerId,
        modelID: model.id,
        hasProviderKey: !!provider.key,
        optionsApiKey: options.apiKey ? "exists" : "missing",
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

      // FIX: Include hasCustomFetch in cache key since JSON.stringify ignores functions
      // Without this, SDKs with/without custom fetch would share the same cache key
      // @event_20260209_sdk_cache_key_fix
      const hasCustomFetch = typeof options["fetch"] === "function"
      const key = Bun.hash.xxHash32(
        JSON.stringify({ providerId: model.providerId, npm: model.api.npm, options, hasCustomFetch }),
      )
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
        let responsesRequestBefore: ReturnType<typeof summarizeResponsesRequestBody> | undefined
        let responsesRequestAfter: ReturnType<typeof summarizeResponsesRequestBody> | undefined

        // Merge configured headers into request headers
        opts.headers = {
          ...(typeof opts.headers === "object" ? opts.headers : {}),
          ...options["headers"],
        }

        // Normalize Authorization header casing: AI SDK auto-generates lowercase "authorization"
        // from apiKey. Promote it to uppercase "Authorization" so config-supplied headers
        // (which use uppercase) always win and servers never see duplicate Authorization entries.
        const hdrs = opts.headers as Record<string, string>
        if (hdrs["authorization"] && !hdrs["Authorization"]) {
          hdrs["Authorization"] = hdrs["authorization"]
          delete hdrs["authorization"]
        } else if (hdrs["authorization"] && hdrs["Authorization"]) {
          delete hdrs["authorization"]
        }

        debugCheckpoint("provider-fetch", "final request headers", {
          providerId: wrappedProviderID,
          modelID: wrappedModelID,
          authorization: (opts.headers as Record<string, string>)?.["Authorization"]?.substring(0, 40) ?? "(none)",
          authorizationLower: (opts.headers as Record<string, string>)?.["authorization"]?.substring(0, 40) ?? "(none)",
          allHeaderKeys: Object.keys(opts.headers ?? {}),
          configuredHeadersKeys: Object.keys(options["headers"] ?? {}),
          hasXAccountId: !!(opts.headers as Record<string, string>)?.["x-opencode-account-id"],
          url: inputUrl,
        })

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
          try {
            const body = JSON.parse(opts.body as string)
            responsesRequestBefore = summarizeResponsesRequestBody(body)
            const isAzure = model.providerId.includes("azure")
            const keepIds = isAzure && body.store === true
            if (!keepIds && Array.isArray(body.input)) {
              for (const item of body.input) {
                if ("id" in item) {
                  delete item.id
                }
              }
              responsesRequestAfter = summarizeResponsesRequestBody(body)
              opts.body = JSON.stringify(body)
            }
            debugCheckpoint("provider-fetch", "responses request scrub summary", {
              providerId: wrappedProviderID,
              modelID: wrappedModelID,
              isAzure,
              keepIds,
              before: responsesRequestBefore,
              after: responsesRequestAfter ?? responsesRequestBefore,
            })
          } catch {
            // If parsing fails, proceed with original body
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

        const requestInit: RequestInit & { timeout?: false } = {
          ...opts,
          timeout: false,
        }
        const response = await fetchFn(input, requestInit)

        if (!response.ok) {
          const errorSummary = await response
            .clone()
            .text()
            .then((body: string) => summarizeErrorBody(body))
            .catch(() => undefined)
          debugCheckpoint("provider-fetch", "responses error response", {
            providerId: wrappedProviderID,
            modelID: wrappedModelID,
            url: inputUrl,
            status: response.status,
            request: responsesRequestAfter ?? responsesRequestBefore,
            errorSummary,
          })
          return response
        }

        const stream = (() => {
          if (!opts?.body || typeof opts.body !== "string") return false
          try {
            const parsed = JSON.parse(opts.body)
            return parsed?.stream === true
          } catch {
            return false
          }
        })()
        const providerFamily = await Account.resolveFamilyOrSelf(wrappedProviderID)
        const bridge = ToolCallBridgeManager.resolve({
          providerId: wrappedProviderID,
          providerFamily,
          modelId: wrappedModelID,
          inputUrl,
          stream,
        })
        if (!bridge) return response
        debugCheckpoint("toolcall-bridge", "candidate-response", {
          bridgeId: bridge.id,
          providerId: wrappedProviderID,
          providerFamily,
          modelID: wrappedModelID,
          inputUrl,
          stream,
          status: response.status,
        })

        const raw = await response
          .clone()
          .text()
          .catch(() => "")
        if (!raw) {
          return response
        }

        const rewritten = ToolCallBridgeManager.rewrite(raw, {
          providerId: wrappedProviderID,
          providerFamily,
          modelId: wrappedModelID,
          inputUrl,
          stream,
        })
        if (!rewritten) {
          debugCheckpoint("toolcall-bridge", "no-rewrite", {
            bridgeId: bridge.id,
            providerId: wrappedProviderID,
            modelID: wrappedModelID,
            stream,
            rawLength: raw.length,
          })
          return response
        }
        debugCheckpoint("toolcall-bridge", "rewritten", {
          bridgeId: rewritten.bridgeId,
          providerId: wrappedProviderID,
          modelID: wrappedModelID,
          stream,
          rawLength: raw.length,
          rewrittenLength: rewritten.payload.length,
        })

        const headers = new Headers(response.headers)
        headers.delete("content-length")

        return new Response(rewritten.payload, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      }

      // Filter out model-level options that shouldn't be passed to SDK constructor
      // These options are meant for request/model configuration, not provider initialization
      // @event_2026-02-17: Fix AI_InvalidArgumentError for openai provider
      const MODEL_LEVEL_OPTIONS = [
        "reasoningEffort",
        "reasoningSummary",
        "textVerbosity",
        "include",
        "store",
        "thinkingConfig",
      ]
      const sdkOptions = { ...options }
      for (const key of MODEL_LEVEL_OPTIONS) {
        delete sdkOptions[key]
      }

      // Special case: google-vertex-anthropic uses a subpath import
      const bundledKey =
        model.providerId === "google-vertex-anthropic" ? "@ai-sdk/google-vertex/anthropic" : model.api.npm
      const bundledFn = BUNDLED_PROVIDERS[bundledKey]
      if (bundledFn) {
        log.info("using bundled provider", { providerId: model.providerId, pkg: bundledKey })
        const loaded = bundledFn({
          name: model.providerId,
          ...sdkOptions,
        })
        s.sdkSet(key, loaded)
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
        ...sdkOptions,
      })
      s.sdkSet(key, loaded)
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

    // @plans/provider-hotfix Phase 4 — make explicit use of an auto-hidden
    // provider observable so operators can see why a "disabled" provider is
    // still responding to requests (AGENTS.md 第一條).
    if (s.autoHidden.has(providerId)) {
      log.info("explicit getModel on auto-hidden provider (bypassing disabled_providers gate)", {
        providerId,
        modelID,
      })
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

  export async function resolveExecutionModel(input: { model: Model; accountId?: string }) {
    if (!input.accountId) return input.model
    const accountProviderId = input.accountId
    const parseAccountProvider =
      (Account as any).parseProvider ??
      (Account as any).parseFamily ??
      ((accountId: string) => accountId.split(/-(?:api|subscription)-/)[0])
    const accountFamily = parseAccountProvider(accountProviderId)
    const resolveFamily =
      (Account as any).resolveFamilyOrSelf ??
      (Account as any).resolveFamily ??
      (async (providerId: string) => providerId)
    const modelFamily = await resolveFamily(input.model.providerId)
    if (!accountFamily || accountFamily !== modelFamily) return input.model
    const provider = await getProvider(accountProviderId)
    if (!provider) return input.model
    const resolved = await getModel(accountProviderId, input.model.id).catch(() => undefined)
    return resolved ?? { ...input.model, providerId: accountProviderId }
  }

  export async function getLanguage(model: Model): Promise<LanguageModelV2> {
    const s = await state()
    const key = `${model.providerId}/${model.id}`
    if (s.models.has(key)) return s.models.get(key)!

    const provider = s.providers[model.providerId]

    // Resolve model loader by base provider ID.
    // Account-specific providerId (e.g. "codex-subscription-...") must resolve
    // to the canonical provider ("codex") that registered the CUSTOM_LOADER.
    const canonicalProviderId = Account.parseProvider(model.providerId) ?? model.providerId
    const loader = s.modelLoaders[canonicalProviderId]

    // Skip SDK loading when the model loader doesn't need it (e.g. native LMv2 providers).
    // This prevents InitError from getSDK() trying to install a non-existent npm package.
    const sdk = loader ? await getSDK(model).catch(() => null) : await getSDK(model)

    try {
      const language = loader ? await loader(sdk, model.api.id, provider.options) : sdk!.languageModel(model.api.id)
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

  /**
   * Peek at a cached LanguageModelV2 without creating a new instance.
   * Returns undefined if the model hasn't been instantiated yet.
   * Used by preconnect to avoid creating duplicate instances.
   */
  export async function peekCachedLanguage(providerId: string, modelID: string): Promise<LanguageModelV2 | undefined> {
    const s = await state()
    return s.models.get(`${providerId}/${modelID}`)
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
   *
   * @event_2026-02-15:fix_is_model_available
   * Previously only checked the ACTIVE account. If the active account was rate limited,
   * the model was declared unavailable even if other accounts were healthy.
   * Now checks ALL accounts in the family. Returns true if ANY account is usable.
   */
  async function isModelAvailable(pid: string, modelID: string): Promise<boolean> {
    const family = await Account.resolveFamily(pid)
    if (!family) return true // No family = no account tracking, assume available

    // Get all accounts for this family
    const accounts = await Account.list(family).catch(() => ({}))
    const accountIds = Object.keys(accounts)

    if (accountIds.length === 0) return true // No accounts found, assume default/env auth is okay

    const tracker = getRateLimitTracker()
    const healthTracker = getHealthTracker() // Also check health score

    // Check if ANY account is available
    // An account is available if:
    // 1. It is NOT rate limited for this model
    // 2. AND it is NOT rate limited for the provider
    // 3. AND it has a usable health score
    for (const accountId of accountIds) {
      const isRateLimited = tracker.isRateLimited(accountId, pid, modelID)
      const isUsable = healthTracker.isUsable(accountId, pid)

      if (!isRateLimited && isUsable) {
        return true
      }
    }

    // If we reached here, ALL accounts are either rate limited or unhealthy
    return false
  }

  export async function getSmallModel(providerId: string) {
    const cfg = await Config.get()
    log.debug("getSmallModel called", { providerId, configSmallModel: cfg.small_model })

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
      log.debug("getSmallModel selected", {
        requested: providerId,
        selected: best.providerId,
        modelID: best.modelID,
        candidateCount: candidates.length,
        allCandidates: candidates.map((c) => `${c.providerId}:${c.modelID}`).slice(0, 5),
      })
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
  export async function defaultModel(): Promise<{ providerId: string; modelID: string; accountId?: string }> {
    const cfg = await Config.get()
    if (cfg.model) return parseModel(cfg.model)

    const providers = await list()
    const recent = (await Bun.file(path.join(Global.Path.state, "model.json"))
      .json()
      .then((x) => (Array.isArray(x.recent) ? x.recent : []))
      .catch(() => [])) as { providerID: string; modelID: string }[]
    for (const entry of recent) {
      const provider = providers[entry.providerID]
      if (!provider) continue
      if (!provider.models[entry.modelID]) continue
      return { providerId: entry.providerID, modelID: entry.modelID }
    }

    // Try subscription-based selection first
    const subscriptionResult = await selectSubscriptionModel(cfg)
    if (subscriptionResult) return subscriptionResult

    const provider = Object.values(providers).find((p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id))
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
  ): Promise<{ providerId: string; modelID: string; accountId?: string } | undefined> {
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
        const healthScore = healthTracker.getScore(accountId, family)
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
          accountId,
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
