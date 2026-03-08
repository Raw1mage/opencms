import { Plugin } from "../plugin"
import { Share } from "../share/share"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Vcs } from "./vcs"
import { Log } from "@/util/log"
import { debugCheckpoint, debugSpan } from "@/util/debug"
import { ShareNext } from "@/share/share-next"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"
import { WorkspaceService } from "./workspace"

export async function InstanceBootstrap() {
  debugCheckpoint("bootstrap", "start", { directory: Instance.directory })

  // Force migration from auth.json to accounts.json (single source of truth)
  const { Account } = await import("../account")
  await debugSpan("bootstrap", "Account.forceFullMigration", {}, () => Account.forceFullMigration())

  // Clean up duplicate subscription accounts (e.g., same token stored with different IDs)
  const families = await Account.listAll()
  for (const family of Object.keys(families)) {
    await debugSpan("bootstrap", "Account.deduplicateByToken", { provider: family }, () =>
      Account.deduplicateByToken(family),
    )
  }

  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await debugSpan("bootstrap", "Plugin.init", {}, () => Plugin.init())
  await debugSpan("bootstrap", "Share.init", {}, () => Share.init())
  await debugSpan("bootstrap", "ShareNext.init", {}, () => ShareNext.init())
  await debugSpan("bootstrap", "Format.init", {}, () => Format.init())
  await debugSpan("bootstrap", "LSP.init", {}, () => LSP.init())
  await debugSpan("bootstrap", "FileWatcher.init", {}, () => FileWatcher.init())
  await debugSpan("bootstrap", "File.init", {}, () => File.init())
  await debugSpan("bootstrap", "Vcs.init", {}, () => Vcs.init())
  await debugSpan("bootstrap", "WorkspaceService.initEventSubscriptions", {}, () =>
    Promise.resolve(WorkspaceService.initEventSubscriptions()),
  )
  await debugSpan("bootstrap", "Snapshot.init", {}, () => Snapshot.init())
  await debugSpan("bootstrap", "Truncate.init", {}, () => Truncate.init())

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })

  debugCheckpoint("bootstrap", "ready", { directory: Instance.directory })
}
