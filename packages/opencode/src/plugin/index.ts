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
import { CodexNativeAuthPlugin } from "./codex-auth"
import { Session } from "../session"
import { NamedError } from "@opencode-ai/util/error"
import { CopilotAuthPlugin } from "./copilot"
import GitlabAuthPlugin from "@gitlab/opencode-gitlab-auth"

import { GeminiCLIOAuthPlugin } from "./gemini-cli"
import { ClaudeNativeAuthPlugin } from "./claude-native"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })

  async function getInternalPlugins(_config: { disabled_providers?: string[] }) {
    // Built-in plugins that are directly imported (not installed from npm)
    // AnthropicAuthPlugin is internal to use correct Claude Code headers for OAuth
    const internalPlugins: { name: string; plugin: PluginInstance }[] = [
      { name: "codex", plugin: CodexAuthPlugin },
      { name: "codex-native", plugin: CodexNativeAuthPlugin },
      { name: "copilot", plugin: CopilotAuthPlugin },
      { name: "gitlab", plugin: GitlabAuthPlugin },
      { name: "gemini-cli", plugin: GeminiCLIOAuthPlugin as PluginInstance },
      { name: "claude-cli", plugin: ClaudeNativeAuthPlugin },
    ]
    return internalPlugins
  }

  // Cached state
  async function createState(): Promise<{ hooks: Hooks[]; input: PluginInput }> {
    const client = createOpencodeClient({
      baseUrl: "http://localhost:1080",
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        return Server.App().fetch(request)
      }) as typeof fetch,
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

    for (const entry of await getInternalPlugins(config)) {
      log.info("loading internal plugin", { name: entry.name })
      const init = await entry.plugin(input).catch((err) => {
        log.error("failed to load internal plugin", { name: entry.name, error: err })
      })
      if (!init) continue
      ;(init as { __source?: string }).__source = `internal:${entry.name}`
      hooks.push(init)
    }

    const plugins = [...(config.plugin ?? [])]
    if (plugins.length) await Config.waitForDependencies()

    for (let plugin of plugins) {
      // Skip plugins that are now handled internally
      if (
        plugin.includes("opencode-openai-codex-auth") ||
        plugin.includes("opencode-copilot-auth") ||
        plugin.includes("opencode-anthropic-auth") ||
        plugin.includes("opencode-gitlab-auth") ||
        plugin.includes("opencode-gemini-auth")
      )
        continue
      log.info("loading plugin", { path: plugin })
      if (!plugin.startsWith("file://")) {
        const lastAtIndex = plugin.lastIndexOf("@")
        const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
        const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"
        plugin = await BunProc.install(pkg, version).catch((err) => {
          const cause = err instanceof Error ? err.cause : err
          const message = cause instanceof Error ? cause.message : String(cause ?? err)
          log.error("failed to install plugin", {
            pkg,
            version,
            error: message,
          })
          Bus.publish(Session.Event.Error, {
            error: new NamedError.Unknown({
              message: `Failed to install plugin ${pkg}@${version}: ${message}`,
            }).toObject(),
          })

          return ""
        })
        if (!plugin) continue
      }
      await import(plugin)
        .then(async (mod) => {
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
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          log.error("failed to load plugin", { path: plugin, error: message })
          Bus.publish(Session.Event.Error, {
            error: new NamedError.Unknown({
              message: `Failed to load plugin ${plugin}: ${message}`,
            }).toObject(),
          })
        })
    }

    return {
      hooks,
      input,
    }
  }

  let stateGetter: (() => Promise<Awaited<ReturnType<typeof createState>>>) | undefined
  let fallbackState: Promise<Awaited<ReturnType<typeof createState>>> | undefined

  function state() {
    if (typeof Instance.state === "function") {
      stateGetter ||= Instance.state(createState)
      return stateGetter()
    }

    fallbackState ||= createState()
    return fallbackState
  }

  export async function trigger<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(name: Name, input: Input, output: Output): Promise<Output> {
    if (!name) return output
    for (const hook of await state().then((x) => x.hooks)) {
      const fn = hook[name]
      if (!fn) continue
      await (fn as (input: Input, output: Output) => Promise<void>)(input, output)
    }
    return output
  }

  export async function list() {
    return state().then((x) => x.hooks)
  }

  export async function discoverModels() {
    const hooks = await state().then((x) => x.hooks)
    const results: any[] = []
    type HookWithModels = Hooks & { models?: () => Promise<unknown> }
    for (const hook of hooks) {
      const modelHook = hook as HookWithModels
      if (modelHook.models) {
        try {
          const models = await modelHook.models()
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
      if (hook.config) {
        await (hook.config as (input: typeof config) => Promise<void>)(config)
      }
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
