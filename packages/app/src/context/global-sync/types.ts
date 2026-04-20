import type {
  Agent,
  Command,
  Config,
  File,
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

// session-ui-freshness DD-1 / DD-8: inline client metadata for session-scoped entries.
// Missing / NaN / Infinity / negative receivedAt must be treated as 0 by consumers (DD-4).
export type ClientStampMeta = {
  receivedAt: number
}

export type StoreSessionStatusEntry = SessionStatus & ClientStampMeta

export type StoreActiveChildEntry = ClientStampMeta & {
  sessionID: string
  parentMessageID: string
  toolCallID: string
  workerID: string
  title: string
  agent: string
  status: "running" | "handoff"
  dispatchedAt?: number
  todo?: {
    id: string
    content: string
    status: string
    action?: Todo["action"]
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
    [sessionID: string]: StoreSessionStatusEntry
  }
  active_child: {
    [sessionID: string]: StoreActiveChildEntry
  }
  session_telemetry: {
    [sessionID: string]: SessionTelemetry
  }
  session_diff: {
    [sessionID: string]: FileDiff[]
  }
  workspace_diff: {
    [sessionID: string]: File[]
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
  codex_transport: Record<string, "ws" | "http">
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

export type SessionTelemetryPromptBlock = {
  id: string
  name: string
  sourceFile?: string
  kind?: string
  injectionPolicy?: string
  outcome: "injected" | "skipped"
  skipReason?: string
  estimatedTokens?: number
  correlationIDs: string[]
  builderTag?: string
}

export type SessionTelemetryRoundSummary = {
  sessionId: string
  roundIndex?: number
  requestId?: string
  providerId?: string
  accountId?: string
  modelId?: string
  promptTokens?: number
  inputTokens?: number
  responseTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  compacting: boolean
  compactionResult?: string
  compactionDraftTokens?: number
}

export type SessionTelemetrySessionSummary = {
  sessionId: string
  durationMs?: number
  cumulativeTokens: number
  totalRequests: number
  providerId?: string
  accountId?: string
  modelId?: string
  compacting: boolean
  compactionCount: number
  latestUpdatedAt?: number
}

export type SessionTelemetry = {
  phase: "loading" | "ready" | "empty" | "error" | "disabled"
  promptPhase: "loading" | "ready" | "empty" | "error" | "disabled"
  roundPhase: "loading" | "ready" | "empty" | "error" | "disabled"
  error?: string
  summary: {
    statusLabel: string
    activeTasks: number
    requests: number
    totalTokens: number
    promptBlockCount: number
    injectedCount: number
    skippedCount: number
    estimatedPromptTokens: number
    lastPromptOutcome?: "injected" | "skipped"
  }
  prompt: {
    blocks: SessionTelemetryPromptBlock[]
    lastUpdated?: number
  }
  round: SessionTelemetryRoundSummary
  sessionSummary: SessionTelemetrySessionSummary
  quota: {
    phase: "loading" | "ready" | "empty" | "error" | "disabled"
    providerId?: string
    accountId?: string
    modelId?: string
    pressure: "low" | "medium" | "high" | "critical"
    activeIssues: Array<{
      type: string
      message: string
      timestamp: number
    }>
    recentEvents: Array<{
      state: string
      message?: string
      timestamp: number
    }>
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
  accountId?: string
  timestamp: number
  /** "error" | "ratelimit" | "auth_failed" | "recovered" | "rotated" */
  state: string
  message?: string
  /** For "rotated" state: the target model/provider/account */
  toProviderId?: string
  toModelId?: string
  toAccountId?: string
}

export const LLM_HISTORY_CAP = 10

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
  list: (query: { directory: string; roots?: boolean; limit?: number }) => Promise<{ data?: Session[] }>
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
