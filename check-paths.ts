import { Global } from "./src/global/index.ts"
import path from "path"

console.log("Global.Path.log:", Global.Path.log)
console.log("Expected debug log:", path.join(Global.Path.log, "debug.log"))
console.log("Env OPENCODE_CLIPBOARD_IMAGE_PATH:", process.env.OPENCODE_CLIPBOARD_IMAGE_PATH)
