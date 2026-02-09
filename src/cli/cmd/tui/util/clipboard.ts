import { $ } from "bun"
import { Env } from "@/env"
import { platform, release } from "os"
import clipboardy from "clipboardy"
import { lazy } from "../../../../util/lazy.js"
import { debugCheckpoint } from "../../../../util/debug"
import { tmpdir } from "os"
import path from "path"
import { stat } from "fs/promises"
import { existsSync } from "fs"

function isWsl(): boolean {
  // Bun/Node on WSL reports platform() === "linux".
  // release() typically contains "microsoft" (e.g. "...microsoft-standard-WSL2+").
  const r = release().toLowerCase()
  return (
    !!Env.get("WSL_INTEROP") ||
    !!Env.get("WSL_DISTRO_NAME") ||
    !!Env.get("WSLENV") ||
    r.includes("microsoft") ||
    r.includes("wsl")
  )
}

function hasWslInterop(): boolean {
  // Some environments expose WSL-ish env vars but cannot execute Windows .exe.
  // Check multiple indicators of working WSL interop:
  // 1. WSL_INTEROP env var (set when interop socket is available)
  // 2. binfmt handler path (may not exist on all WSL2 configurations)
  // 3. powershell.exe is actually in PATH (most reliable)
  return (
    !!Env.get("WSL_INTEROP") ||
    existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") ||
    Boolean(Bun.which("powershell.exe"))
  )
}

function normalizeBase64(input: string): string | undefined {
  const cleaned = input.replace(/\s+/g, "").trim()
  if (!cleaned) return
  if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) return
  return cleaned
}

function detectMimeType(buffer: Buffer): string | undefined {
  if (buffer.length < 12) return undefined

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png"
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg"
  }

  // GIF: GIF87a or GIF89a
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return "image/gif"
  }

  // WebP: RIFF ... WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp"
  }

  return undefined
}

function parseDataUrl(input: string): { data: string; mime: string } | undefined {
  const match = input.match(/^data:([^;]+);base64,(.*)$/)
  if (!match) return
  const mime = match[1]
  if (!mime?.startsWith("image/")) return
  const data = normalizeBase64(match[2] ?? "")
  if (!data) return
  return { data, mime }
}

async function readRemoteImage(): Promise<Clipboard.Content | undefined> {
  const filepath = Env.get("OPENCODE_CLIPBOARD_IMAGE_PATH")
  debugCheckpoint("clipboard", "readRemoteImage:check", {
    hasEnv: !!filepath,
    filepath,
  })

  if (!filepath) return

  const info = await stat(filepath).catch(() => undefined)
  debugCheckpoint("clipboard", "readRemoteImage:stat", {
    exists: !!info,
    size: info?.size,
    mtime: info?.mtimeMs,
  })
  if (!info) return

  const ttl = Number(Env.get("OPENCODE_CLIPBOARD_IMAGE_TTL_MS") ?? "30000")
  if (Number.isFinite(ttl) && ttl > 0 && Date.now() - info.mtimeMs > ttl) return

  const file = Bun.file(filepath)
  const buffer = Buffer.from(await file.arrayBuffer())
  const mime = detectMimeType(buffer)
  if (mime) return { data: buffer.toString("base64"), mime }

  const text = buffer.toString("utf8").trim()
  const dataUrl = parseDataUrl(text)
  if (dataUrl) return dataUrl

  const base64 = normalizeBase64(text)
  if (!base64) return
  const decoded = Buffer.from(base64, "base64")
  const decodedMime = detectMimeType(decoded)
  if (!decodedMime) return
  return { data: decoded.toString("base64"), mime: decodedMime }
}

/**
 * Writes text to clipboard via OSC 52 escape sequence.
 * This allows clipboard operations to work over SSH by having
 * the terminal emulator handle the clipboard locally.
 */
function writeOsc52(text: string): void {
  if (!process.stdout.isTTY) return
  const base64 = Buffer.from(text).toString("base64")
  const osc52 = `\x1b]52;c;${base64}\x07`
  // tmux and screen require DCS passthrough wrapping
  const passthrough = Env.get("TMUX") || Env.get("STY")
  const sequence = passthrough ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52
  process.stdout.write(sequence)
}

export namespace Clipboard {
  export interface Content {
    data: string
    mime: string
  }

  export async function read(): Promise<Content | undefined> {
    debugCheckpoint("clipboard", "read:start", {
      hasRemotePath: Boolean(Env.get("OPENCODE_CLIPBOARD_IMAGE_PATH")),
      platform: platform(),
    })

    const remote = await readRemoteImage()
    if (remote) {
      debugCheckpoint("clipboard", "read:remote", {
        mime: remote.mime,
        dataLength: remote.data.length,
      })
      return remote
    }

    const os = platform()

    if (os === "darwin") {
      const tmpfile = path.join(tmpdir(), "opencode-clipboard.png")
      try {
        await $`osascript -e 'set imageData to the clipboard as "PNGf"' -e 'set fileRef to open for access POSIX file "${tmpfile}" with write permission' -e 'set eof fileRef to 0' -e 'write imageData to fileRef' -e 'close access fileRef'`
          .nothrow()
          .quiet()
        const file = Bun.file(tmpfile)
        const buffer = await file.arrayBuffer()
        const data = Buffer.from(buffer).toString("base64")
        debugCheckpoint("clipboard", "read:darwin", { mime: "image/png", dataLength: data.length })
        return { data, mime: "image/png" }
      } catch {
      } finally {
        await $`rm -f "${tmpfile}"`.nothrow().quiet()
      }
    }

    if (os === "linux") {
      const types = ["image/gif", "image/webp", "image/png", "image/jpeg"]

      const hasWlPaste = Boolean(Bun.which("wl-paste"))
      const hasXclip = Boolean(Bun.which("xclip"))

      // Try Wayland first
      if (Env.get("WAYLAND_DISPLAY")) {
        if (!hasWlPaste) {
          debugCheckpoint("clipboard", "read:wayland:missing_wl_paste", {
            waylandDisplay: Env.get("WAYLAND_DISPLAY"),
          })
        }
        for (const mime of types) {
          if (!hasWlPaste) break
          const wayland = await $`wl-paste -t ${mime}`.nothrow().arrayBuffer()
          if (wayland && wayland.byteLength > 0) {
            const data = Buffer.from(wayland).toString("base64")
            debugCheckpoint("clipboard", "read:wayland", { mime, dataLength: data.length })
            return { data, mime }
          }
        }
      }

      // Try X11
      if (!hasXclip) {
        debugCheckpoint("clipboard", "read:x11:missing_xclip")
      }
      for (const mime of types) {
        if (!hasXclip) break
        const x11 = await $`xclip -selection clipboard -t ${mime} -o`.nothrow().arrayBuffer()
        if (x11 && x11.byteLength > 0) {
          const data = Buffer.from(x11).toString("base64")
          debugCheckpoint("clipboard", "read:x11", { mime, dataLength: data.length })
          return { data, mime }
        }
      }
    }

    // Windows clipboard (only when .exe execution is supported)
    if (os === "win32" || (isWsl() && hasWslInterop())) {
      const hasPowerShell = Boolean(Bun.which("powershell.exe"))
      debugCheckpoint("clipboard", "read:wsl_check", {
        os,
        release: release(),
        hasPowerShell,
        hasWslInterop: os === "win32" ? undefined : hasWslInterop(),
      })

      if (hasPowerShell) {
        // NOTE: Clipboard APIs require STA.
        const scripts = [
          {
            variant: "get-clipboard",
            script:
              "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; $img = Get-Clipboard -Format Image -ErrorAction SilentlyContinue; if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }",
          },
          {
            variant: "winforms",
            script:
              "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [System.Convert]::ToBase64String($ms.ToArray()) }",
          },
        ]

        for (const { variant, script } of scripts) {
          let stdout = ""
          let stderr = ""
          let exitCode = 0
          try {
            // Use quiet() to prevent output to terminal, then manually capture via Bun.spawn
            const proc = Bun.spawn(["powershell.exe", "-NonInteractive", "-NoProfile", "-STA", "-Command", script], {
              stdout: "pipe",
              stderr: "pipe",
            })
            const [outBuf, errBuf] = await Promise.all([
              new Response(proc.stdout).arrayBuffer(),
              new Response(proc.stderr).arrayBuffer(),
            ])
            exitCode = await proc.exited
            stdout = Buffer.from(outBuf).toString("utf8")
            stderr = Buffer.from(errBuf).toString("utf8")
          } catch (error) {
            debugCheckpoint("clipboard", "read:powershell:spawn_error", {
              variant,
              error: String(error),
            })
            break
          }

          debugCheckpoint("clipboard", "read:powershell", {
            variant,
            exitCode,
            stdoutLen: stdout.length,
            stderrLen: stderr.length,
            stderrSample: stderr.slice(0, 200),
          })

          const base64 = normalizeBase64(stdout)
          if (!base64) continue
          const imageBuffer = Buffer.from(base64, "base64")
          const mime = detectMimeType(imageBuffer)
          if (!mime) continue

          const data = imageBuffer.toString("base64")
          debugCheckpoint("clipboard", "read:win32", { mime, dataLength: data.length })
          return { data, mime }
        }
      }
    }

    const text = await clipboardy.read().catch(() => {})
    if (text) {
      debugCheckpoint("clipboard", "read:text", { mime: "text/plain", dataLength: text.length })
      return { data: text, mime: "text/plain" }
    }
    debugCheckpoint("clipboard", "read:empty")
  }

  const getCopyMethod = lazy(() => {
    const os = platform()

    if (os === "darwin" && Bun.which("osascript")) {
      return async (text: string) => {
        const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        await $`osascript -e 'set the clipboard to "${escaped}"'`.nothrow().quiet()
      }
    }

    if (os === "linux") {
      if (Env.get("WAYLAND_DISPLAY") && Bun.which("wl-copy")) {
        return async (text: string) => {
          const proc = Bun.spawn(["wl-copy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }
      if (Bun.which("xclip")) {
        return async (text: string) => {
          const proc = Bun.spawn(["xclip", "-selection", "clipboard"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          })
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }
      if (Bun.which("xsel")) {
        return async (text: string) => {
          const proc = Bun.spawn(["xsel", "--clipboard", "--input"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          })
          proc.stdin.write(text)
          proc.stdin.end()
          await proc.exited.catch(() => {})
        }
      }
    }

    if (os === "win32") {
      return async (text: string) => {
        // Pipe via stdin to avoid PowerShell string interpolation ($env:FOO, $(), etc.)
        const proc = Bun.spawn(
          [
            "powershell.exe",
            "-NonInteractive",
            "-NoProfile",
            "-Command",
            "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
          ],
          {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          },
        )

        proc.stdin.write(text)
        proc.stdin.end()
        await proc.exited.catch(() => {})
      }
    }

    return async (text: string) => {
      await clipboardy.write(text).catch(() => {})
    }
  })

  export async function copy(text: string): Promise<void> {
    writeOsc52(text)
    await getCopyMethod()(text)
  }
}
