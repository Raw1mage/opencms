import type {
  Agent,
  Command,
  Config,
  FileDiff,
  LspStatus,
  McpStatus,
  Message,
  Part,
  Path,
  PermissionRequest,
  Project,
  ProviderListResponse,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
  VcsInfo,
} from "@opencode-ai/sdk/v2/client"
import type { Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

export type State = {
  status: "loading" | "partial" | "complete"
  agent: Agent[]
  command: Command[]
  project: string
  workspace:
    | {
        workspaceId: string
        projectId: string
        directory: string
        kind: "root" | "sandbox" | "derived"
        origin: "local" | "generated" | "imported"
        lifecycleState: "active" | "archived" | "resetting" | "deleting" | "failed"
        displayName?: string
        branch?: string
        attachments: {
          sessionIds: string[]
          activeSessionId?: string
          ptyIds: string[]
          previewIds: string[]
          workerIds: string[]
          draftKeys: string[]
          fileTabKeys: string[]
          commentKeys: string[]
        }
      }
    | undefined
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider: ProviderListResponse
  config: Config
  path: Path
  session: Session[]
  sessionTotal: number
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  todo: {
    [sessionID: string]: Todo[]
  }
  permission: {
    [sessionID: string]: PermissionRequest[]
  }
  question: {
    [sessionID: string]: QuestionRequest[]
  }
  mcp: {
    [name: string]: McpStatus
  }
  killswitch_status:
    | {
        active: boolean
        state: string
        requestID?: string
        initiator?: string
        reason?: string
        snapshotURL?: string | null
      }
    | undefined
  llm_errors: LlmErrorEntry[]
  llm_history: LlmHistoryEntry[]
  lsp: LspStatus[]
  vcs: VcsInfo | undefined
  limit: number
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
}

export type LlmErrorEntry = {
  providerId: string
  accountId: string
  modelId: string
  sessionID?: string
  status?: number
  message: string
  timestamp: number
  /** "ratelimit" | "auth_failed" | "error" */
  type: string
  reason?: string
  backoffMs?: number
}

export type LlmHistoryEntry = {
  providerId: string
  modelId: string
  timestamp: number
  /** "error" | "ratelimit" | "auth_failed" | "recovered" */
  state: string
  message?: string
}

export const LLM_HISTORY_CAP = 5

export type VcsCache = {
  store: Store<{ value: VcsInfo | undefined }>
  setStore: SetStoreFunction<{ value: VcsInfo | undefined }>
  ready: Accessor<boolean>
}

export type MetaCache = {
  store: Store<{ value: ProjectMeta | undefined }>
  setStore: SetStoreFunction<{ value: ProjectMeta | undefined }>
  ready: Accessor<boolean>
}

export type IconCache = {
  store: Store<{ value: string | undefined }>
  setStore: SetStoreFunction<{ value: string | undefined }>
  ready: Accessor<boolean>
}

export type ChildOptions = {
  bootstrap?: boolean
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  now: number
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
}

export type RootLoadArgs = {
  directory: string
  limit: number
  list: (query: { directory: string; roots: true; limit?: number }) => Promise<{ data?: Session[] }>
  onFallback: () => void
}

export type RootLoadResult = {
  data?: Session[]
  limit: number
  limited: boolean
}

export const MAX_DIR_STORES = 30
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_RECENT_WINDOW = 4 * 60 * 60 * 1000
export const SESSION_RECENT_LIMIT = 50
