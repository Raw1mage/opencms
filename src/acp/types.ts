import type { McpServer } from "@agentclientprotocol/sdk"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"

export interface ACPSessionState {
  id: string
  cwd: string
  mcpServers: McpServer[]
  createdAt: Date
  model?: {
    providerId: string
    modelID: string
  }
  variant?: string
  modeId?: string
}

export interface ACPConfig {
  sdk: OpencodeClient
  defaultModel?: {
    providerId: string
    modelID: string
  }
}
