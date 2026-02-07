#### 功能：RCA for Clipboard Issue

**需求**
- 分析為何 Ctrl+V 無法貼上圖片
- 加入 debug logs 以驗證原因
- 產出 RCA 報告

**範圍**
- IN: `src/cli/cmd/tui/component/prompt/index.tsx`, `src/cli/cmd/tui/util/clipboard.ts`
- OUT: 無

**方法**
1. 在 `prompt/index.tsx` 的 key handler 中加入 log
2. 在 `clipboard.ts` 的 `readRemoteImage` 中加入 log
3. 請用戶重現並分析 log

**任務**
- [ ] 加入 debug logs
- [ ] 分析 log
- [ ] 撰寫 RCA

**待解問題**
- 無
