import type {
  Event,
  createOpencodeClient,
  Project,
  Model,
  Provider,
  Permission,
  UserMessage,
  Message,
  Part,
  Auth,
  Config,
} from "@opencode-ai/sdk"

import type { BunShell } from "./shell"
import { type ToolDefinition } from "./tool"

export * from "./tool"

export type ProviderContext = {
  source: "env" | "config" | "custom" | "api"
  info: Provider
  options: Record<string, any>
}

export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>
  project: Project
  directory: string
  worktree: string
  serverUrl: URL
  $: BunShell
}

export type Plugin = (input: PluginInput) => Promise<Hooks>

/**
 * Model factory function returned by auth loader.
 * When provided, core uses this to create LanguageModelV2 instances
 * instead of requiring a CUSTOM_LOADER entry.
 *
 * @param sdk - The AI SDK provider instance (may be null for native providers)
 * @param modelID - The model ID to instantiate
 * @param options - Merged provider options (credentials + config)
 */
export type AuthModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>

export type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any> & { getModel?: AuthModelLoader }>
  methods: (
    | {
        type: "oauth"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              condition?: (inputs: Record<string, string>) => boolean
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              condition?: (inputs: Record<string, string>) => boolean
            }
        >
        authorize(inputs?: Record<string, string>): Promise<AuthOuathResult>
      }
    | {
        type: "api"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              condition?: (inputs: Record<string, string>) => boolean
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              condition?: (inputs: Record<string, string>) => boolean
            }
        >
        authorize?(inputs?: Record<string, string>): Promise<
          | {
              type: "success"
              key: string
              provider?: string
            }
          | {
              type: "failed"
            }
        >
      }
  )[]
}

/**
 * Standard identity fields that plugins SHOULD return after OAuth.
 * At least one of email/username should be provided to enable multi-account support.
 * If neither is provided, the account ID will fall back to a token hash (unique but opaque).
 */
export interface AuthIdentity {
  /** User's email address (preferred for account ID generation) */
  email?: string
  /** User's username/login (fallback when email is unavailable, e.g. GitHub) */
  username?: string
}

export type AuthOuathResult = { url: string; instructions: string } & (
  | {
      method: "auto"
      callback(): Promise<
        | ({
            type: "success"
            provider?: string
          } & AuthIdentity &
            (
              | {
                  refresh: string
                  access: string
                  expires: number
                  accountId?: string
                }
              | { key: string }
            ))
        | {
            type: "failed"
          }
      >
    }
  | {
      method: "code"
      callback(code: string): Promise<
        | ({
            type: "success"
            provider?: string
          } & AuthIdentity &
            (
              | {
                  refresh: string
                  access: string
                  expires: number
                  accountId?: string
                }
              | { key: string }
            ))
        | {
            type: "failed"
          }
      >
    }
)

export interface Hooks {
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: {
    [key: string]: ToolDefinition
  }
  auth?: AuthHook
  /**
   * Called when a new message is received
   */
  "chat.message"?: (
    input: {
      sessionID: string
      agent?: string
      model?: { providerId: string; modelID: string }
      messageID?: string
      variant?: string
    },
    output: { message: UserMessage; parts: Part[] },
  ) => Promise<void>
  /**
   * Modify parameters sent to LLM
   */
  "chat.params"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: { temperature: number; topP: number; topK: number; options: Record<string, any> },
  ) => Promise<void>
  "chat.headers"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: { headers: Record<string, string> },
  ) => Promise<void>
  "permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>
  "command.execute.before"?: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Part[] },
  ) => Promise<void>
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any },
  ) => Promise<void>
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: {
      title: string
      output: string
      metadata: any
    },
  ) => Promise<void>
  "experimental.chat.messages.transform"?: (
    input: {},
    output: {
      messages: {
        info: Message
        parts: Part[]
      }[]
    },
  ) => Promise<void>
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: Model },
    output: {
      system: string[]
    },
  ) => Promise<void>
  /**
   * Phase B (specs/prompt-cache-and-compaction-hardening DD-11). Called after
   * the user-role context preface has been assembled but before the outbound
   * messages list is finalized. Plugins can mutate any of the preface fields:
   *
   * - `t1.readmeSummary` / `t1.cwdListing` / `t1.pinnedSkills` / `t1.todaysDate`
   * - `t2.activeSkills` / `t2.summarizedSkills`
   * - `trailingExtras` (per-turn dynamic content)
   *
   * Migration note (one release of compatibility): plugins that previously
   * injected dynamic content via `experimental.chat.system.transform` should
   * migrate to this hook. Old hook now receives only the static system block;
   * dynamic injection there is logged with a deprecation warning and will be
   * silent-dropped one release later.
   */
  "experimental.chat.context.transform"?: (
    input: { sessionID: string; model: Model },
    output: {
      preface: {
        t1: {
          readmeSummary: string
          cwdListing: string
          pinnedSkills: Array<{ name: string; state: "pinned"; content: string }>
          todaysDate: string
        }
        t2: {
          activeSkills: Array<{ name: string; state: "active"; content: string }>
          summarizedSkills: Array<{ name: string; state: "summary"; content: string }>
        }
      }
      trailingExtras: string[]
    },
  ) => Promise<void>
  /**
   * Called before session compaction starts. Allows plugins to customize
   * the compaction prompt.
   *
   * - `context`: Additional context strings appended to the default prompt
   * - `prompt`: If set, replaces the default compaction prompt entirely
   */
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>
  /**
   * Called when session needs compaction. Allows provider plugins to handle
   * compaction server-side (e.g. Codex /responses/compact endpoint).
   *
   * - If plugin sets `compactedItems` to a non-null array, core uses those items
   *   as the canonical next context window and skips LLM-based compaction.
   * - If `compactedItems` remains null, core falls through to default LLM compaction.
   * - `summary` should be a human-readable text for the SharedContext marker.
   */
  "session.compact"?: (
    input: {
      sessionID: string
      model: { providerId: string; modelID: string; accountId?: string }
      conversationItems: unknown[]
      instructions: string
    },
    output: {
      compactedItems: unknown[] | null
      summary: string | null
    },
  ) => Promise<void>
  "experimental.text.complete"?: (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => Promise<void>
  /**
   * Modify tool definitions (description and parameters) sent to LLM
   */
  "tool.definition"?: (input: { toolID: string }, output: { description: string; parameters: any }) => Promise<void>
  "shell.env"?: (input: { cwd: string }, output: { env: Record<string, string> }) => Promise<void>
}
