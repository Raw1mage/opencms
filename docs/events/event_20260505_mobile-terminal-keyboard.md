# 2026-05-05 Mobile terminal keyboard overlap

## 需求

- 使用者回報：手機網頁使用 terminal 時虛擬鍵盤會蓋住 terminal，看不到自己打字。
- 使用者回報：鍵盤模式不對，像是在輸入帳號密碼的 helper，而不是 terminal/text entry。

## 範圍(IN)

- 釐清 mobile terminal focus、viewport resize、hidden textarea/input attributes 的控制路徑。
- 修正 terminal 在手機鍵盤彈出時的可視區與 focus 行為。
- 修正 mobile keyboard/autofill/inputmode 語意，避免觸發帳密 helper。

## 範圍(OUT)

- 不改 PTY backend / WebSocket protocol。
- 不改 provider/account/runtime 狀態流程。
- 不新增 fallback mechanism；只修正 terminal UI boundary。

## 任務清單

- [x] Baseline：讀 architecture 與 terminal UI 實作。
- [x] Root cause / implementation：修正 mobile viewport 與 textarea keyboard attributes。
- [x] Validation：執行前端 typecheck/lint 或 focused test。

## Debug checkpoints

### Baseline

- 症狀：手機 terminal focus 後虛擬鍵盤遮住輸入位置。
- 症狀：虛擬鍵盤模式像帳號密碼 helper，表示 terminal backing textarea 的 autocomplete/autocapitalize/inputmode contract 不適合 terminal。
- 影響範圍：`packages/app/src/components/terminal.tsx`、`packages/app/src/pages/session/terminal-panel.tsx`。

### Instrumentation Plan

- Boundary 1：Terminal host 是否有 mobile visual viewport resize/focus handling。
- Boundary 2：ghostty/xterm backing textarea 是否被設為 terminal-friendly attributes。
- Boundary 3：terminal panel height / scrollIntoView 是否在 keyboard open 後更新。

### Execution Evidence

- `Terminal` 目前 focus 時只呼叫 `term.focus()` 與 `term.textarea?.focus()`，未在 visualViewport resize 後重新 fit 或 scroll into view。
- `Terminal` 目前只監聽 window resize；手機 keyboard 常透過 `visualViewport` 改變可視區，未必等同 layout viewport resize。
- `Terminal` 目前未設定 backing textarea 的 `autocomplete/autocorrect/autocapitalize/spellcheck/inputmode/enterkeyhint` attributes。

### Root Cause

- `Terminal` 的 backing textarea 沒有宣告 terminal-friendly input attributes，mobile browser/password managers 可把它當成一般帳密輸入 surface，觸發不適合 terminal 的 helper/autofill 模式。
- Terminal resize/focus path 只依賴 `window.resize` 與 Ghostty/FitAddon container observer；mobile keyboard 打開時主要改變 `visualViewport`，terminal host 沒有在 viewport resize/scroll 後重新 fit 並把 active input 捲回可視底部。
- Implementation：`Terminal` 在綁定 UI events 時設定 textarea `autocomplete=off`、`autocorrect=off`、`autocapitalize=none`、`spellcheck=false`、`inputmode=text`、`enterkeyhint=enter`，並加上常見 password-manager ignore attributes；focus 與 `visualViewport` resize/scroll 時重新 fit 並 `scrollIntoView({ block: "end" })`。

### Validation

- `bun --filter @opencode-ai/app typecheck`：passed。
- `bun eslint "packages/app/src/components/terminal.tsx"`：passed。
- Manual code-path validation：修補只作用於 frontend terminal component；PTY backend/WebSocket protocol 未變更。

## Architecture Sync

- Updated `specs/architecture.md` Frontend terminal/mobile boundary to record backing textarea keyboard attributes and visualViewport handling.

## XDG backup

- Created pre-edit whitelist backup: `/home/pkcs12/.config/opencode.bak-20260505-1615-mobile-terminal-keyboard/`.
