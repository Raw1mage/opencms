# Design

## Context

- `main` 已吸收 4/1 recovery branch，但相對舊 `cms` 強基線仍有約 32~42 commits 差集。
- 這些差集不是單一主題，而分布在 branding、session hardening、provider/native、global init、debug/test、docs/specs 等不同功能面。
- 使用者明確表示：有些區域已花時間重做，所以計畫必須保護現況，不可因為舊 commit 存在就直接回帶。
- 使用者進一步要求：plan 階段應先把所有 commits 拆細、分解、重組成「以最新 `HEAD` 為基礎的重構問題」，而不是把問題表述成單純的 git restore。

## Goals / Non-Goals

**Goals:**

- 將 missing commits 轉譯為一組以最新 `HEAD` 為基礎的功能重構問題。
- 讓後續 build work 針對「最終最新可運作版」重建功能，而不是照舊 patch 順序回放。
- 把已重做區域、需去重區域、需完整重建的區域清楚切開。

**Non-Goals:**

- 不把 build 工作定義成 raw cherry-pick / raw SHA replay。
- 不把所有缺失 commit 都視為同等優先或同等粒度。
- 不在 planning 階段直接執行大範圍 restore code changes。

## Decisions

- Decision 1: 以「功能重構問題」而不是 raw SHA 清單作為 build 單位。
- Decision 2: provider manager bucket 標記為 skipped，因為使用者已重做該區，舊 commit 恢復風險高於收益。
- Decision 3: 每個問題面向都先做 diff-first + supersession review，再進入實作，避免把已存在的新實作誤判成缺失。
- Decision 4: 所有問題面向的目標都是「最新 `HEAD` 上新增/重建缺失功能」，不是把舊 patch 原樣搬回來。
- Decision 5: branding 問題面向放在前面，因為它是使用者已重新踩到、最可見的 confirmed regression。
- Decision 6: assistant 被授權在證據充分時判定某些舊功能維持廢棄，前提是最新 `HEAD` 的現有方案更好，且必須留下明確 rationale。

## Reconstruction Problem Map

### R1. Branding / Shell Identity Reconstruction

- 來源 commits：`0f3176973`, `db1050f06`
- 最新 HEAD 問題：tab title / favicon / shell identity 回歸到 `OpenCode`
- 重構目標：在最新 `HEAD` 上恢復 `TheSmartAI` branding 與對應 icon/logo 路徑

#### Subproblems

- R1.1 app shell title / meta title source 重構
- R1.2 favicon / apple-touch-icon / logo asset route 重構
- R1.3 web shell branding 與 onboarding 混合切片去重（Wave 0 已解析；不形成獨立 build slice）

#### Dependencies

- 依賴目前 `packages/app` / `packages/ui` shell 入口實作
- 與 R4 共享 `db1050f06` 混合桶，需要先做切片分離

#### Keep-Deprecated Criteria

- 若最新 `HEAD` 的 branding/system identity 已有更完整的一致方案，且只是文案/資產路徑不同，舊設計本身可不回；但 `TheSmartAI` 品牌識別若仍缺失，則不得 keep deprecated

#### Validation Focus

- `packages/app/index.html`
- `packages/ui/src/components/favicon.tsx`
- title / icon / touch icon / shell identity 對齊

### R2. Session / Rebind / Compaction / Subagent Stability Reconstruction

- 來源 commits：`3fd1ef9b8`, `efc3b0dd9`, `4a6e10f99`, `f041f0db8`, `85691d6e3`, `f768f63a1`, `3c60b613f`
- 最新 HEAD 問題：session 接續、checkpoint、history compaction、subagent lifecycle 的穩定性與節奏仍有遺失/待確認切片
- 重構目標：在最新 `HEAD` 上重建最終穩定版 session/runtime 行為

#### Subproblems

- R2.1 rebind checkpoint safety（atomic write / boundary safety / token limits）
- R2.2 continuation identity integrity（避免 rebind restart 串錯 continuation id）
- R2.3 compaction/history truncation 與 checkpoint cooldown
- R2.4 subagent lifecycle / weak-model failure containment
- R2.5 media payload parsing compatibility（Wave 0 結論：目前 `message-v2.ts` 仍停留在 `image` + data URL 路徑，未見較新 superseding 實作，因此保留為 rebuild target）
- R2.6 checkpoint threshold / cadence tuning

#### Dependencies

- 依賴 session runtime、compaction、workflow runner、task/subagent lifecycle 實作
- R2.5 需與現行 media/model payload path 做 supersession review

#### Keep-Deprecated Criteria

- 若現行 `HEAD` 的 session/rebind 路徑已有更穩定統一實作，可不回原做法；但任何會降低穩定性、證據性或資料完整性的缺口不可 keep deprecated

#### Validation Focus

- rebind / checkpoint persistence
- continuation identity consistency
- small-context compaction behavior
- subagent failure isolation

### R3. Tool Loading / Tool Schema / Prompt Ergonomics Reconstruction

- 來源 commits：`7bd35fb27`, `43d2ca35c`, `a34d8027a`, `eaced345d`
- 最新 HEAD 問題：Wave 1 比對後確認此組主要能力已被目前主線吸收；後續重點改為維持與驗證，而非重新實作
- 重構目標：保留目前 `HEAD` 已吸收的 tool runtime / prompt ergonomics 能力，避免後續波次誤回退

#### Subproblems

- R3.1 lazy tool loading / adaptive auto-load
- R3.2 always-present tool ID correctness
- R3.3 tool description mutation stability
- R3.4 toolcall schema examples / error recovery guidance

#### Dependencies

- 依賴 tool registry、prompt/tool schema 組裝、runtime tool loading path

#### Keep-Deprecated Criteria

- 若現行 tool runtime 已有更好的 loading 策略，可不回原策略；但會導致 tool discoverability、schema correctness 或 error recovery 變差的缺口不可 keep deprecated

#### Validation Focus

- tool registration correctness
- schema completeness
- loading/runtime behavior under long context

### R4. Global User Init / Onboarding / Marketplace Reconstruction

- 來源 commits：`18793931b`, `5c18f28fe`, `db1050f06`
- 最新 HEAD 問題：repo-independent user-init、多使用者 onboarding、MCP marketplace 殘餘功能未完整回到主線
- 重構目標：在最新 `HEAD` 上恢復初始化與導入能力，但先對混合桶去重

#### Subproblems

- R4.1 system-wide template support for repo-independent init
- R4.2 automated user-init / shell profile injection
- R4.3 multi-user onboarding residue from mixed gateway/web bucket（含 gateway/login/socket bootstrap 類切片）
- R4.4 MCP marketplace residue from mixed gateway/web bucket（含 template catalog / toggle / beta-tool cleanup 類切片）

#### Dependencies

- 與 R1 共享 `db1050f06` 混合桶，需先抽離 branding 子切片
- 依賴 global init entrypoints / install path / web onboarding surface

#### Keep-Deprecated Criteria

- 若最新 `HEAD` 已有更好的 onboarding/init flow，可維持舊做法廢棄；但 repo-independent init 或 marketplace 能力若仍缺整段體驗，不應直接判廢

#### Validation Focus

- init template flow
- shell/profile integration
- onboarding surface completeness
- marketplace discoverability / accessibility

### R5. Claude Capability Chain Reconstruction

- 來源 commits：`197fc2bd7`, `267955d3a`, `9321ca7b1`, `809135c30`, `4a4c69488`, `addb248b2`, `e039b1cb8`, `515a1ca7d`, `72ee7f4f1`, `a148c0e14`
- 最新 HEAD 問題：`claude-provider` / `claude-native` / `claude-cli` 能力鏈未完整回到最新可運作版
- 重構目標：在最新 `HEAD` 上重建完整可用的 Claude 能力鏈，而不是停在某個中間版本

#### Subproblems

- R5.1 native OAuth / shared library / CLI auth path
- R5.2 native FFI binding + ClaudeNativeAuthPlugin
- R5.3 LanguageModelV2 / JSCallback bridge（較新主鏈）
- R5.4 transport parser / lower-level transport safety（Wave 0 結論：因 current `transport.c` 仍為 placeholder，`R5.4` 不作為獨立修補，而是併入較新的 Claude transport 重建）
- R5.5 claude-cli fetch interceptor / provider path correctness
- R5.6 provider registration / visibility / init integration
- R5.7 local-uncommitted-residue audit (`e039b1cb8`)（Wave 0 結論：舊 fallback 路徑維持廢棄，不作 standalone rebuild）
- R5.8 merge-slice audit (`515a1ca7d`)（Wave 0 結論：併回 R5.3/R5.5/R5.6 與 provider-manager skip，不作 standalone rebuild）
- R5.9 refs/submodule support (`claw-code`) and dependent docs/specs state（Wave 0 結論：保留 refs/submodule 能力，但不回退到 `a148c0e14` 指向的較舊 submodule 版本）

#### Dependencies

- R5.3 可能 supersede R5.5 的部分舊接法
- R5.4 / R5.7 / R5.8 需依附完整能力鏈一起判讀，不能孤立決策
- R5.9 服務於實作與 docs/spec 對照

#### Keep-Deprecated Criteria

- 原則上 `claude` 能力鏈預設不做 scope shrink；只有當最新 `HEAD` 已有更完整等價能力，且重回舊切片會造成降級時，才允許 keep deprecated

#### Validation Focus

- auth
- native bridge
- transport
- provider registration
- web/provider visibility where applicable
- end-to-end usable Claude path on latest `HEAD`

### R6. GitHub Copilot Reasoning Reconstruction

- 來源 commits：`79e71cbde`
- 最新 HEAD 問題：Copilot 路線缺 reasoning variants
- 重構目標：在最新 `HEAD` 上恢復 reasoning-capable model variants

#### Subproblems

- R6.1 model registry reasoning variants
- R6.2 user-facing selection / naming alignment

#### Dependencies

- 依賴 provider/model registry path

#### Keep-Deprecated Criteria

- 若現行 model lineup 已有更合理替代 naming/variant strategy，可不逐字回舊命名；但 reasoning-capable variants 這個能力若仍缺，則不得 keep deprecated

#### Validation Focus

- model IDs present
- reasoning variants selectable/usable

### R7. Observability / Debug Evidence Reconstruction

- 來源 commits：`3ab872842` 及相關 event/docs
- 最新 HEAD 問題：部分 packet/debug checkpoints 與除錯證據面未完整恢復
- 重構目標：在最新 `HEAD` 上恢復可提升 debug evidence 的觀測點

#### Subproblems

- R7.1 llm packet checkpoints
- R7.2 event/docs evidence alignment for restored observability slices

#### Dependencies

- 與 R8 docs/event reconstruction 有聯動

#### Keep-Deprecated Criteria

- 若現行 `HEAD` 已有更好的 observability 路徑，可不回原 checkpoint 位置；但證據能力下降的缺口不可 keep deprecated

#### Validation Focus

- checkpoint signal presence
- debug evidence usefulness
- event sync completeness

### R8. Plans / Specs / Docs State Reconstruction

- 來源 commits：所有 docs/spec/plan/event 類 commits
- 最新 HEAD 問題：長期文件、計畫文件與事件記錄未必處於歷史演化後的最終狀態
- 重構目標：在最新 `HEAD` 上恢復最終最新可讀/可用的文件狀態

#### Subproblems

- R8.1 session/rebind/context-optimization docs state
- R8.2 claude-provider plan/spec/event docs state
- R8.3 user-init / onboarding event and task docs state
- R8.4 github-copilot docs/event state
- R8.5 current `restore_missing_commits` plan package coherence

#### Dependencies

- 依附 R1-R7 的最終重構結論

#### Keep-Deprecated Criteria

- 不以保留舊 wording 為目標；若現行文件結構更好，可直接整理為最新 coherent state

#### Validation Focus

- artifact coherence
- final-state readability/usability
- consistency with current architecture and chosen reconstruction outcomes

## Data / State / Control Flow

- 盤點資料流：git/history evidence -> commit decomposition -> reconstruction problem map -> user/global principles -> planner artifacts -> later build execution slices.
- 執行控制流：選定 reconstruction problem -> compare current `HEAD` vs final historical intent -> isolate missing delta -> implement on latest `HEAD` as new work -> validate -> sync docs/events/specs.

## Risks / Trade-offs

- Old commit may conflict with newer rewrite -> mitigate by diff-first + supersession review before coding.
- Mixed commits may duplicate already-redone functionality -> mitigate by decomposition and dedup before implementation.
- Commit presence may not equal missing behavior -> mitigate by validating actual runtime/product/doc behavior, not ancestry alone.
- Reconstructing on latest `HEAD` is cognitively heavier than replaying old patches -> mitigate by first converting commits into stable reconstruction problems and execution slices.
- Some historical features may be obsolete relative to current `HEAD` -> mitigate by allowing evidence-backed "keep deprecated" outcomes instead of forcing restoration.

## Critical Files

- `packages/app/index.html`
- `packages/ui/src/components/favicon.tsx`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/workflow-runner.ts`
- `packages/opencode/src/plugin/codex-websocket.ts`
- `packages/opencode/src/plugin/claude-native.ts`
- `packages/opencode-claude-provider/`
- `packages/opencode/src/global/index.ts`
- `script/install.ts`

## Supporting Docs (Optional)

- `docs/events/event_20260401_cms_codex_recovery.md`
