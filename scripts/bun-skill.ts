#!/usr/bin/env bun

import path from "path"
import fs from "fs/promises"
import { parseArgs } from "util"

const root = path.join(import.meta.dir, "..")
const templates = path.join(root, ".opencode", "skills", "bun-package-dev", "templates")
const diary = path.join(root, "packages", "opencode", "DIARY.md")

const args = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    name: { type: "string" },
    kind: { type: "string", default: "tool" },
    out: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
})

const values = args.values
if (values.help) {
  console.log(`
Usage: bun scripts/bun-skill.ts --kind <tool|package|diary> --name <name> [--out <path>]

Examples:
  bun scripts/bun-skill.ts --kind tool --name my-tool
  bun scripts/bun-skill.ts --kind package --name my-package
  bun scripts/bun-skill.ts --kind diary --name "功能名稱"
`)
  process.exit(0)
}

const name = values.name
if (!name) {
  console.error("Error: --name is required")
  process.exit(1)
}

const kind = values.kind ?? "tool"
if (kind === "tool") {
  await createTool(name, values.out)
  process.exit(0)
}

if (kind === "package") {
  await createPackage(name, values.out)
  process.exit(0)
}

if (kind === "diary") {
  await createDiary(name)
  process.exit(0)
}

console.error(`Error: unknown kind '${kind}'`) 
process.exit(1)

async function createTool(tool: string, out?: string) {
  const target = resolveOut(out, path.join(root, "packages", "opencode", "src", "tool", `${tool}.ts`))
  if (await Bun.file(target).exists()) {
    console.error(`Error: file already exists: ${target}`)
    process.exit(1)
  }

  const template = await Bun.file(path.join(templates, "tool.ts")).text()
  const constName = `${toPascal(tool)}Tool`
  const body = template.replaceAll("__TOOL__", tool).replaceAll("__CONST__", constName)

  await Bun.write(target, body)
  console.log(`Created tool: ${target}`)
}

async function createPackage(pkg: string, out?: string) {
  const target = resolveOut(out, path.join(root, "packages", pkg))
  const exists = await fs
    .stat(target)
    .then(() => true)
    .catch(() => false)

  if (exists) {
    console.error(`Error: directory already exists: ${target}`)
    process.exit(1)
  }

  await fs.mkdir(path.join(target, "src"), { recursive: true })

  await writeTemplate("package/package.json", path.join(target, "package.json"), pkg)
  await writeTemplate("package/tsconfig.json", path.join(target, "tsconfig.json"), pkg)
  await writeTemplate("package/src/index.ts", path.join(target, "src", "index.ts"), pkg)
  await writeTemplate("package/README.md", path.join(target, "README.md"), pkg)

  console.log(`Created package: ${target}`)
}

async function createDiary(feature: string) {
  const text = await Bun.file(diary).text()
  const date = new Date().toISOString().slice(0, 10)
  const marker = `## ${date}`
  const entry = await Bun.file(path.join(templates, "diary.md"))
    .text()
    .then((x) => x.replaceAll("__NAME__", feature))

  const updated = text.includes(marker) ? insertIntoDate(text, marker, entry) : insertNewDate(text, marker, entry)
  await Bun.write(diary, updated)
  console.log(`Updated DIARY: ${diary}`)
}

function insertNewDate(text: string, marker: string, entry: string) {
  const insert = `${marker}\n\n### PLANNING\n\n${entry}\n`
  const anchor = text.indexOf("\n---\n\n")
  const pos = anchor === -1 ? 0 : anchor + "\n---\n\n".length
  return text.slice(0, pos) + insert + text.slice(pos)
}

function insertIntoDate(text: string, marker: string, entry: string) {
  const start = text.indexOf(marker)
  const next = text.indexOf("\n## ", start + marker.length)
  const end = next === -1 ? text.length : next
  const section = text.slice(start, end)
  const planning = "### PLANNING"
  const index = section.indexOf(planning)

  if (index === -1) {
    const lineEnd = text.indexOf("\n", start + marker.length)
    const pos = lineEnd === -1 ? end : lineEnd + 1
    return text.slice(0, pos) + `\n${planning}\n\n${entry}\n` + text.slice(pos)
  }

  const global = start + index
  const lineEnd = text.indexOf("\n", global + planning.length)
  const pos = lineEnd === -1 ? end : lineEnd + 1
  return text.slice(0, pos) + `\n${entry}\n` + text.slice(pos)
}

function writeTemplate(src: string, dest: string, name: string) {
  return Bun.file(path.join(templates, src))
    .text()
    .then((x) => Bun.write(dest, x.replaceAll("__NAME__", name)))
}

function resolveOut(out: string | undefined, fallback: string) {
  if (!out) return fallback
  return path.isAbsolute(out) ? out : path.join(root, out)
}

function toPascal(input: string) {
  const cleaned = input
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, ch) => String(ch).toUpperCase())
    .replace(/^[a-z]/, (ch) => ch.toUpperCase())
  return cleaned.length > 0 ? cleaned : "Tool"
}
