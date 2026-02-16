#### 功能：修復剪貼簿貼圖（GIF/Sticker）支援

**問題摘要**

- 使用者回報「貼圖功能消失」，無法貼上 GIF 或其他非 PNG 圖片。
- 經查 `src/cli/cmd/tui/util/clipboard.ts` 僅支援 `image/png` 且強制檢查 PNG header，導致 GIF/WebP/JPEG 被拒絕或無法讀取。
- Linux 環境下 `wl-paste` 與 `xclip` 僅請求 `image/png`，導致動圖變靜態或失敗。

**根本原因**

- 2026-02-04 的修復「invalid image data」引入了嚴格的 `isPng` 檢查，排除了其他合法影像格式。
- Linux 剪貼簿讀取邏輯未嘗試 `image/gif` 等格式。

**修復重點**

- 替換 `isPng` 為 `detectMimeType`，支援 PNG/JPEG/GIF/WebP 簽名檢查。
- 更新 `readRemoteImage` 支援多種影像格式。
- 更新 Linux (`wl-paste`/`xclip`) 讀取邏輯，優先嘗試 GIF/WebP 以保留動畫，再嘗試 PNG/JPEG。
- Windows/WSL 仍維持 PNG 轉換（PowerShell 限制），但在讀取後透過 `detectMimeType` 驗證。

**驗證**

- [x] `detectMimeType` 正確識別各類影像 header。
- [x] Linux 剪貼簿讀取迴圈優先嘗試動圖格式。
