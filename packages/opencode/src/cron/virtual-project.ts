import path from "path"
import { Global } from "../global"

/**
 * Virtual project directory for cron task sessions.
 *
 * All cron job executions create sessions under this directory,
 * isolating them from the user's main project sessions.
 * Project.fromDirectory() handles non-git directories by deriving
 * a stable project ID from SHA1("nogit:" + absolutePath).
 */
export const TASKS_VIRTUAL_DIR = path.join(Global.Path.state, "__tasks__")
