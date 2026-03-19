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

  // Clean up duplicate subscription accounts — parallelize across providers
  const families = await Account.listAll()
  await Promise.all(
    Object.keys(families).map((family) =>
      debugSpan("bootstrap", "Account.deduplicateByToken", { provider: family }, () =>
        Account.deduplicateByToken(family),
      ),
    ),
  )

  Log.Default.info("bootstrapping", { directory: Instance.directory })

  // Parallelize init calls. Only hard dependency: Vcs requires FileWatcher.
  await Promise.all([
    // Group A: independent inits (Bus subscriptions, config reads, schedulers)
    debugSpan("bootstrap", "Plugin.init", {}, () => Plugin.init()),
    debugSpan("bootstrap", "Share.init", {}, () => Share.init()),
    debugSpan("bootstrap", "ShareNext.init", {}, () => ShareNext.init()),
    debugSpan("bootstrap", "Format.init", {}, () => Format.init()),
    debugSpan("bootstrap", "LSP.init", {}, () => LSP.init()),
    debugSpan("bootstrap", "File.init", {}, () => File.init()),
    debugSpan("bootstrap", "WorkspaceService.initEventSubscriptions", {}, () =>
      Promise.resolve(WorkspaceService.initEventSubscriptions()),
    ),
    debugSpan("bootstrap", "Snapshot.init", {}, () => Snapshot.init()),
    debugSpan("bootstrap", "Truncate.init", {}, () => Truncate.init()),

    // Group B: FileWatcher → Vcs chain (Vcs subscribes to FileWatcher events)
    debugSpan("bootstrap", "FileWatcher.init", {}, () => FileWatcher.init()).then(() =>
      debugSpan("bootstrap", "Vcs.init", {}, () => Vcs.init()),
    ),
  ])

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })

  debugCheckpoint("bootstrap", "ready", { directory: Instance.directory })
}
