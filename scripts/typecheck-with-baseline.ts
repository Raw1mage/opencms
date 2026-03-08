#!/usr/bin/env bun

const IGNORED_PATH_PREFIXES = [] as const

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
  return false
}

const decoder = new TextDecoder()
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "")
const result = run(["bun", "turbo", "typecheck"], ROOT)
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

process.exit(0)
