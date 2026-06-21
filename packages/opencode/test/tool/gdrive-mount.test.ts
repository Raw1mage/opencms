import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Tool } from "../../src/tool/tool"
import { GDriveSetupTool } from "../../src/tool/gdrive-setup"
import { GDriveMountTool } from "../../src/tool/gdrive-mount"
import {
  decodeMountInfoPath,
  googleAuthPath,
  listRemotes,
  materializeRcloneDriveRemoteFromGoogleAuth,
  normalizeRemote,
  planRcloneConfigCreate,
  planRcloneListRemotes,
  rcloneConfigPath,
  resolveHomeBoundMountPoint,
  runFixedArgv,
  writeRcloneDriveRemote,
} from "../../src/gdrive/setup-cli"

const ctx = {
  sessionID: "test",
  messageID: "msg",
  callID: "call",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("gdrive setup cli helpers", () => {
  test("normalizes rclone remotes", () => {
    expect(normalizeRemote()).toBe("gdrive:")
    expect(normalizeRemote("workdrive")).toBe("workdrive:")
    expect(normalizeRemote("team.drive:")).toBe("team.drive:")
    expect(() => normalizeRemote("bad/name")).toThrow("Invalid Google Drive remote name")
  })

  test("plans only fixed argv rclone commands", () => {
    expect(planRcloneListRemotes()).toEqual({ command: "rclone", args: ["listremotes"] })
    expect(planRcloneConfigCreate("gdrive")).toEqual({
      command: "rclone",
      args: ["config", "create", "gdrive", "drive", "config_is_local", "false"],
    })
  })

  test("parses rclone listremotes output", async () => {
    const result = await listRemotes(async () => ({ ok: true, stdout: "gdrive:\nteam:\n", stderr: "" }))
    expect(result).toEqual({ ok: true, remotes: ["gdrive:", "team:"] })
  })

  test("reports missing executables without throwing", async () => {
    const result = await runFixedArgv({ command: "__opencode_missing_rclone_for_test__", args: ["version"] }, 100)
    expect(result.ok).toBe(false)
    expect(String(result.stderr || result.code)).toBeTruthy()
  })

  test("decodes mountinfo escaped paths", () => {
    expect(decodeMountInfoPath("/home/user/Google\\040Drive")).toBe("/home/user/Google Drive")
  })

  test("writes Google Drive rclone remote under the current user config", async () => {
    await using tmp = await tmpdir({})
    const result = await writeRcloneDriveRemote({
      home: tmp.path,
      remote: "gdrive",
      client: { clientId: "client-id", clientSecret: "client-secret" },
      token: { access_token: "access-token", refresh_token: "refresh-token" },
    })
    const configPath = rcloneConfigPath(tmp.path)
    expect(result).toEqual({ configPath, remote: "gdrive:" })
    const config = await fs.readFile(configPath, "utf8")
    expect(config).toContain("[gdrive]")
    expect(config).toContain("type = drive")
    expect(config).toContain("client_id = client-id")
    expect(config).toContain('"refresh_token":"refresh-token"')
    await expect(
      writeRcloneDriveRemote({
        home: tmp.path,
        remote: "gdrive",
        client: { clientId: "client-id", clientSecret: "client-secret" },
        token: { access_token: "next-token" },
      }),
    ).rejects.toThrow("explicit overwrite is required")
  })

  test("materializes rclone remote from existing OpenCMS Google login token", async () => {
    await using tmp = await tmpdir({})
    const gauthPath = googleAuthPath(tmp.path)
    await fs.mkdir(path.dirname(gauthPath), { recursive: true })
    await fs.writeFile(
      gauthPath,
      JSON.stringify({
        access_token: "login-access-token",
        refresh_token: "login-refresh-token",
        expires_at: Date.now() + 3600_000,
        token_type: "Bearer",
      }),
    )
    await materializeRcloneDriveRemoteFromGoogleAuth({
      home: tmp.path,
      gauthPath,
      remote: "gdrive",
      client: { clientId: "client-id", clientSecret: "client-secret" },
    })
    const config = await fs.readFile(rcloneConfigPath(tmp.path), "utf8")
    expect(config).toContain("[gdrive]")
    expect(config).toContain("client_id = client-id")
    expect(config).toContain('"access_token":"login-access-token"')
    expect(config).toContain('"refresh_token":"login-refresh-token"')
  })
})

describe("gdrive mount path validation", () => {
  test("defaults to ~/GoogleDrive and accepts relative paths inside home", async () => {
    await using tmp = await tmpdir({})
    expect(await resolveHomeBoundMountPoint(undefined, tmp.path)).toBe(path.join(tmp.path, "GoogleDrive"))
    expect(await resolveHomeBoundMountPoint("work/gdrive", tmp.path)).toBe(path.join(tmp.path, "work", "gdrive"))
    expect(await resolveHomeBoundMountPoint("~/Drive", tmp.path)).toBe(path.join(tmp.path, "Drive"))
  })

  test("rejects absolute and relative escapes outside home", async () => {
    await using tmp = await tmpdir({})
    await expect(resolveHomeBoundMountPoint("/mnt/gdrive", tmp.path)).rejects.toThrow("only allowed inside")
    await expect(resolveHomeBoundMountPoint("/etc", tmp.path)).rejects.toThrow("only allowed inside")
    await expect(resolveHomeBoundMountPoint("../outside", tmp.path)).rejects.toThrow("only allowed inside")
    await expect(resolveHomeBoundMountPoint(path.join(os.tmpdir(), "other-home"), tmp.path)).rejects.toThrow(
      "only allowed inside",
    )
  })

  test("rejects symlink escapes where checkable", async () => {
    await using tmp = await tmpdir({})
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gdrive-outside-"))
    const link = path.join(tmp.path, "link-out")
    await fs.symlink(outside, link)
    await expect(resolveHomeBoundMountPoint(link, tmp.path)).rejects.toThrow("resolves outside")
    await fs.rm(outside, { recursive: true, force: true })
  })
})

describe("gdrive tools", () => {
  test("classifies setup and mount as modifying tools", () => {
    expect(Tool.kind("gdrive_setup")).toBe("modify")
    expect(Tool.kind("gdrive_mount")).toBe("modify")
  })

  test("exports setup and mount native tool ids", () => {
    expect(GDriveSetupTool.id).toBe("gdrive_setup")
    expect(GDriveMountTool.id).toBe("gdrive_mount")
  })

  test("setup output never instructs opening a terminal", async () => {
    const setup = await GDriveSetupTool.init()
    const result = await setup.execute({ action: "start" }, ctx)
    expect(result.output.toLowerCase()).not.toContain("open a terminal")
    expect(result.output.toLowerCase()).not.toContain("run rclone config")
  })
})
