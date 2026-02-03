import { Account } from "./src/account"
import { Instance } from "./src/project/instance"

async function run() {
  await Instance.provide({
    directory: process.cwd(),
    async fn() {
      // 1. Dump Account.listAll() for Antigravity
      console.log("=== Account.listAll() Data ===")
      const families = await Account.listAll()
      const agFamily = families["antigravity"]
      if (agFamily) {
        console.log("Active Account:", agFamily.activeAccount)
        for (const [id, info] of Object.entries(agFamily.accounts)) {
          console.log(`ID: ${id}`)
          console.log(`  Type: ${info.type}`)
          console.log(`  Name: ${info.name}`)
          console.log(`  Email: ${(info as any).email}`) // Check if email exists on storage
        }
      } else {
        console.log("No antigravity family found in storage.")
      }

      // 2. Dump globalAccountManager snapshot
      console.log("\n=== globalAccountManager Snapshot ===")
      try {
        const { globalAccountManager } = await import("./src/plugin/antigravity/index")
        if (globalAccountManager) {
          const snapshot = globalAccountManager.getAccountsSnapshot()
          console.log(`Snapshot length: ${snapshot.length}`)
          snapshot.forEach((acc: any, i: number) => {
            console.log(`[${i}] Index: ${acc.index}, Email: ${acc.email}`)
          })
        } else {
          console.log("globalAccountManager is null")
        }
      } catch (e) {
        console.log("Error loading antigravity plugin:", e)
      }
    },
  })
}

run()
