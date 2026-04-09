/**
 * Codex Responses API types.
 *
 * Aligned with refs/codex/codex-rs/codex-api/src/common.rs
 */

/** HTTP request body — mirrors ResponsesApiRequest in codex-rs */
export interface ResponsesApiRequest {
  model: string
  instructions?: string
  input: ResponseItem[]
  tools?: unknown[]
  tool_choice?: string | { type: string; name?: string }
  parallel_tool_calls?: boolean
  reasoning?: ReasoningControls
  store?: boolean
  stream?: boolean
  include?: string[]
  service_tier?: string
  prompt_cache_key?: string
  text?: TextControls
  context_management?: ContextManagement[]
  client_metadata?: Record<string, string>
}

/** WebSocket request — wraps ResponsesApiRequest + WS-only fields */
export interface ResponseCreateWsRequest extends ResponsesApiRequest {
  previous_response_id?: string
  generate?: boolean
}

export interface ReasoningControls {
  effort?: string
  summary?: string
}

export interface TextControls {
  verbosity?: string
  format?: unknown
}

export interface ContextManagement {
  type: "compaction"
  compact_threshold: number
}

/** Union type for all items in the input array */
export type ResponseItem =
  | { type: "message"; role: string; content: string | ContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { role: string; content: string | ContentPart[] }
  | Record<string, unknown>

export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "input_audio"; data: string; format: string }
  | Record<string, unknown>

/** SSE events from the Responses API stream */
export type ResponseStreamEvent =
  | { type: "response.created"; response: ResponseObject }
  | { type: "response.in_progress"; response: ResponseObject }
  | { type: "response.completed"; response: ResponseObject }
  | { type: "response.failed"; response: ResponseObject }
  | { type: "response.output_item.added"; item: OutputItem; output_index: number }
  | { type: "response.output_item.done"; item: OutputItem; output_index: number }
  | { type: "response.content_part.added"; part: ContentPartDelta; output_index: number; content_index: number }
  | { type: "response.content_part.done"; part: ContentPartDelta; output_index: number; content_index: number }
  | { type: "response.output_text.delta"; delta: string; output_index: number; content_index: number }
  | { type: "response.output_text.done"; text: string; output_index: number; content_index: number }
  | { type: "response.function_call_arguments.delta"; delta: string; output_index: number; call_id: string }
  | { type: "response.function_call_arguments.done"; arguments: string; output_index: number; call_id: string }
  | { type: "response.reasoning_summary_text.delta"; delta: string; output_index: number; content_index: number }
  | { type: "response.reasoning_summary_text.done"; text: string; output_index: number; content_index: number }
  | { type: "response.refusal.delta"; delta: string; output_index: number; content_index: number }
  | { type: "error"; error: { type: string; message: string; code?: string } }
  | { type: string; [key: string]: unknown }

export interface ResponseObject {
  id: string
  status: string
  output?: OutputItem[]
  usage?: ResponseUsage
  error?: { type: string; message: string; code?: string }
  metadata?: Record<string, unknown>
}

export interface OutputItem {
  type: string
  id?: string
  role?: string
  content?: ContentPartDelta[]
  name?: string
  call_id?: string
  arguments?: string
  status?: string
  summary?: ContentPartDelta[]
}

export interface ContentPartDelta {
  type: string
  text?: string
  annotations?: unknown[]
}

export interface ResponseUsage {
  input_tokens: number
  output_tokens: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
  total_tokens?: number
}

/** Auth credential types */
export interface CodexCredentials {
  type: "oauth"
  refresh: string
  access?: string
  expires?: number
  accountId?: string
}

export interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

export interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

/** Per-session continuation state for WS delta */
export interface ContinuationState {
  lastResponseId?: string
  lastInputLength?: number
  accountId?: string
}

/** Window generation tracking for context-window lineage */
export interface WindowState {
  conversationId: string
  generation: number
}
