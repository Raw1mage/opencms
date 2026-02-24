# Web Terminal PTY Connectivity and Rendering Fixes

**Date:** 2026-02-24

## 📌 Context
The `Terminal` component in the web application suffered from a severe connectivity regression. In a recent iteration, the application stopped emitting real-time feedback; anything the user typed in the interactive shell yielded no display. Output was only visible when the user forcibly refreshed the browser tab. Additionally, opening a new terminal tab occasionally dumped an incomprehensible string of binary artifacts including JSON payloads like `{"cursor": X}`, or inappropriately triggered `(reverse-i-search)` modes in `bash`.

## 🚨 Root Cause Analysis (Corrected)

Initial diagnosis (by Gemini) was incorrect — it fabricated three architectural flaws that did not exist in the code. The actual root causes were two distinct issues at different layers:

### ❌ Gemini's Incorrect Diagnoses

1. **"Authentication Silencing (Token Mismatch)"** — Fabricated. The `sub.token` field is stored in `Subscriber` but is never read back during the `onData` broadcast loop. No token validation middleware exists that could kill the subscriber stream. Gemini hallucinated this mechanism.

2. **"Metadata Frame Corruption in UI Buffer"** — Misidentified. The `\x00` binary control protocol was already correctly implemented: backend sends `ArrayBuffer` via the raw Bun `ServerWebSocket`, and the frontend's `handleMessage` already checked `bytes[0] === 0` to handle cursor frames without writing to the terminal canvas.

3. **"Garbage Type Casting causing Reverse-i-search"** — Partially correct diagnosis, but the fix was applied in the wrong location. Gemini applied `TextDecoder` in `pty/index.ts:onMessage`, but the actual `String()` coercion happened one layer above in `packages/opencode/src/server/routes/pty.ts`, making the fix unreachable.

### ✅ Actual Root Causes

1. **`String(event.data)` in the WebSocket route handler** (`packages/opencode/src/server/routes/pty.ts:184`):
   ```ts
   // BEFORE (broken)
   onMessage(event) { handler?.onMessage(String(event.data)) }
   // AFTER (fixed)
   onMessage(event) { handler?.onMessage(event.data) }
   ```
   This was the single most destructive line in the entire codebase for this bug. `String()` coercion converts any non-string WebSocket payload (ArrayBuffer, Blob) into `"[object ArrayBuffer]"` before `pty/index.ts` ever sees it. All downstream `TextDecoder` fixes were completely unreachable for binary frames. For normal keyboard input (text frames), this also meant extra `String()` wrapping on an already-string value — innocuous but obscuring.

2. **Running server not updated** — The binary at `/home/pkcs12/.local/bin/opencode` was built at 14:45 and the running process (pid 17013) had been started even earlier at 11:53. All source code changes made during the debugging session were never applied to the running server, explaining why every fix attempt "failed" — the patched code never ran.

3. **CDN proxy fallback serving production frontend** — Without `OPENCODE_FRONTEND_PATH` set, the server proxies `GET /*` to `https://app.opencode.ai`, serving the production build instead of the local build. This made it impossible to verify local frontend changes, and the production frontend may behave differently.

## 🛠 Fix Implementation

### Source Code Changes

- **`packages/opencode/src/server/routes/pty.ts`** — Removed `String()` coercion in `onMessage`:
  ```ts
  onMessage(event) {
    handler?.onMessage(event.data)   // pass raw data, not String(event.data)
  }
  ```

- **`packages/opencode/src/pty/index.ts`** — Added `Blob` handling in `onMessage` as defensive coverage (Hono on Bun may deliver binary frames as `Blob` in some paths):
  ```ts
  onMessage: async (message: any) => {
    const payload = message instanceof Blob ? await message.arrayBuffer() : message;
    const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
    session.process.write(text)
  },
  ```

### Server Restart Procedure

After patching source, the server must be run from source (not the stale binary) with the local frontend explicitly configured:

```bash
OPENCODE_FRONTEND_PATH=/home/betaman/projects/opencode-web/packages/app/dist \
  /home/pkcs12/.bun/bin/bun --conditions=browser \
  packages/opencode/src/index.ts web --port 1080 --hostname 0.0.0.0
```

## ✅ Status: Resolved

Server-side debug log confirmed full round-trip after fix was applied to the running server:

```
[PTY SERVER] connect called for id: pty_c8ec21987001bjQb1PmTFU6b9x
[PTY SERVER] Process outputted length: 36
[PTY SERVER] Received input from client length: 1  content: h
[PTY SERVER] Process outputted length: 1
[PTY SERVER] Received input from client length: 1  content: i
[PTY SERVER] Process outputted length: 1
[PTY SERVER] Received input from client length: 1  content: (Enter)
[PTY SERVER] Process outputted length: 137
```

Real-time terminal input and output are fully functional.

## 💡 Takeaways

1. **Always trace the complete data flow before diagnosing.** The bug was at the WebSocket route layer (`routes/pty.ts`), not inside `pty/index.ts`. Gemini analyzed the wrong file entirely because it never traced `event.data` from the route handler down to the PTY write call.

2. **Verify the running server reflects source changes.** Check binary build timestamps against source modification times (`stat -c '%y' <file>` vs `ls -la <binary>`). A patched source file has zero effect if the running process was started from a stale binary.

3. **`OPENCODE_FRONTEND_PATH` must be set for local development.** Without it, the server silently falls back to proxying `app.opencode.ai`, making local frontend changes invisible and debug logs unreachable.

4. **Never use `String()` over WebSocket `event.data`.** WebSocket messages can be `string | ArrayBuffer | Blob`. `String(ArrayBuffer)` produces `"[object ArrayBuffer]"` which corrupts STDIN and causes shell misinterpretation (reverse-i-search, garbled input).

5. **`/tmp/pty-debug.log` is the canonical debug artifact** for PTY connectivity issues. If the file is absent after a terminal connection attempt, the running server is not using the modified source.
