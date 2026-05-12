---
name: wsl-image-clipboard
description: Technical deep-dive on WSL2 clipboard image handling - architecture, data flow, and troubleshooting methodology. Use when debugging clipboard image issues in WSL environments.
---

# WSL Image Clipboard: Architecture & Troubleshooting

Complete technical reference for understanding how clipboard images flow from Windows to WSL applications.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Windows Host                                     │
│  ┌──────────────────┐                                                   │
│  │  Win32 Clipboard │ ← Screenshot / Copy Image                         │
│  │  (CF_BITMAP,     │                                                   │
│  │   CF_DIB, PNG)   │                                                   │
│  └────────┬─────────┘                                                   │
│           │                                                              │
│           │ OLE/COM Clipboard API                                        │
│           ▼                                                              │
│  ┌──────────────────┐                                                   │
│  │  PowerShell.exe  │  [System.Windows.Forms.Clipboard]::GetImage()     │
│  │  (STA Thread)    │  → System.Drawing.Image                           │
│  └────────┬─────────┘                                                   │
│           │                                                              │
└───────────┼──────────────────────────────────────────────────────────────┘
            │
            │ WSL Interop Layer
            │ (binfmt_misc + /init + AF_UNIX socket)
            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         WSL2 Linux VM                                    │
│                                                                          │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐   │
│  │  Bun/Node.js     │    │  base64 string   │    │  Application     │   │
│  │  child_process   │ →  │  PNG data        │ →  │  (data: URL)     │   │
│  │  spawn()         │    │  via stdout      │    │                  │   │
│  └──────────────────┘    └──────────────────┘    └──────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Layer 1: Windows Clipboard

### Clipboard Formats

Windows clipboard stores data in multiple formats simultaneously:

| Format | Description | Use Case |
|--------|-------------|----------|
| `CF_BITMAP` | Device-dependent bitmap | Legacy apps |
| `CF_DIB` | Device-independent bitmap | Most apps |
| `CF_DIBV5` | DIB with alpha channel | Modern apps |
| `PNG` | PNG binary data | Web/modern apps |
| `CF_HDROP` | File path list | File copy |

### Accessing via PowerShell

PowerShell requires **STA (Single-Threaded Apartment)** mode to access COM-based clipboard:

```powershell
# Must use -STA flag for clipboard access
powershell.exe -STA -Command "..."

# Two approaches to get image:

# 1. Get-Clipboard cmdlet (simpler, Windows 10+)
$img = Get-Clipboard -Format Image

# 2. Windows Forms API (more control)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()

# Convert to base64 PNG for transport
$ms = New-Object System.IO.MemoryStream
$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[System.Convert]::ToBase64String($ms.ToArray())
```

## Layer 2: WSL Interop

### What is WSL Interop?

WSL Interop allows Linux processes to execute Windows `.exe` files transparently. It consists of:

1. **binfmt_misc kernel module** - Linux feature to delegate binary execution
2. **/init** - Microsoft's WSL init process that bridges Linux↔Windows
3. **AF_UNIX socket** - IPC channel at `$WSL_INTEROP`

### binfmt_misc Deep Dive

```
/proc/sys/fs/binfmt_misc/
├── register        ← Write-only: register new handlers
├── status          ← enabled/disabled
├── WSLInterop      ← The Windows EXE handler
└── python3.12      ← Example: Python bytecode handler
```

**WSLInterop handler format:**
```
:WSLInterop:M::MZ::/init:PF

:name      :type:offset:magic:mask:interpreter:flags
  │          │     │     │     │       │         │
  │          │     │     │     │       │         └─ P=preserve-argv[0]
  │          │     │     │     │       │            F=open-binary (fix)
  │          │     │     │     │       └─ /init handles execution
  │          │     │     │     └─ No mask (match exact bytes)
  │          │     │     └─ "MZ" = 0x4D5A (DOS/PE header magic)
  │          │     └─ Offset 0 (start of file)
  │          └─ M = Magic bytes match
  └─ Handler name
```

**How execution works:**
```
1. User runs: powershell.exe -Command "..."
2. Kernel sees file starts with "MZ"
3. Kernel looks up binfmt_misc handlers
4. Finds WSLInterop, calls: /init powershell.exe -Command "..."
5. /init sends request over $WSL_INTEROP socket to Windows
6. Windows spawns real powershell.exe process
7. stdout/stderr piped back through socket
```

### WSL_INTEROP Socket

```bash
$ echo $WSL_INTEROP
/run/WSL/12345_interop

$ file $WSL_INTEROP
/run/WSL/12345_interop: socket
```

This AF_UNIX socket is the IPC channel between WSL's /init and the Windows host.

## Layer 3: Application Integration

### Reading Clipboard in Application Code

```typescript
// Example: opencode's clipboard.ts approach

async function readWindowsClipboard(): Promise<Buffer | undefined> {
  // 1. Check if we can run .exe
  if (!canRunWindowsExe()) return undefined

  // 2. PowerShell script to read clipboard as base64 PNG
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    if ($img) {
      $ms = New-Object System.IO.MemoryStream
      $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      [System.Convert]::ToBase64String($ms.ToArray())
    }
  `

  // 3. Execute and capture stdout
  const result = await $`powershell.exe -STA -NoProfile -Command ${script}`

  // 4. Decode base64 to binary
  return Buffer.from(result.stdout.trim(), 'base64')
}
```

### Data Flow Summary

```
Windows Clipboard (bitmap)
    ↓ [System.Windows.Forms.Clipboard]::GetImage()
System.Drawing.Image
    ↓ .Save($stream, PNG)
MemoryStream (PNG bytes)
    ↓ [Convert]::ToBase64String()
Base64 string
    ↓ stdout pipe via WSL Interop
Linux process captures stdout
    ↓ Buffer.from(string, 'base64')
Binary PNG data
    ↓ data:image/png;base64,...
Data URL for application use
```

## Troubleshooting Methodology

### Step 1: Identify the Failure Layer

```bash
# Test Layer 2 (WSL Interop)
powershell.exe -Command "echo 'interop works'"

# Test Layer 1+2 (Windows Clipboard via Interop)
powershell.exe -STA -Command "Get-Clipboard"

# Test Layer 1+2 (Image specifically)
powershell.exe -STA -Command "
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.Clipboard]::ContainsImage()
"
```

### Step 2: WSL Interop Diagnostics

```bash
# Check binfmt handler exists
ls -la /proc/sys/fs/binfmt_misc/WSLInterop

# Check handler content
cat /proc/sys/fs/binfmt_misc/WSLInterop

# Expected output:
# enabled
# interpreter /init
# flags: PF
# offset 0
# magic 4d5a    ← "MZ" in hex

# Check WSL_INTEROP socket
echo $WSL_INTEROP
ls -la $WSL_INTEROP

# Check if powershell.exe is findable
which powershell.exe
```

### Step 3: Common Failure Modes

#### A. "cannot execute binary file: Exec format error"

**Cause:** WSLInterop binfmt handler not registered

**Diagnosis:**
```bash
ls /proc/sys/fs/binfmt_misc/WSLInterop
# If "No such file" → handler missing
```

**Root cause:** WSL2 with `systemd=true` has a race condition:

```
WSL Startup Sequence:
1. /init starts, registers WSLInterop binfmt handler    ✓
2. systemd starts
3. systemd-binfmt.service runs                          ← Only loads /etc/binfmt.d/
4. WSLInterop handler is overwritten/lost               ✗
```

The WSL `/init` process registers the handler before systemd starts, but `systemd-binfmt.service` then overwrites it with only the handlers defined in `/etc/binfmt.d/` and `/usr/lib/binfmt.d/`.

**Diagnosis:**
```bash
# Check if handler exists
ls /proc/sys/fs/binfmt_misc/WSLInterop

# Check what systemd loads
ls /etc/binfmt.d/
ls /usr/lib/binfmt.d/

# Check systemd-binfmt status
systemctl status systemd-binfmt.service
```

**Fix:**
```bash
# Temporary (until reboot)
sudo sh -c 'echo ":WSLInterop:M::MZ::/init:PF" > /proc/sys/fs/binfmt_misc/register'

# Permanent - create config so systemd-binfmt preserves the handler
sudo tee /etc/binfmt.d/WSLInterop.conf << 'EOF'
:WSLInterop:M::MZ::/init:PF
EOF
```

**Verification:**
```bash
# After fix, handler should exist
ls /proc/sys/fs/binfmt_misc/WSLInterop

# And persist after: systemctl restart systemd-binfmt
```

#### B. PowerShell hangs or times out

**Cause:** WSL_INTEROP socket stale or /init crashed

**Fix:**
```powershell
# From Windows PowerShell (not WSL)
wsl --shutdown
# Then restart WSL
```

#### C. "No image in clipboard" but image was copied

**Cause 1:** Image copied from browser/app that uses different format

**Diagnosis:**
```powershell
# Check what formats are available
powershell.exe -STA -Command "
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.Clipboard]::GetDataObject().GetFormats()
"
```

**Cause 2:** STA threading not enabled

**Fix:** Ensure `-STA` flag is used with PowerShell

#### D. Works in terminal, fails in application

**Cause:** Application spawning PowerShell differently

**Debug:**
```typescript
// Add verbose logging
const result = await $`powershell.exe ...`.nothrow()
console.log('exit code:', result.exitCode)
console.log('stdout length:', result.stdout.length)
console.log('stderr:', result.stderr.toString())
```

#### E. Base64 garbage displayed on screen (TUI corruption)

**Cause:** Bun shell `$` template tag pipes stdout to terminal by default

**Symptom:** When pasting an image, the entire screen fills with base64 characters before being partially overwritten by the TUI.

**Root cause:** Bun's `$` shell behavior:
```typescript
// BAD - pipes stdout to terminal AND captures to result
const result = await $`powershell.exe ...`.nothrow()

// ALSO BAD - .quiet() suppresses capture entirely
const result = await $`powershell.exe ...`.nothrow().quiet()
// result.stdout is undefined!
```

**Fix:** Use `Bun.spawn` with explicit `stdout: "pipe"`:
```typescript
const proc = Bun.spawn(
  ["powershell.exe", "-NonInteractive", "-NoProfile", "-STA", "-Command", script],
  {
    stdout: "pipe",  // Capture without printing
    stderr: "pipe",
  }
)
const [outBuf, errBuf] = await Promise.all([
  new Response(proc.stdout).arrayBuffer(),
  new Response(proc.stderr).arrayBuffer(),
])
const exitCode = await proc.exited
const stdout = Buffer.from(outBuf).toString("utf8")
const stderr = Buffer.from(errBuf).toString("utf8")
```

**Bun shell `$` behavior summary:**

| Method | Prints to terminal | Captures output |
|--------|-------------------|-----------------|
| `$\`cmd\`` | Yes | Yes |
| `$\`cmd\`.quiet()` | No | No |
| `$\`cmd\`.text()` | No | Yes (as string) |
| `$\`cmd\`.arrayBuffer()` | No | Yes (as buffer) |
| `Bun.spawn({stdout:"pipe"})` | No | Yes (manual) |

### Step 4: Alternative Approaches

If WSL Interop is fundamentally broken:

#### Option A: File-based transfer

```bash
# Set env var pointing to a shared location
export OPENCODE_CLIPBOARD_IMAGE_PATH=/tmp/clipboard-image.png

# Windows-side script writes image to this path
# Application reads from file instead of PowerShell
```

#### Option B: OSC 52 (terminal-based)

Some terminals support OSC 52 escape sequence for clipboard. Limited to text, not images.

#### Option C: Native Linux clipboard (X11/Wayland)

If running X server (WSLg):
```bash
# Wayland
wl-paste -t image/png > /tmp/clipboard.png

# X11
xclip -selection clipboard -t image/png -o > /tmp/clipboard.png
```

## Platform Detection Logic

```typescript
function detectClipboardMethod(): 'windows' | 'wayland' | 'x11' | 'macos' | 'remote' {
  // 1. Check for remote/SSH clipboard path
  if (process.env.OPENCODE_CLIPBOARD_IMAGE_PATH) return 'remote'

  const os = platform()

  // 2. macOS
  if (os === 'darwin') return 'macos'

  // 3. Native Windows
  if (os === 'win32') return 'windows'

  // 4. WSL with working interop
  if (isWsl() && hasWslInterop()) return 'windows'

  // 5. Linux with Wayland
  if (os === 'linux' && process.env.WAYLAND_DISPLAY) return 'wayland'

  // 6. Linux with X11
  if (os === 'linux') return 'x11'

  return 'remote' // Fallback to file-based
}

function isWsl(): boolean {
  const r = release().toLowerCase()
  return (
    !!process.env.WSL_INTEROP ||
    !!process.env.WSL_DISTRO_NAME ||
    r.includes('microsoft') ||
    r.includes('wsl')
  )
}

function hasWslInterop(): boolean {
  return (
    !!process.env.WSL_INTEROP ||
    existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') ||
    Boolean(Bun.which('powershell.exe'))
  )
}
```

## Quick Reference

| Symptom | Check | Fix |
|---------|-------|-----|
| "Exec format error" | `ls /proc/sys/fs/binfmt_misc/WSLInterop` | Register binfmt handler |
| PowerShell hangs | `echo $WSL_INTEROP` | `wsl --shutdown` from Windows |
| "No image" | Run `-STA` command manually | Verify image format in clipboard |
| Works in terminal, not app | Check spawn flags | Ensure `-STA -NoProfile` |
| Base64 garbage on screen | Check shell capture method | Use `Bun.spawn` with `stdout:"pipe"` |
| Intermittent failures | Check stderr output | Add retry logic |

## References

- [WSL Interop Documentation](https://learn.microsoft.com/en-us/windows/wsl/filesystems#run-windows-tools-from-linux)
- [binfmt_misc Kernel Documentation](https://docs.kernel.org/admin-guide/binfmt-misc.html)
- [systemd-binfmt.service](https://www.freedesktop.org/software/systemd/man/systemd-binfmt.service.html)
- [Windows Clipboard Formats](https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats)
- [PowerShell STA Requirement](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_thread_jobs)
