---
name: antigravity-browser-fix
description: Diagnose and fix common Antigravity browser automation issues on Linux, specifically Snap Chromium timeouts and filesystem conflicts.
---

# Antigravity Browser Fix

This skill contains the troubleshooting steps and fixes for the common issue where Antigravity cannot launch or control the web browser on Linux systems. This often manifests as `ECONNREFUSED 127.0.0.1:9222` or timeouts when using the `browser_subagent`.

## Root Causes
1.  **Snap Chromium:** Ubuntu/Linux often defaults to the "Snap" version of Chromium. This version is sandboxed and slow to start (>5s), causing Antigravity's connection attempts to time out.
2.  **Filesystem Conflicts:** Sometimes `~/.local/share/applications` exists as a file instead of a directory, preventing browser profile creation.
3.  **Pathing Issues:** Tools look for `chromium` or `chromium-browser`, but only `google-chrome` (native) is installed or functional.

## Workflow

Follow these steps to diagnose and fix the environment.

### 1. Diagnostic Checks

Run the following commands to assess the current state:

```bash
# Check if Chromium is a Snap package
which chromium
ls -l /snap/bin/chromium

# Check for filesystem conflict
ls -ld ~/.local/share/applications

# Check current browser version responsiveness
chromium --version
```

### 2. File System Repair
If `~/.local/share/applications` is a file (not a directory), fix it immediately:

```bash
# Backup existing file
mv ~/.local/share/applications ~/.local/share/applications.bak

# Create correct directory structure
mkdir -p ~/.local/share/applications

# Move backup into directory if needed (or just leave it as backup)
mv ~/.local/share/applications.bak ~/.local/share/applications/backup_file
```

### 3. The "Snap" Fix (Recommended)
The most reliable fix is to replace the slow Snap Chromium with the native Google Chrome via symlinks.

**Step A: Remove Snap Chromium (Requires Sudo)**
Ask the user to run:
```bash
sudo snap remove chromium
```

**Step B: Link Google Chrome (Requires Sudo)**
Force the system to use Google Chrome whenever `chromium` is requested. Ask the user to run:
```bash
sudo ln -sf /usr/bin/google-chrome /usr/bin/chromium
sudo ln -sf /usr/bin/google-chrome /usr/bin/chromium-browser
```

### 4. Verification
After applying fixes, verify the solution:

1.  Check that `chromium --version` now reports "Google Chrome ...".
2.  Run a simple `browser_subagent` task (e.g., "Open google.com and tell me the title").

## Auto-Run Script
If the user grants permission to run `sudo` commands, you can execute this sequence:

```bash
# 1. Fix User Directories
if [ -f "$HOME/.local/share/applications" ]; then
    mv "$HOME/.local/share/applications" "$HOME/.local/share/applications_backup"
    mkdir -p "$HOME/.local/share/applications"
fi

# 2. Setup Links (Assumes User will run these or has provided sudo access)
# sudo snap remove chromium
# sudo ln -sf /usr/bin/google-chrome /usr/bin/chromium
# sudo ln -sf /usr/bin/google-chrome /usr/bin/chromium-browser
```
