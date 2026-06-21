import os from "os"
import { Log } from "@/util/log"
import {
  checkFuseAvailable,
  getSetupStatus,
  isMounted,
  normalizeRemote,
  rcloneConfigPath,
  readGDrivePreference,
  resolveHomeBoundMountPoint,
  spawnRcloneMount,
} from "./setup-cli"

const log = Log.create({ service: "gdrive-automount" })

/**
 * Daemon-startup auto-mount. Best-effort, preference-gated, never throws.
 *
 * Runs inside the per-user daemon's process so the FUSE mount lands in the
 * daemon's own mount namespace — the same namespace the file explorer reads.
 * A systemd/system mount would be invisible here (different namespace).
 *
 * Gating: only mounts when the user opted in (~/.config/opencode/gdrive.json
 * autoMount=true, written on first successful gdrive_mount). Users who never
 * set up Drive have no preference file and are untouched.
 */
export async function autoMountGDriveOnStartup(): Promise<void> {
  try {
    const home = os.homedir()
    const pref = await readGDrivePreference(home)
    if (!pref || pref.autoMount !== true) return // not opted in — silent skip

    const remote = normalizeRemote(pref.remote)
    const mountPoint = await resolveHomeBoundMountPoint(pref.mountPoint, home)

    if (await isMounted(mountPoint)) {
      log.info("gdrive already mounted at startup", { mountPoint })
      return
    }

    const status = await getSetupStatus({ remote, mountPoint })
    if (!status.rcloneAvailable || !status.remoteConfigured) {
      log.warn("gdrive auto-mount skipped: setup incomplete", {
        rcloneAvailable: status.rcloneAvailable,
        remoteConfigured: status.remoteConfigured,
      })
      return
    }
    if (!(await checkFuseAvailable())) {
      log.warn("gdrive auto-mount skipped: FUSE unavailable")
      return
    }

    const mounted = await spawnRcloneMount({ remote, mountPoint, configPath: rcloneConfigPath(home) })
    if (mounted) log.info("gdrive auto-mounted at startup", { mountPoint, remote })
    else log.warn("gdrive auto-mount spawned but mountpoint not confirmed within timeout", { mountPoint })
  } catch (error) {
    log.warn("gdrive auto-mount failed", { error: error instanceof Error ? error.message : String(error) })
  }
}
