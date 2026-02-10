#!/usr/bin/env bun
import fs from "fs"
import os from "os"
import path from "path"

import { Global } from "../packages/opencode/src/global"

const repoRoot = process.cwd()
const templatesDir = path.join(repoRoot, "templates")
const manifestPath = path.join(templatesDir, "manifest.json")

const ensureDir = (dir: string) => {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") {
      throw error
    }
  }
}

const fsPromises = fs.promises

const cleanupToCyclebin = async () => {
  // @event_2026-02-07_install: XDG-aware cleanup
  const targets: ("config" | "state" | "data")[] = ["config", "state", "data"]
  const resolveTargetDir = (target: string) => {
    if (target === "state") return Global.Path.state
    if (target === "data") return Global.Path.data
    return Global.Path.config
  }

  const manifestExists = await Bun.file(manifestPath).exists()
  const manifestFilesByTarget = new Map<string, Set<string>>()
  targets.forEach((t) => manifestFilesByTarget.set(t, new Set()))

  if (manifestExists) {
    try {
      const manifest = JSON.parse(await Bun.file(manifestPath).text())
      const entries = Array.isArray(manifest.entries) ? manifest.entries : manifest
      for (const entry of entries) {
        const target = entry.target ?? "config"
        const firstSegment = entry.path.split(/[/\\]/)[0]
        manifestFilesByTarget.get(target)?.add(firstSegment)
      }
    } catch (e) {
      console.error("Manifest error:", e)
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const cyclebinRoot = path.join(Global.Path.state, "cyclebin")

  for (const target of targets) {
    const userDir = resolveTargetDir(target)
    if (!fs.existsSync(userDir)) continue

    const protectedPaths = new Set([...(manifestFilesByTarget.get(target) || [])])

    if (target === "state") protectedPaths.add("cyclebin")
    if (target === "data") {
      protectedPaths.add("log")
      protectedPaths.add("generated-images")
      protectedPaths.add("node_modules")
      protectedPaths.add("bun.lock")
    }

    console.log(`[${target}] 受保護項目:`, Array.from(protectedPaths).join(", "))

    const entries = await fsPromises.readdir(userDir, { withFileTypes: true })
    let movedCount = 0

    for (const entry of entries) {
      if (protectedPaths.has(entry.name)) continue

      const sessionBin = path.join(cyclebinRoot, timestamp, target)
      if (movedCount === 0) ensureDir(sessionBin)

      const src = path.join(userDir, entry.name)
      const dest = path.join(sessionBin, entry.name)

      try {
        await fsPromises.rename(src, dest)
        console.log(`[CLEANUP] 已將 ${target}/${entry.name} 移至 cyclebin/${timestamp}/${target}/`)
        movedCount++
      } catch (error) {
        console.warn(`無法移動 ${target}/${entry.name}:`, error)
      }
    }

    if (movedCount > 0) {
      console.log(`[${target}] 清理完成，共移動 ${movedCount} 個項目至 cyclebin`)
    }
  }
}

await cleanupToCyclebin()
