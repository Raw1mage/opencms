# Reverted feature commits review (round 1)

Date: 2026-02-17
Scope: `cms` branch reverted commits identified in 2026-02-01 ~ 2026-02-11 window.
Goal: Evaluate **behavioral value** vs **stability risk** before any re-apply.

## Decision table

| Revert commit | Original feature                                                    | Behavioral improvement                                                 | Current state on `cms`                                                                 | Recommendation                                                                    |
| ------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `2e8082dd2`   | `feat(desktop): add WSL backend mode (#12914)`                      | Add WSL backend execution mode and related desktop settings/i18n       | Not present                                                                            | Re-design and re-port in small slices; do not blind cherry-pick                   |
| `63cd76341`   | `feat: add version to session header and /status dialog (#8802)`    | Display app version in session header + status dialog                  | Header version exists, status version missing                                          | Keep header, optionally restore status version only                               |
| `32394b699`   | `feat(tui): highlight esc label on hover in dialog (#12383)`        | Better affordance for clickable esc labels in dialogs                  | Not present                                                                            | Re-apply as shared component-level UX pattern (small patch)                       |
| `12262862c`   | `feat: show connected providers in /connect dialog (#8351)`         | Show provider connection status in connect dialog                      | Already present                                                                        | No action needed                                                                  |
| `a7c5d5ac4`   | `feat(tui): restore footer to session view (#12245)`                | Restore session footer in narrow/sidebar-hidden view                   | Already present                                                                        | No action needed                                                                  |
| `8c8d88814`   | models.dev schema refs for model autocomplete                       | Better config editor autocomplete/typing metadata for model fields     | Not present                                                                            | Re-introduce behind compatibility check (SDK/OpenAPI first)                       |
| `5588453cb`   | revert double header-merge behavior                                 | Prevent duplicated headers when auth data merges from multiple sources | Present                                                                                | Keep as-is; do not revert this fix                                                |
| `b5a4671c6`   | revert Trinity system prompt support                                | Feature was Trinity model-specific prompt routing                      | Not present                                                                            | Reconsider only if Trinity provider/model is in active support scope              |
| `aa6b552c3`   | revert mistakenly merged PR                                         | Roll back unstable attachment/part ID handling changes                 | Revert is active                                                                       | Keep revert unless full regression tests are added first                          |
| `70cf609ce`   | `feat(ui): Select, dropdown, popover styles & transitions (#11675)` | Major UI polish + transitions + new components                         | Not present                                                                            | Re-port incrementally per component (high UX value, medium risk)                  |
| `2f76b49df`   | `feat(ui): Smooth fading out on scroll, style fixes (#11683)`       | Scroll fade/reveal visuals and list polish                             | Not present                                                                            | Re-port gradually; validate perf + terminal rendering first                       |
| `dc5b85188`   | auto-fallback on rate-limit + Gemini thought_signature heuristics   | Automatic model cycling on retry states; broader error classification  | Partially superseded by newer rotation split and thought-signature handling            | Re-evaluate algorithm against current rotation modules; avoid direct reapply      |
| `cfbe9d329`   | revert OpenTUI OSC52 clipboard upgrade                              | Better remote clipboard handling via renderer OSC52 support            | Not present                                                                            | Re-test on current OpenTUI version in isolated branch first                       |
| `c5dc075a8`   | revert plugin exports to `dist`                                     | Fix published package import path correctness                          | `exports` intentionally point to `src` in workspace; publish script rewrites to `dist` | Keep workspace `src` exports; rely on `packages/plugin/script/publish.ts` rewrite |

## Notes

- This review is behavior-oriented, not patch-oriented.
- Already-restored behaviors were detected in current code paths (provider connected footer, session footer, header version).
- High-risk areas for blind patching: rotation/error classification, desktop backend mode, and large UI style bundles.

## Execution updates (same day)

- Implemented: status dialog version display (`63cd76341` target behavior).
- Implemented: interactive `esc` dismiss affordance via shared `DialogDismiss` component (`32394b699` target behavior).
- Implemented: models.dev schema metadata on config model fields (`8c8d88814` target behavior with compatibility-preserving scope).
- Reverted after review: guarded favorite-model auto-cycle on rate-limit retry (`dc5b85188` related behavior) was removed to preserve rotation central-control authority and avoid duplicate fallback logic in TUI.
- Final decision for `dc5b85188`: keep this behavior out of TUI layer; any retry/fallback strategy changes must stay in session/rotation central path.
- Decision change for plugin exports (`c5dc075a8`): direct `dist` exports break monorepo typecheck; kept source exports and retained publish-time rewrite mechanism.

## Logging policy update (P1 follow-up)

- New operational requirement: make `debug.log` the single source of truth for rotation/rate-limit incident forensics.
- Implemented instrumentation in first-receive path (`session/llm.ts` onError): record raw provider error envelope (status/code/message/headers/responseBody/data) at first touch.
- Implemented instrumentation in decision path (`account/rate-limit-judge.ts`): record `judge:start`, `judge:classified`, `judge:strategy`, `judge:result`, and `markRateLimited:*` lifecycle checkpoints.
- Purpose: stop keyword-guess tuning without evidence; use real captured payloads to iteratively refine 429 semantic classification.
