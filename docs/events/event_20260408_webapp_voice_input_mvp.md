# Event: webapp voice input MVP

Date: 2026-04-08
Status: Build In Progress (Validation Blocked)
Plan Root: `plans/20260408_webapp/`

## 需求

- 使用者希望為 webapp 的文字輸入框新增語音輸入功能。
- 經討論後，先做 browser-only 的快速版，優先驗證體驗與整合可行性。

## 範圍 (IN/OUT)

- IN:
  - `packages/app/src/components/prompt-input.tsx` 的 mic control、錄音中狀態、unsupported/error 提示。
  - 沿用 `packages/app/src/utils/speech.ts` 與 `packages/app/src/utils/runtime-adapters.ts`。
  - 將 final transcript 安全回寫到 canonical prompt state。
  - 最小必要的測試與手動驗證規劃。
- OUT:
  - 後端 STT / Whisper / provider audio transcription。
  - 音訊錄製檔案上傳、附件化、儲存或回放。
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

## Architecture Sync

- Architecture Sync: Verified (No doc changes).
- 依據：本次實作僅在既有 webapp `prompt-input` 內整合 browser speech helper，未改變 repo 的長期模組邊界、資料流層級、server/API 邊界或 runtime architecture。
