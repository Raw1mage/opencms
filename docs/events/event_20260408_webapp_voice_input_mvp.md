# Event: webapp voice input MVP

Date: 2026-04-08 (closed 2026-04-10)
Status: Completed — merged to main, plan closed to `specs/webapp/voice-input/`
Plan Root: `plans/20260408_webapp/` (closed)
Spec: `specs/webapp/voice-input/spec.md`

## 需求

- 使用者希望為 webapp 的文字輸入框新增語音輸入功能。
- 經討論後，原本先做 browser-only 快速版；後續使用者補充 iPhone Chrome 也要可用，因此 plan 擴充為桌面即時辨識 + 手機錄音轉寫雙路方案。

## 範圍 (IN/OUT)

- IN:
  - `packages/app/src/components/prompt-input.tsx` 的 mic control、錄音中狀態、unsupported/error 提示。
  - 沿用 `packages/app/src/utils/speech.ts` 與 `packages/app/src/utils/runtime-adapters.ts`。
  - 將 final transcript 安全回寫到 canonical prompt state。
  - 最小必要的測試與手動驗證規劃。
  - 手機錄音 + 上傳 + 轉寫的 plan 擴充與驗證規劃。
- OUT:
  - 具體後端 STT provider 選型與實作細節。
  - 音訊錄製檔案的長期儲存、回放與產品化管理。
  - TUI / desktop parity。
  - 進階語音產品化體驗。

## 任務清單

- [x] 盤點 webapp prompt input 與既有 speech infra。
- [x] 確認 `packages/app/src/utils/speech.ts` 已存在且未接入 `prompt-input`。
- [x] 建立 `plans/20260408_webapp/` 規劃包（proposal/spec/design/tasks/handoff + diagrams）。
- [x] 收斂 transcript 策略為 `Final only`。
- [x] 進入 beta workflow build handoff。
- [x] 在 beta implementation surface 實作 `prompt-input` 語音輸入 MVP。
- [~] 驗證支援瀏覽器、unsupported path、既有 prompt 行為無回歸（尚缺 browser smoke 與完整 typecheck/lint 證據）。
- [x] 擴充 plan 為手機錄音 + 轉寫雙路方案。
- [x] 實作手機 MediaRecorder 錄音 hook（`audio-recorder.ts`）。
- [x] 實作 server-side 轉寫端點（`POST /session/:id/transcribe`，自動尋找 audio-capable model）。
- [x] 在 prompt-input 加入 dual-path capability detection（speech | recording | unsupported）。
- [x] 整合錄音 → 上傳 → 轉寫 → prompt state 回填。
- [ ] 驗證手機瀏覽器錄音轉寫端到端流程。
- [ ] Beta fetch-back + finalize。

## Debug Checkpoints

- Baseline:
  - `packages/app/src/components/prompt-input.tsx` 是 webapp session 文字輸入主體。
  - `packages/app/src/utils/speech.ts` 已提供 browser speech recognition helper。
  - 初始狀態 UI 尚無 mic control，speech helper 尚未接線。
- Boundary:
  - 本案限定 browser/client 端，不擴及 `packages/opencode/src/server/**`。
  - 不得新增靜默 fallback；unsupported path 必須明確呈現。
- Design Decision:
  - Transcript strategy 採 `Final only`：只把 final transcript 寫入 canonical prompt state，interim 僅做暫態 UI 顯示。
  - 理由：降低 `contenteditable` + prompt state 雙向同步風險，先保守驗證 MVP。
- Design Update:
  - iPhone Chrome / iOS WebKit 不可靠支援 `SpeechRecognition`，因此手機目標必須新增錄音 + 轉寫路徑，而不是只擴充既有 Web Speech API。
- Implementation Evidence:
  - `packages/app/src/components/prompt-input.tsx` 已接入 `createSpeechRecognition()`。
  - `appendSpeechTranscript()` 只在 `onFinal` 經 `prompt.set(...)` 回寫 canonical state。
  - `speech.interim()` 僅做暫態 UI 顯示，未同步進 canonical prompt state。
  - mic button 以 `speechSupported()` / `working()` 控制 disabled，unsupported path 走明確 tooltip。
  - 非 normal mode / working 狀態會主動 `speech.stop()`。

## Key Decisions

- 採 browser-only MVP，不做後端 STT。
- 沿用既有 `speech.ts`，不新增第二套 speech abstraction。
- unsupported/error path 維持 fail-fast，不用 fallback 掩蓋能力缺失。
- 手機目標擴充為錄音 + 轉寫方案，避免把 iPhone Chrome 當成可用的 Web Speech API 目標。
- 實作前先用 planner package 鎖定同一 workstream，再交給 beta workflow build。
- Beta workflow authority confirmed:
  - `mainRepo=/home/pkcs12/projects/opencode`
  - `mainWorktree=/home/pkcs12/projects/opencode`
  - `baseBranch=main`
  - `implementationRepo=/home/pkcs12/projects/opencode`
  - `implementationWorktree=/home/pkcs12/projects/opencode-worktrees/webapp-voice-input-mvp`
  - `implementationBranch=beta/webapp-voice-input-mvp`
  - `docsWriteRepo=/home/pkcs12/projects/opencode`

## Verification

- 規劃階段驗證：
  - 已完成 `plans/20260408_webapp/` artifact 對齊。
  - 已確認 critical files 與 validation plan。
- Build 階段已完成：
  - `bun x prettier --check /home/pkcs12/projects/opencode-worktrees/webapp-voice-input-mvp/packages/app/src/components/prompt-input.tsx /home/pkcs12/projects/opencode-worktrees/webapp-voice-input-mvp/packages/app/src/i18n/en.ts /home/pkcs12/projects/opencode-worktrees/webapp-voice-input-mvp/packages/app/src/i18n/zht.ts` ✅
  - 程式變更僅落在：
    - `packages/app/src/components/prompt-input.tsx`
    - `packages/app/src/i18n/en.ts`
    - `packages/app/src/i18n/zht.ts`
- Build 階段阻塞：
  - `bun run typecheck` ❌ 環境缺 `tsgo`（依 `packages/app/package.json` script 定義）。
  - `bun x tsc --noEmit -p packages/app/tsconfig.json` ❌ beta worktree 缺完整 workspace dependency/module resolution。
  - `bun x eslint ...` ❌ tooling resolution failure（環境阻塞）。
  - 尚未執行 Chromium browser smoke，因此仍缺：
    - supported browser 錄音 → final commit 證據
    - unsupported browser disabled + tooltip 證據
    - attach/send/stop/shell mode regression 證據
- Current shipping assessment:
  - **Not safe to ship yet**。
  - 主因是驗證環境與 browser smoke 缺失，並非已確認的程式邏輯缺陷。

- 最新驗證（test branch: `test/webapp-voice-input-mvp`）：
  - `bun run typecheck` ❌（3 個既有 baseline 錯誤，未落在本次 voice-input 變更檔）
    - `packages/app/src/pages/session/file-tabs.tsx:735`
    - `packages/ui/src/components/message-part.tsx:1801`
    - `packages/ui/src/components/message-part.tsx:1815`
  - `bun test --preload ./happydom.ts ./src/utils/runtime-adapters.test.ts` ✅（6 pass / 0 fail）
  - `bun test --preload ./happydom.ts ./src/components/prompt-input/history.test.ts ./src/components/prompt-input/submit.test.ts ./src/components/prompt-input/editor-dom.test.ts ./src/components/prompt-input/placeholder.test.ts` ✅（17 pass / 0 fail）
  - `speech.ts` 收斂修正驗證 ✅：final transcript 事件後 `shouldContinue=false` 且 `clearRestart()`，`onend` 不再觸發 restart。
    - 模擬證據：`{"startCalls":1,"stopCalls":0,"finals":["hello world"],"isRecording":false}`
    - 解讀：`startCalls=1`、`isRecording=false`，代表 final 後已收斂且未自動重聽。
  - Browser smoke（Playwright）⚠️：受 AuthGate/登入前置阻塞，未能進入含 `PromptInput` 的 session route，故無法完成真實 mic 權限與 final transcript E2E 證據。
  - 使用者決策：**略過 browser smoke 測試**（skip tests）。
  - 結論：**Not safe to ship（證據不足）**。

## Remaining

- 在有完整 workspace 依賴的 authoritative repo/worktree 執行有效 typecheck / lint。
- 以 Chromium 做 voice input browser smoke。
- 做 unsupported path smoke。
- 視需要補 `prompt-input` 元件級測試。

## Mobile Slice (2026-04-10)

- Beta worktree 從 main 重建（stale beta 已清理，舊的 20 commits behind 版本安全丟棄）。
- 新增檔案：
  - `packages/app/src/utils/audio-recorder.ts` — MediaRecorder-based audio capture hook
  - `packages/app/src/utils/transcribe.ts` — client-side transcription API call
- 修改檔案：
  - `packages/opencode/src/server/routes/session.ts` — 新增 `POST /:sessionID/transcribe` endpoint
  - `packages/app/src/components/prompt-input.tsx` — dual-path voice input (speech + recording)
  - `packages/app/src/i18n/en.ts`, `zht.ts` — 新增 mobile recording/transcribing i18n strings
- Architecture Impact:
  - **新增 server API 邊界**：`/session/:id/transcribe` 接受 audio multipart upload，使用 audio-capable model 做轉寫。
  - 不改變 prompt submit protocol 或 session runtime contract。
  - 轉寫結果走既有 `prompt.set()` 回填，與 desktop speech 共用同一 prompt ownership path。

## Architecture Sync

- Architecture Sync: **Needs Update** — 新增了 `POST /session/:id/transcribe` server endpoint。
- 依據：本次手機錄音實作跨越了 client/server 邊界（新增 server-side transcription endpoint），與原本的 browser-only desktop speech 不同。
