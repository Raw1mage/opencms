# Refactor Plan: Submodule Integration (2026-02-08)

## Overview
Integration of updates from `refs/opencode-antigravity-auth` and `refs/opencode-gemini-auth` into `cms` architecture.

## Strategy
We will **NOT** blindly merge submodules. Instead, we will selectively port changes that enhance the plugins while preserving CMS-specific architecture:
1.  **3-way Split**: `antigravity` and `gemini-cli` remain separate.
2.  **Multi-account**: Use global CMS account management, not plugin-local.
3.  **Rotation3D**: Preserve global rotation logic.

## Detailed Plan

### 1. `gemini-cli` Plugin (High Risk)
-   **Source**: `refs/opencode-gemini-auth/src/plugin/`
-   **Target**: `src/plugin/gemini-cli/plugin/`
-   **Action**:
    -   Port `enhanceGeminiErrorResponse` and error handling logic from `request-helpers.ts` to improve error messaging.
    -   Port `request-helpers.ts` updates for `ThinkingConfig` and `GeminiUsageMetadata`.
    -   Port `project.ts` updates for better project context caching and resolution.
    -   **Discard**: Auth/Token management changes that conflict with CMS global accounts.
    -   **Discard**: `debug.ts` file logging changes (CMS uses its own logging).

### 2. `antigravity` Plugin (High Risk)
-   **Source**: `refs/opencode-antigravity-auth/src/plugin/`
-   **Target**: `src/plugin/antigravity/plugin/`
-   **Action**:
    -   Port `oauth.ts` changes for `state` encoding (projectId) and better error handling.
    -   Port `auto-update-checker` hooks improvements (better logging, caching).
    -   Port `config/schema.ts` updates for `ToastScope` and `soft_quota` settings.
    -   **Discard**: `model-registry.ts` in submodule (CMS has its own `src/plugin/antigravity/plugin/model-registry.ts`).
    -   **Discard**: `updater.ts` and `models.ts` in config (CMS handles models differently).

### 3. Verification
-   Run `bun test` in `src/plugin/antigravity` and `src/plugin/gemini-cli`.
-   Verify build with `bun run build`.

## Risk Assessment
-   **API Breakage**: Low. Most changes are internal helpers and error handling.
-   **Side Effects**: Potential auth flow issues if `oauth.ts` changes are not compatible with CMS auth handler. Will verify carefully.
-   **Data Loss**: None.

## Approval
Waiting for user approval to proceed with execution.
