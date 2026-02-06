<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
paru -S opencode-bin               # Arch Linux
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, or AppImage           |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_HOME` or `$XDG_BIN_DIR` - XDG Base Directory Specification compliant paths
3. `$HOME/.local/bin` - Default fallback for Unix systems
4. `$LOCALAPPDATA/bin` - Default fallback for Windows

```bash
# Examples
# Install to system-wide directory (requires sudo)
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash

# Install to XDG compliant directory
XDG_BIN_HOME=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

<!-- @event_2026-02-07_install -->

### Local build + install

使用原始碼編譯後可透過 Bun 一次完成建置與安裝：

```bash
bun run install
```

此命令會：

1. 執行 `bun run build --single --skip-install`，為當前作業系統與架構產生 native binary。
2. 將對應的 `dist/opencode-<platform>-<arch>/bin/opencode` 拷貝進上方指定的安裝目錄（預設為 `~/.local/bin`）。
3. 設定可執行權限，若安裝目錄需要 root 權限會顯式提示您使用 `sudo` 重新執行。
4. **清理與初始化 XDG 目錄**：
   - 依 `templates/manifest.json` 的 `target`（config/state/data）初始化設定檔。
   - 自動將 legacy `~/.opencode/` 與 XDG 目錄內非必要雜物移至 `~/.local/state/opencode/cyclebin/`。
   - 補齊必要的預設設定檔（僅在目標檔案不存在時寫入），包括帳號、認證、模型忽略清單、AGENTS 規範等。

#### XDG 配置說明

根據 `templates/manifest.json`，以下是 XDG 目錄結構與關鍵檔案：

| 位置                      | 檔案/資料夾                      | 用途描述                                             | 備註             |
| :------------------------ | :------------------------------- | :--------------------------------------------------- | :--------------- |
| `~/.config/opencode`      | `accounts.json`                  | 主要帳號資訊、權杖 (Tokens) 與配額狀態。             | **敏感檔案**     |
| `~/.config/opencode`      | `mcp-auth.json`                  | MCP 伺服器連線憑證。                                 | **敏感檔案**     |
| `~/.config/opencode`      | `opencode.json`                  | 全域使用者設定檔（Provider、Keybinds、Plugins 等）。 |                  |
| `~/.config/opencode`      | `AGENTS.md`                      | 定義 AI Agent 的全域指令與行為規範。                 |                  |
| `~/.config/opencode`      | `CONFIG-README.md`               | 設定檔說明與範例。                                   |                  |
| `~/.local/state/opencode` | `ignored-models.json`            | 模型選擇或自動輪詢中應忽略的模型清單。               |                  |
| `~/.local/state/opencode` | `cyclebin/`                      | 安裝程序清理出的過時或不明檔案。                     | **Runtime 產生** |
| `~/.local/share/opencode` | `package.json` / `node_modules/` | 自定義工具或插件安裝位置。                           |                  |
| `~/.local/share/opencode` | `generated-images/`              | 生成圖片輸出。                                       | **Runtime 產生** |
| `~/.local/share/opencode` | `log/`                           | 系統執行軌跡與錯誤診斷資訊。                         | **Runtime 產生** |

如需覆寫安裝路徑，請事先設定 `OPENCODE_INSTALL_DIR` 或 `XDG_BIN_DIR`，安裝腳本會依照與官方安裝相同的優先順序決定安裝位置。

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also, included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as a part of its name; for example, "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

### FAQ

#### How is this different from Claude Code?

It's very similar to Claude Code in terms of capability. Here are the key differences:

- 100% open source
- Not coupled to any provider. Although we recommend the models we provide through [OpenCode Zen](https://opencode.ai/zen); OpenCode can be used with Claude, OpenAI, Google or even local models. As models evolve the gaps between them will close and pricing will drop so being provider-agnostic is important.
- Out of the box LSP support
- A focus on TUI. OpenCode is built by neovim users and the creators of [terminal.shop](https://terminal.shop); we are going to push the limits of what's possible in the terminal.
- A client/server architecture. This for example can allow OpenCode to run on your computer, while you can drive it remotely from a mobile app. Meaning that the TUI frontend is just one of the possible clients.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
