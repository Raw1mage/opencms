#!/usr/bin/env bun

const IGNORED_PATH_PREFIXES = [
  "packages/opencode/src/plugin/antigravity/",
  "src/plugin/antigravity/",
  "/src/plugin/antigravity/",
] as const

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
  return IGNORED_PATH_PREFIXES.some((prefix) => line.includes(prefix))
}

function isIgnoredPathsTouched() {
  const pluginPath = "packages/opencode/src/plugin/antigravity"
  const unstaged = run(["git", "diff", "--name-only", "--", pluginPath])
  const staged = run(["git", "diff", "--cached", "--name-only", "--", pluginPath])
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

if (isIgnoredPathsTouched()) {
  console.error("\n[verify] baseline ignore disabled: antigravity plugin paths were modified in this change.")
  process.exit(result.exitCode)
}

console.warn("\n[verify] non-blocking baseline errors ignored for antigravity auth plugin (unchanged in this diff).")
process.exit(0)
