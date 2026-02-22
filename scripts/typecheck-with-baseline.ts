#!/usr/bin/env bun

const IGNORED_FILE = "packages/opencode/src/plugin/antigravity/plugin/storage.legacy.ts"
const IGNORED_FILE_SUFFIX = "src/plugin/antigravity/plugin/storage.legacy.ts"
const KNOWN_CODES = new Set(["TS2307", "TS7006"])

function run(command: string[], cwd?: string) {
  return Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
}

function text(decoder: TextDecoder, value?: Uint8Array) {
  return value ? decoder.decode(value) : ""
}

function isIgnoredDiagnostic(line: string) {
  if (!line.includes(IGNORED_FILE) && !line.includes(IGNORED_FILE_SUFFIX)) return false
  const code = line.match(/error\s+(TS\d+):/)?.[1]
  if (!code) return false
  return KNOWN_CODES.has(code)
}

function isIgnoredFileTouched() {
  const unstaged = run(["git", "diff", "--name-only", "--", IGNORED_FILE])
  const staged = run(["git", "diff", "--cached", "--name-only", "--", IGNORED_FILE])
  const changed = `${new TextDecoder().decode(unstaged.stdout)}${new TextDecoder().decode(staged.stdout)}`.trim()
  return changed.length > 0
}

const decoder = new TextDecoder()
const result = run(["bun", "turbo", "typecheck"], "/home/pkcs12/projects/opencode")
const stdout = text(decoder, result.stdout)
const stderr = text(decoder, result.stderr)
const output = `${stdout}${stderr}`

if (output.trim()) process.stdout.write(output)

if (result.exitCode === 0) {
  process.exit(0)
}

const diagnosticLines = output
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.includes("error TS"))

if (diagnosticLines.length === 0) {
  process.exit(result.exitCode)
}

const onlyIgnored = diagnosticLines.every(isIgnoredDiagnostic)
if (!onlyIgnored) {
  process.exit(result.exitCode)
}

if (isIgnoredFileTouched()) {
  console.error(`\n[verify] baseline ignore disabled: ${IGNORED_FILE} was modified in this change.`)
  process.exit(result.exitCode)
}

console.warn("\n[verify] non-blocking known baseline errors ignored (antigravity storage.legacy.ts).")
process.exit(0)
