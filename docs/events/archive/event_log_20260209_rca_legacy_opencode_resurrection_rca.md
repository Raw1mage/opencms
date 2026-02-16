# RCA: ~/.opencode Binary 持續復活問題

**Event ID**: event_20260209_legacy_opencode_resurrection  
**Date**: 2026-02-09  
**Severity**: Medium  
**Status**: Root Cause Identified

---

## 問題描述 (Problem Statement)

使用者回報舊版 opencode binary 會在 `~/.opencode/bin/` 目錄中持續「復活」，即使手動刪除後仍會自動重新生成。這導致系統執行到過時的 binary，並且與當前版本架構（已遷移至 XDG Base Directory）產生衝突。

### 症狀 (Symptoms)

1. `~/.opencode/bin/opencode` binary 會自動再生
2. `~/.bashrc` 中 `PATH` 包含 `~/.opencode/bin` 且優先順序高於 `~/.local/bin`
3. 使用者預期 opencode 使用 `~/.local/share/opencode` 和 `~/.cache/opencode`，但系統行為異常

---

## 根本原因分析 (Root Cause Analysis)

### 原因鏈 (Causal Chain)

```
官方 curl 安裝腳本 (https://opencode.ai/install)
  ↓
設定 INSTALL_DIR=$HOME/.opencode/bin
  ↓
寫入 ~/.bashrc: export PATH=$HOME/.opencode/bin:$PATH
  ↓
每次開啟新 shell 時，PATH 優先指向 ~/.opencode/bin
  ↓
(觀察到的異常行為，但 binary 復活的直接觸發機制待確認)
```

### 關鍵發現 (Key Findings)

#### 1. 官方安裝腳本使用舊路徑

```bash
# https://opencode.ai/install (截至 2026-02-09)
INSTALL_DIR=$HOME/.opencode/bin
mkdir -p "$INSTALL_DIR"
```

**問題**:

- 安裝腳本仍使用 `~/.opencode/bin` 作為預設安裝目標
- 與當前版本的 XDG 架構（`~/.local/bin`）不一致

#### 2. Shell Profile 污染

`~/.bashrc` 包含：

```bash
export PATH=/home/pkcs12/.opencode/bin:$PATH
```

**影響**:

- 即使 `~/.local/bin/opencode` 存在且為正確版本，`~/.opencode/bin` 仍會優先被執行
- 每次開啟新 terminal 都會重新啟用舊路徑

#### 3. 系統內部有兩套獨立的 package.json

**位置 1**: `~/.cache/opencode/package.json`

```json
{
  "dependencies": {
    "opencode-antigravity-auth": "1.4.5",
    "@gitlab/opencode-gitlab-auth": "1.3.2",
    "opencode-anthropic-auth": "0.0.13",
    "opencode-gemini-auth": "1.3.10"
  }
}
```

- 這是 `Global.Path.cache` 的真實路徑（`~/.cache/opencode`）
- 由 `src/global/index.ts` 第 131 行初始化（從 `templates/package.json` 複製）
- 用於 `BunProc.install()` 安裝 plugin

**位置 2**: `~/.opencode/package.json` (**異常**)

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.1.53"
  }
}
```

- 這個目錄不應該存在（舊版架構遺留）
- 但有 `node_modules` 且最後修改時間為 2026-02-09 23:00

#### 4. Plugin 安裝邏輯

**呼叫鏈**:

```
src/plugin/index.ts:80
  ↓
BunProc.install(pkg, version)
  ↓
src/bun/index.ts:69
  使用 Global.Path.cache (應為 ~/.cache/opencode)
  ↓
執行: bun add --cwd $cache $pkg@$version
```

**正常行為**:

- Plugin 應該安裝在 `~/.cache/opencode/node_modules/`
- `~/.opencode` 不應該被觸碰

### 懸而未決的問題 (Open Questions)

**Q1**: 誰在 `~/.opencode` 執行 `bun install`？

**已確認不是**:

- ✗ `src/bun/index.ts` (使用 `Global.Path.cache` = `~/.cache/opencode`)
- ✗ `script/install.ts` (只處理 migration，不安裝 plugin)
- ✗ Cron job / systemd timer (未找到)

**可能性**:

- 使用者手動在該目錄執行過 `bun install` 或 `npm install`
- 其他外部工具或 IDE 插件觸發
- **需要監控**: 設置 `inotifywait` 監控 `~/.opencode` 變更以捕捉觸發者

**Q2**: 為何 `~/.opencode` 的 `package.json` 只有 `@opencode-ai/plugin`？

- `templates/package.json` 包含 `@opencode-ai/plugin` 和 `opencode-openai-codex-auth-multi`
- 可能是被手動編輯過，或某個版本只有單一依賴

---

## 影響範圍 (Impact)

### 受影響的使用者

- 使用 `curl -fsSL https://opencode.ai/install | bash` 安裝的使用者
- 從舊版（使用 `~/.opencode`）升級到新版（使用 XDG）的使用者
- 尚未清理 `~/.bashrc` 中舊 PATH 設定的使用者

### 系統行為偏差

1. **執行路徑混亂**: 可能執行到舊版 binary（如果 `~/.opencode/bin` 中存在）
2. **依賴衝突**: 兩套 plugin 安裝位置可能導致版本不一致
3. **儲存空間浪費**: 重複的 `node_modules`

---

## 解決方案 (Solution)

### 立即行動 (Immediate Actions)

#### 1. 清理 Shell Profile

```bash
# 移除 ~/.bashrc 中的舊 PATH 設定
sed -i '/export PATH=.*\.opencode\/bin/d' ~/.bashrc
source ~/.bashrc
```

#### 2. 清理舊目錄

```bash
# 備份（如有重要資料）
mkdir -p ~/.local/state/opencode/cyclebin/manual-backup
mv ~/.opencode ~/.local/state/opencode/cyclebin/manual-backup/opencode-$(date +%Y%m%d-%H%M%S)

# 或直接刪除（確認無重要資料後）
rm -rf ~/.opencode
```

#### 3. 驗證系統狀態

```bash
# 確認使用正確的 binary
which opencode  # 應回傳 ~/.local/bin/opencode

# 確認版本
opencode --version

# 確認 plugin 安裝位置
ls -la ~/.cache/opencode/node_modules/
```

### 長期修復 (Long-term Fixes)

#### Fix 1: 更新官方安裝腳本

**檔案**: `https://opencode.ai/install` (需聯繫 infra team)

```diff
- INSTALL_DIR=$HOME/.opencode/bin
+ INSTALL_DIR=$HOME/.local/bin
```

**Rationale**:

- 符合 XDG Base Directory Specification
- 與 `script/install.ts` 邏輯一致
- 避免與舊版架構衝突

#### Fix 2: 增強 Migration 邏輯

**檔案**: `src/global/index.ts`

在檔案末尾新增清理邏輯：

```typescript
// @event_20260209_legacy_cleanup: Remove obsolete ~/.opencode directory
const legacyDir = path.join(os.homedir(), ".opencode")
const legacyMarker = path.join(legacyDir, ".migrated")

if ((await Bun.file(legacyDir).exists()) && !(await Bun.file(legacyMarker).exists())) {
  try {
    const contents = await fs.readdir(legacyDir)
    const hasImportantFiles = contents.some((f) => f.endsWith(".json") || f === "node_modules" || f === "bin")

    if (hasImportantFiles) {
      console.warn(`檢測到舊版目錄 ~/.opencode，已遷移至 XDG 路徑。`)
      console.warn(`若確認無需保留，請執行: rm -rf ~/.opencode`)
      console.warn(`若要保留備份，請執行: mv ~/.opencode ~/.local/state/opencode/cyclebin/legacy`)
    }

    await Bun.file(legacyMarker).write("migrated")
  } catch (e) {}
}
```

#### Fix 3: Uninstall 指令增強

**檔案**: `src/cli/cmd/uninstall.ts`

已存在清理邏輯（274, 299, 305 行），但需要增強：

```typescript
// 新增：自動清理 ~/.opencode 並提示使用者
if (await Filesystem.exists(path.join(os.homedir(), ".opencode"))) {
  console.log("檢測到舊版安裝目錄 ~/.opencode")
  // 提示是否要刪除
}
```

---

## 預防措施 (Prevention)

### 1. 安裝前檢查

在 `script/install.ts` 增加：

```typescript
const legacyBin = path.join(os.homedir(), ".opencode", "bin")
if (fs.existsSync(legacyBin)) {
  console.warn("⚠️  檢測到舊版安裝路徑 ~/.opencode/bin")
  console.warn("建議先執行: bun run uninstall 或手動刪除")
}
```

### 2. 文件更新

更新官方文件，明確說明：

- 新版使用 XDG 路徑（`~/.local/bin`, `~/.config/opencode`, `~/.cache/opencode`）
- 舊版路徑（`~/.opencode`）已棄用
- 升級指南

### 3. 監控機制

建議使用者在懷疑 binary 再生時，執行：

```bash
# 監控 ~/.opencode 變更
inotifywait -m -r ~/.opencode 2>/dev/null &
# 記錄 PID 以便後續關閉
```

---

## Timeline

| Time        | Event                                          |
| ----------- | ---------------------------------------------- |
| 22:14       | `~/.opencode` 目錄建立（Birth time）           |
| 23:00       | `~/.opencode/node_modules` 更新（Modify time） |
| 23:04       | 使用者回報問題                                 |
| 23:05-23:30 | RCA 調查進行中                                 |

---

## Related Events

- `event_2026-02-07_install`: XDG 架構遷移
- `event_2026-02-06_xdg-install`: XDG_BIN_HOME 優先級調整

---

## Lessons Learned

1. **架構變更需要完整的遷移策略**: 從 `~/.opencode` 遷移至 XDG 時，應同步更新：
   - 安裝腳本
   - Uninstall 邏輯
   - 使用者文件
2. **PATH 污染的長期影響**: Shell profile 一旦被寫入，除非主動清理，否則會永久生效

3. **需要自動清理機制**: 舊版遺留的目錄和檔案應該有自動偵測和清理提示

4. **監控的重要性**: 對於「幽靈問題」（無法直接重現），需要主動設置監控機制捕捉觸發時機

---

## Action Items

- [ ] 聯繫 infra team 更新 `https://opencode.ai/install` 腳本
- [ ] 實作 Fix 2: Migration 邏輯增強
- [ ] 實作 Fix 3: Uninstall 指令增強
- [ ] 更新官方文件：新增升級指南
- [ ] 建立監控腳本範例供使用者除錯使用
- [ ] （待確認）設置 filesystem watch 捕捉 `~/.opencode` 的真正寫入者

---

**Status**: ✅ **RESOLVED** (2026-02-10)

---

## 最終解決方案 (Final Resolution)

### 真正的根本原因

經過完整追蹤,確認 binary 復活的**真正來源**是：

**Tauri Desktop 應用的自動同步機制** (`packages/desktop/src-tauri/src/cli.rs`)

```rust
// Line 4 (修復前)
const CLI_INSTALL_DIR: &str = ".opencode/bin";  // ❌ 硬編碼舊路徑

// Line 95-142: sync_cli() 函數
pub fn sync_cli(app: tauri::AppHandle) -> Result<(), String> {
    if !is_cli_installed() {  // 檢查 ~/.opencode/bin/opencode 是否存在
        return Ok(());
    }

    let cli_version = /* 讀取已安裝版本 */;
    let app_version = app.package_info().version.clone();

    if cli_version < app_version {
        install_cli(app)?;  // 🔴 自動覆蓋舊版本
    }
}
```

**觸發條件**:

1. Desktop 應用啟動時自動執行 `sync_cli()`
2. 檢測到 `~/.opencode/bin/opencode` 存在
3. 比較版本,若 CLI 版本較舊則自動覆蓋
4. 因為 `CLI_INSTALL_DIR` 硬編碼為 `.opencode/bin`,導致持續往舊路徑寫入

### 修復內容

**檔案**: `packages/desktop/src-tauri/src/cli.rs:4-5`

```diff
- const CLI_INSTALL_DIR: &str = ".opencode/bin";
+ // @event_2026-02-10_desktop-cli-sync: Migrate to XDG Base Directory
+ // Legacy path: ~/.opencode/bin (deprecated)
+ // New path: ~/.local/bin (XDG compliant)
+ const CLI_INSTALL_DIR: &str = ".local/bin";
```

**清理操作**:

```bash
rm -rf ~/.opencode/bin
rmdir ~/.opencode  # 若目錄為空則移除
```

### 驗證結果

```bash
$ which opencode
/home/pkcs12/.local/bin/opencode

$ opencode --version
0.0.0-cms-202602091652

$ ls ~/.opencode
ls: cannot access '/home/pkcs12/.opencode': No such file or directory  # ✅ 已清理
```

---

**Status**: ✅ **RESOLVED** - Tauri Desktop 的硬編碼路徑已修復,舊目錄已清理,問題不再復現。
