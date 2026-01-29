import { Auth } from "../../auth"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { ModelsDev } from "../../provider/models"
import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import os from "os"
import { Config } from "../../config/config"
import { Global } from "../../global"
import { Plugin } from "../../plugin"
import { Instance } from "../../project/instance"
import type { Hooks } from "@opencode-ai/plugin"

type PluginAuth = NonNullable<Hooks["auth"]>

/**
 * Handle plugin-based authentication flow.
 * Returns true if auth was handled, false if it should fall through to default handling.
 */
async function handlePluginAuth(plugin: { auth: PluginAuth }, provider: string): Promise<boolean> {
  let index = 0
  if (plugin.auth.methods.length > 1) {
    if (provider === "antigravity" || provider === "gemini-cli") {
      index = 0
    } else {
      const method = await prompts.select({
        message: "Login method",
        options: [
          ...plugin.auth.methods.map((x, index) => ({
            label: x.label,
            value: index.toString(),
          })),
        ],
      })
      if (prompts.isCancel(method)) throw new UI.CancelledError()
      index = parseInt(method)
    }
  }
  const method = plugin.auth.methods[index]

  // Handle prompts for all auth types
  await Bun.sleep(10)
  const inputs: Record<string, string> = {}
  if (method.prompts) {
    for (const prompt of method.prompts) {
      if (prompt.condition && !prompt.condition(inputs)) {
        continue
      }
      if (prompt.type === "select") {
        const value = await prompts.select({
          message: prompt.message,
          options: prompt.options,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      } else {
        const value = await prompts.text({
          message: prompt.message,
          placeholder: prompt.placeholder,
          validate: prompt.validate ? (v) => prompt.validate!(v ?? "") : undefined,
        })
        if (prompts.isCancel(value)) throw new UI.CancelledError()
        inputs[prompt.key] = value
      }
    }
  }

  if (method.type === "oauth") {
    const authorize = await method.authorize(inputs)

    if (authorize.url) {
      prompts.log.info("Go to: " + authorize.url)
    }

    if (authorize.method === "auto") {
      if (authorize.instructions) {
        prompts.log.info(authorize.instructions)
      }
      const spinner = prompts.spinner()
      spinner.start("Waiting for authorization...")
      const result = await authorize.callback()
      if (result.type === "failed") {
        spinner.stop("Failed to authorize", 1)
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          await Auth.set(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          await Auth.set(saveProvider, {
            type: "api",
            key: result.key,
          })
        }
        spinner.stop("Login successful")
      }
    }

    if (authorize.method === "code") {
      const code = await prompts.text({
        message: "Paste the authorization code here: ",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })
      if (prompts.isCancel(code)) throw new UI.CancelledError()
      const result = await authorize.callback(code)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          await Auth.set(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          await Auth.set(saveProvider, {
            type: "api",
            key: result.key,
          })
        }
        prompts.log.success("Login successful")
      }
    }

    prompts.outro("Done")
    return true
  }

  if (method.type === "api") {
    if (method.authorize) {
      const result = await method.authorize(inputs)
      if (result.type === "failed") {
        prompts.log.error("Failed to authorize")
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        await Auth.set(saveProvider, {
          type: "api",
          key: result.key,
        })
        prompts.log.success("Login successful")
      }
      prompts.outro("Done")
      return true
    }
  }

  return false
}

export const AuthCommand = cmd({
  command: "auth",
  describe: "manage credentials",
  builder: (yargs) =>
    yargs
      .command(AuthLoginCommand)
      .command(AuthLogoutCommand)
      .command(AuthListCommand)
      .command(AuthSwitchCommand)
      .demandCommand(),
  async handler() { },
})

export const AuthListCommand = cmd({
  command: "list [provider]",
  aliases: ["ls"],
  describe: "list providers",
  builder: (yargs) =>
    yargs.positional("provider", {
      type: "string",
      describe: "filter by provider (e.g., google, anthropic)",
    }),
  async handler(args) {
    UI.empty()
    const authPath = path.join(Global.Path.data, "auth.json")
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath

    // If provider filter specified, list accounts for that provider family
    if (args.provider) {
      const accounts = await Auth.listAccounts(args.provider)
      prompts.intro(`${args.provider} accounts`)

      for (const providerID of accounts) {
        const auth = await Auth.get(providerID)
        if (!auth) continue
        const isDefault = providerID === args.provider
        const marker = isDefault ? " (default)" : ""
        prompts.log.info(`${providerID}${marker} ${UI.Style.TEXT_DIM}${auth.type}`)
      }

      prompts.outro(`${accounts.length} account${accounts.length === 1 ? "" : "s"}`)
      return
    }

    // Otherwise, list all credentials
    prompts.intro(`Credentials ${UI.Style.TEXT_DIM}${displayPath}`)
    const results = Object.entries(await Auth.all())
    const database = await ModelsDev.get()

    for (const [providerID, result] of results) {
      const name = database[providerID]?.name || providerID
      prompts.log.info(`${name} ${UI.Style.TEXT_DIM}${result.type}`)
    }

    prompts.outro(`${results.length} credentials`)

    // Environment variables section
    const activeEnvVars: Array<{ provider: string; envVar: string }> = []

    for (const [providerID, provider] of Object.entries(database)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({
            provider: provider.name || providerID,
            envVar,
          })
        }
      }
    }

    if (activeEnvVars.length > 0) {
      UI.empty()
      prompts.intro("Environment")

      for (const { provider, envVar } of activeEnvVars) {
        prompts.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      prompts.outro(`${activeEnvVars.length} environment variable` + (activeEnvVars.length === 1 ? "" : "s"))
    }
  },
})

export const AuthLoginCommand = cmd({
  command: "login [url]",
  describe: "log in to a provider",
  builder: (yargs) =>
    yargs.positional("url", {
      describe: "opencode auth provider",
      type: "string",
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Add credential")
        if (args.url) {
          const wellknown = await fetch(`${args.url}/.well-known/opencode`).then((x) => x.json() as any)
          prompts.log.info(`Running \`${wellknown.auth.command.join(" ")}\``)
          const proc = Bun.spawn({
            cmd: wellknown.auth.command,
            stdout: "pipe",
          })
          const exit = await proc.exited
          if (exit !== 0) {
            prompts.log.error("Failed")
            prompts.outro("Done")
            return
          }
          const token = await new Response(proc.stdout).text()
          await Auth.set(args.url, {
            type: "wellknown",
            key: wellknown.auth.env,
            token: token.trim(),
          })
          prompts.log.success("Logged into " + args.url)
          prompts.outro("Done")
          return
        }
        await ModelsDev.refresh().catch(() => { })

        const config = await Config.get()

        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const providers = await ModelsDev.get().then((x) => {
          const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
          if (enabled && enabled.has("google")) {
            enabled.add("antigravity")
            enabled.add("gemini-cli")
          }

          const filtered: Record<string, (typeof x)[string]> = {}
          for (const [key, value] of Object.entries(x)) {
            if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
              filtered[key] = value
            }
          }

          // Force-include antigravity and gemini-cli if allowed
          if (!disabled.has("antigravity") && (enabled ? enabled.has("antigravity") : true) && !filtered["antigravity"]) {
            filtered["antigravity"] = { id: "antigravity", name: "Antigravity", env: [], models: {} }
          }
          if (!disabled.has("gemini-cli") && (enabled ? enabled.has("gemini-cli") : true) && !filtered["gemini-cli"]) {
            filtered["gemini-cli"] = { id: "gemini-cli", name: "Gemini CLI", env: ["GEMINI_API_KEY"], models: {} }
          }

          return filtered
        })

        const priority: Record<string, number> = {
          opencode: 0,
          anthropic: 1,
          "github-copilot": 2,
          openai: 3,
          antigravity: 4,
          "gemini-cli": 5,
          google: 6,
          openrouter: 7,
          vercel: 8,
        }
        let provider = await prompts.autocomplete({
          message: "Select provider",
          maxItems: 8,
          options: [
            ...pipe(
              providers,
              values(),
              sortBy(
                (x) => priority[x.id] ?? 99,
                (x) => x.name ?? x.id,
              ),
              map((x) => ({
                label: x.name,
                value: x.id,
                hint: {
                  opencode: "recommended",
                  anthropic: "Claude Max or API key",
                  openai: "ChatGPT Plus/Pro or API key",
                  antigravity: "Google Subscription (vibe/internal)",
                  "gemini-cli": "Google Subscription (CLI)",
                  google: "API Key only",
                }[x.id],
              })),
            ),
            {
              value: "other",
              label: "Other",
            },
          ],
        })

        if (prompts.isCancel(provider)) throw new UI.CancelledError()

        const plugin = await Plugin.list().then((x) => x.find((x) => x.auth?.provider === provider))
        let authMethod: "plugin" | "api" = "api"
        if (plugin && plugin.auth) {
          // Offer choice between plugin auth and direct API key
          authMethod = "plugin"
          if (provider !== "antigravity" && provider !== "gemini-cli") {
            const result = await prompts.select({
              message: "Authentication method",
              options: [
                { label: "Subscription (OAuth)", value: "plugin", hint: "via plugin" },
                { label: "API Key", value: "api", hint: "direct API key" },
              ],
            })
            if (prompts.isCancel(result)) throw new UI.CancelledError()
            authMethod = result
          }

          if (authMethod === "plugin") {
            const handled = await handlePluginAuth({ auth: plugin.auth }, provider)
            if (handled) return
          }
          // If "api" selected, fall through to API key prompt below
        }

        if (provider === "other") {
          provider = await prompts.text({
            message: "Enter provider id",
            validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : "a-z, 0-9 and hyphens only"),
          })
          if (prompts.isCancel(provider)) throw new UI.CancelledError()
          provider = provider.replace(/^@ai-sdk\//, "")
          if (prompts.isCancel(provider)) throw new UI.CancelledError()

          // Check if a plugin provides auth for this custom provider
          const customPlugin = await Plugin.list().then((x) => x.find((x) => x.auth?.provider === provider))
          if (customPlugin && customPlugin.auth) {
            const handled = await handlePluginAuth({ auth: customPlugin.auth }, provider)
            if (handled) return
          }

          prompts.log.warn(
            `This only stores a credential for ${provider} - you will need configure it in opencode.json, check the docs for examples.`,
          )
        }

        if (provider === "amazon-bedrock") {
          prompts.log.info(
            "Amazon Bedrock authentication priority:\n" +
            "  1. Bearer token (AWS_BEARER_TOKEN_BEDROCK or /connect)\n" +
            "  2. AWS credential chain (profile, access keys, IAM roles, EKS IRSA)\n\n" +
            "Configure via opencode.json options (profile, region, endpoint) or\n" +
            "AWS environment variables (AWS_PROFILE, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_WEB_IDENTITY_TOKEN_FILE).",
          )
        }

        if (provider === "opencode") {
          prompts.log.info("Create an api key at https://opencode.ai/auth")
        }

        if (provider === "vercel") {
          prompts.log.info("You can create an api key at https://vercel.link/ai-gateway-token")
        }

        if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
          prompts.log.info(
            "Cloudflare AI Gateway can be configured with CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN environment variables. Read more: https://opencode.ai/docs/providers/#cloudflare-ai-gateway",
          )
        }

        const accountSuffix = await (async () => {
          if (provider === "google" && authMethod === "api") {
            const suffix = await prompts.text({
              message: "Account name (lowercase, no spaces)",
              placeholder: "work, personal, project-x",
              validate: (x) => (x && /^[a-z0-9-]+$/.test(x)
                ? undefined
                : "Required. Use lowercase letters, numbers, and hyphens only"),
            })
            if (prompts.isCancel(suffix)) throw new UI.CancelledError()
            return suffix
          }
          return undefined
        })()

        if (accountSuffix) {
          provider = `${provider}-${accountSuffix}`
        }

        if (!accountSuffix) {
          // Multi-account support: ask if user wants to name this account
          const wantsAccountName = await prompts.confirm({
            message: "Name this account for multi-account support?",
            initialValue: false,
          })

          if (!prompts.isCancel(wantsAccountName) && wantsAccountName) {
            const suffix = await prompts.text({
              message: "Account name (lowercase, no spaces)",
              placeholder: "work, personal, project-x",
              validate: (x) => (x && /^[a-z0-9-]+$/.test(x) ? undefined : "Use lowercase letters, numbers, and hyphens only"),
            })
            if (!prompts.isCancel(suffix) && suffix) {
              provider = `${provider}-${suffix}`
            }
          }
        }

        const key = await prompts.password({
          message: "Enter your API key",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(key)) throw new UI.CancelledError()
        await Auth.set(provider, {
          type: "api",
          key,
        })

        prompts.outro("Done")
      },
    })
  },
})

export const AuthLogoutCommand = cmd({
  command: "logout",
  describe: "log out from a configured provider",
  async handler() {
    UI.empty()
    const credentials = await Auth.all().then((x) => Object.entries(x))
    prompts.intro("Remove credential")
    if (credentials.length === 0) {
      prompts.log.error("No credentials found")
      return
    }
    const database = await ModelsDev.get()
    const providerID = await prompts.select({
      message: "Select provider",
      options: credentials.map(([key, value]) => ({
        label: (database[key]?.name || key) + UI.Style.TEXT_DIM + " (" + value.type + ")",
        value: key,
      })),
    })
    if (prompts.isCancel(providerID)) throw new UI.CancelledError()
    await Auth.remove(providerID)
    prompts.outro("Logout successful")
  },
})

export const AuthSwitchCommand = cmd({
  command: "switch <provider> [account]",
  describe: "switch default account for a provider",
  builder: (yargs) =>
    yargs
      .positional("provider", {
        type: "string",
        demandOption: true,
        describe: "provider name (e.g., google, anthropic)",
      })
      .positional("account", {
        type: "string",
        describe: "account suffix (e.g., work, personal)",
      })
      .option("project", {
        type: "boolean",
        describe: "update project config instead of global",
        default: false,
      }),
  async handler(args) {
    UI.empty()
    const providerPrefix = args.provider
    const accountSuffix = args.account
    const fullProviderID = accountSuffix ? `${providerPrefix}-${accountSuffix}` : providerPrefix

    // Validate account exists
    if (!(await Auth.hasAccount(fullProviderID))) {
      const available = await Auth.listAccounts(providerPrefix)
      prompts.log.error(`Account ${fullProviderID} not found`)
      if (available.length > 0) {
        prompts.log.info(`Available: ${available.join(", ")}`)
      } else {
        prompts.log.info(`No accounts found for ${providerPrefix}. Run: opencode auth login`)
      }
      return
    }

    // Get current model or use default
    const config = await Config.get()
    const currentModel = config.model || "claude-sonnet-4-5"
    const [_, modelID] = currentModel.split("/")
    const newModel = modelID ? `${fullProviderID}/${modelID}` : fullProviderID

    // Update appropriate config
    if (args.project) {
      await Config.update({ model: newModel })
      prompts.log.success(`Project now using ${fullProviderID}`)
    } else {
      await Config.updateGlobal({ model: newModel })
      prompts.log.success(`Global default now using ${fullProviderID}`)
    }

    prompts.outro("Done")
  },
})
