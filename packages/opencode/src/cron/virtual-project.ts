import path from "path"
import { Global } from "../global"

/**
 * Virtual project directory for scheduled tasks.
 *
 * All cron sessions are scoped to this directory via Instance.provide(),
 * keeping them isolated from user projects. Project.fromDirectory() will
 * derive a stable project ID using SHA1("nogit:" + absolutePath).
 */
export const TASKS_VIRTUAL_DIR = path.join(Global.Path.state, "__tasks__")
