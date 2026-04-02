# Event: SSH Authkey Not Working — Windows Antigravity Remote SSH

**Date**: 2026-04-03  
**Status**: ✅ RESOLVED

---

## 需求與背景

用戶從 Windows Antigravity (VS Code Remote-SSH) 連線 Linux server，已將 public key 加入 `authorized_keys`，但每次連線仍走密碼驗證（`Accepted password`）而非金鑰驗證。

---

## RCA (Root Cause Analysis)

### 調查過程

1. **檢查 `sshd_config`**：`PubkeyAuthentication` 雖為註解，但預設值為 `yes`，server 端設定正確。
2. **讀取 SSH 認證 log** (`journalctl -u ssh`)：
   - Apr 02 16:00–17:23 → `Accepted publickey`（VS Code Remote-SSH 正常使用 key）
   - Apr 02 22:58 之後 → `Accepted password`（切換 Antigravity 後改走密碼）

### 結論

**問題不在 server 端**，而是 **Windows client 端未設定 SSH config**，導致 Antigravity 連線時找不到對應的 private key，自動 fallback 密碼驗證。

- Server `~/.ssh/` 權限正確（`drwx------` / `-rw-------`）
- `authorized_keys` 已含正確 ED25519 public key
- 問題根源：**`C:\Users\yeats\.ssh\config` 缺少 `IdentityFile` 指定**

---

## 修復方案

在 Windows `%USERPROFILE%\.ssh\config` 新增：

```
Host rawbase
    HostName 192.168.125.117
    User pkcs12
    Port 22
    IdentityFile %USERPROFILE%\.ssh\id_ed25519
    PreferredAuthentications publickey
```

PowerShell 一鍵執行版已提供給用戶，用戶已確認執行完成。

---

## Debug Checkpoint: Validation

- **修改前**：`Accepted password for pkcs12 from 192.168.112.1`
- **修改後**：預期 log 應出現 `Accepted publickey for pkcs12 from 192.168.112.1`
- **驗證指令**：`sudo journalctl -u ssh --no-pager -n 10 | grep pkcs12`
- **已知噪音豁免**：其他 IP 的掃描連線（`invalid user`）不影響結果
