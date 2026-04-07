export {
  // Core constants
  VERSION,
  CLIENT_ID,
  API_VERSION,
  BASE_API_URL,
  TOOL_PREFIX,
  BOUNDARY_MARKER,
  // OAuth
  OAUTH,
  AUTHORIZE_SCOPES,
  REFRESH_SCOPES,
  // Identity
  IDENTITY_INTERACTIVE,
  IDENTITY_AGENT_SDK,
  IDENTITY_PURE_AGENT,
  IDENTITY_VALIDATION_SET,
  // Beta flags
  MINIMUM_BETAS,
  assembleBetas,
  // Billing
  calculateAttributionHash,
  buildBillingHeader,
} from "./protocol.js"
export type { AssembleBetasOptions } from "./protocol.js"

export {
  MODEL_CATALOG,
  getMaxOutput,
  findModel,
  isKnownModel,
} from "./models.js"
export type { ClaudeModelSpec } from "./models.js"
