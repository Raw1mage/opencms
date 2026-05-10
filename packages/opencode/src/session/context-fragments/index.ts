/**
 * Context fragments — public surface.
 *
 * Mirrors upstream codex-cli's `context::*` module
 * (refs/codex/codex-rs/core/src/context/mod.rs). Each fragment file
 * exports one builder function (`build*Fragment`) plus its
 * marker constants. Bundle assembly entry point is `assembleBundles`.
 */

export type { ContextFragment, FragmentRole, FragmentSource } from "./fragment"
export { renderFragment } from "./fragment"

export type { BundledMessage, AssembleResult } from "./assemble"
export { assembleBundles } from "./assemble"

export {
  buildEnvironmentContextFragment,
  ENVIRONMENT_CONTEXT_OPEN_TAG,
  ENVIRONMENT_CONTEXT_CLOSE_TAG,
} from "./environment-context"
export type { EnvironmentContextInput } from "./environment-context"

export {
  buildUserInstructionsFragment,
  USER_INSTRUCTIONS_START_MARKER,
  USER_INSTRUCTIONS_END_MARKER,
} from "./user-instructions"
export type { UserInstructionsInput } from "./user-instructions"

export {
  buildOpencodeProtocolFragment,
  OPENCODE_PROTOCOL_OPEN_TAG,
  OPENCODE_PROTOCOL_CLOSE_TAG,
} from "./opencode-protocol-instructions"
export type { OpencodeProtocolInput } from "./opencode-protocol-instructions"

export {
  buildRoleIdentityFragment,
  ROLE_IDENTITY_OPEN_TAG,
  ROLE_IDENTITY_CLOSE_TAG,
} from "./role-identity"
export type { RoleIdentityInput } from "./role-identity"
