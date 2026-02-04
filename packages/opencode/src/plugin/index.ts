import type { Hooks, PluginInput, Plugin as PluginInstance } from "@opencode-ai/plugin"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Server } from "../server/server"
import { BunProc } from "../bun"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { CodexAuthPlugin } from "./codex"
import { Session } from "../session"
import { NamedError } from "@opencode-ai/util/error"
import { CopilotAuthPlugin } from "./copilot"

import { AntigravityOAuthPlugin, AntigravityLegacyOAuthPlugin } from "./antigravity"
import { GeminiCLIOAuthPlugin } from "./gemini-cli"
import { AnthropicAuthPlugin } from "./anthropic"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  // GitLab auth still uses npm package
  const BUILTIN = ["@gitlab/opencode-gitlab-auth@1.3.2"]

  // Built-in plugins that are directly imported (not installed from npm)
  // AnthropicAuthPlugin is internal to use correct Claude Code headers for OAuth
  const INTERNAL_PLUGINS: { name: string; plugin: PluginInstance }[] = [
    { name: "codex", plugin: CodexAuthPlugin },
    { name: "copilot", plugin: CopilotAuthPlugin },
    { name: "antigravity", plugin: AntigravityOAuthPlugin as any },
    { name: "antigravity-legacy", plugin: AntigravityLegacyOAuthPlugin as any },
    { name: "gemini-cli", plugin: GeminiCLIOAuthPlugin as any },
    { name: "anthropic", plugin: AnthropicAuthPlugin as any },
  ]

  // Cached state
  const state = Instance.state(async (): Promise<{ hooks: Hooks[]; input: PluginInput }> => {
    const client = createOpencodeClient({
      baseUrl: "http://localhost:1080",
      // @ts-ignore - fetch type incompatibility
      fetch: async (...args) => Server.App().fetch(...args),
    })
    const config = await Config.get()
    const hooks: Hooks[] = []
    const input: PluginInput = {
      client,
      project: Instance.project,
      worktree: Instance.worktree,
      directory: Instance.directory,
      serverUrl: Server.url(),
      $: Bun.$,
    }

    for (const entry of INTERNAL_PLUGINS) {
      log.info("loading internal plugin", { name: entry.name })
      const init = await entry.plugin(input)
      ;(init as { __source?: string }).__source = `internal:${entry.name}`
      hooks.push(init)
    }

    const plugins = [...(config.plugin ?? [])]
    if (!Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS) {
      plugins.push(...BUILTIN)
    }

    for (let plugin of plugins) {
      // Skip plugins that are now handled internally
      if (
        plugin.includes("opencode-openai-codex-auth") ||
        plugin.includes("opencode-copilot-auth") ||
        plugin.includes("opencode-anthropic-auth")
      )
        continue
      log.info("loading plugin", { path: plugin })
      if (!plugin.startsWith("file://")) {
        const lastAtIndex = plugin.lastIndexOf("@")
        const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
        const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"
        const builtin = BUILTIN.some((x) => x.startsWith(pkg + "@"))
        plugin = await BunProc.install(pkg, version).catch((err) => {
          if (!builtin) throw err

          const message = err instanceof Error ? err.message : String(err)
          log.error("failed to install builtin plugin", {
            pkg,
            version,
            error: message,
          })
          Bus.publish(Session.Event.Error, {
            error: new NamedError.Unknown({
              message: `Failed to install built-in plugin ${pkg}@${version}: ${message}`,
            }).toObject(),
          })

          return ""
        })
        if (!plugin) continue
      }
      const mod = await import(plugin)
      // Prevent duplicate initialization when plugins export the same function
      // as both a named export and default export (e.g., `export const X` and `export default X`).
      // Object.entries(mod) would return both entries pointing to the same function reference.
      const seen = new Set<PluginInstance>()
      for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
        if (seen.has(fn)) continue
        seen.add(fn)
        const init = await fn(input)
        ;(init as { __source?: string }).__source = plugin
        hooks.push(init)
      }
    }

    return {
      hooks,
      input,
    }
  })

  export async function trigger<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(name: Name, input: Input, output: Output): Promise<Output> {
    if (!name) return output
    for (const hook of await state().then((x) => x.hooks)) {
      const fn = hook[name]
      if (!fn) continue
      // @ts-expect-error if you feel adventurous, please fix the typing, make sure to bump the try-counter if you
      // give up.
      // try-counter: 2
      await fn(input, output)
    }
    return output
  }

  export async function list() {
    return state().then((x) => x.hooks)
  }

  export async function discoverModels() {
    const hooks = await state().then((x) => x.hooks)
    const results: any[] = []
    for (const hook of hooks) {
      if ((hook as any).models) {
        try {
          const models = await (hook as any).models()
          if (Array.isArray(models)) {
            results.push(...models)
          }
        } catch (err) {
          log.error("failed to discover models from plugin", { error: err })
        }
      }
    }
    if (results.length > 0) {
      const { Provider } = await import("../provider/provider")
      await Provider.addDynamicModels(results)
    }
    return results
  }

  export async function getAuth(provider: string) {
    const hooks = await list()
    return hooks.find((h) => h.auth?.provider === provider)?.auth
  }

  export async function init() {
    const hooks = await state().then((x) => x.hooks)
    const config = await Config.get()
    for (const hook of hooks) {
      // @ts-expect-error this is because we haven't moved plugin to sdk v2
      await hook.config?.(config)
    }
    Bus.subscribeAll(async (input) => {
      const hooks = await state().then((x) => x.hooks)
      for (const hook of hooks) {
        hook["event"]?.({
          event: input,
        })
      }
    })
  }
}
