import fs from 'fs';
const file = 'packages/opencode/src/auth/index.ts';
let code = fs.readFileSync(file, 'utf8');

const oldCode = `  export async function remove(providerId: string) {
    const { Account } = await import("../account")

    // Try to find and remove by exact ID first
    const exactMatch = await Account.getById(providerId)
    if (exactMatch) {
      await Account.remove(exactMatch.provider, providerId)
      return
    }

    // Otherwise, remove the active account for this provider
    const provider = await Account.resolveFamilyOrSelf(providerId)
    const activeId = await Account.getActive(provider)
    if (activeId) {
      await Account.remove(provider, activeId)
    }
  }`;

const newCode = `  export async function remove(providerId: string) {
    const { Account } = await import("../account")

    // Try to find and remove by exact ID first
    const exactMatch = await Account.getById(providerId)
    if (exactMatch) {
      await Account.remove(exactMatch.provider, providerId)
      
      // Async background disposal of the provider to avoid blocking the UI
      import("../provider/provider").then(({ Provider }) => {
        Provider.dispose(exactMatch.provider, providerId).catch(err => {
          import("../util/debug").then(({ debugCheckpoint }) => {
            debugCheckpoint("auth", "Background disposal failed", { providerId, error: String(err) })
          })
        })
      })
      return
    }

    // Otherwise, remove the active account for this provider
    const provider = await Account.resolveFamilyOrSelf(providerId)
    const activeId = await Account.getActive(provider)
    if (activeId) {
      await Account.remove(provider, activeId)
      
      // Async background disposal
      import("../provider/provider").then(({ Provider }) => {
        Provider.dispose(provider, activeId).catch(err => {
          import("../util/debug").then(({ debugCheckpoint }) => {
            debugCheckpoint("auth", "Background disposal failed", { providerId: activeId, error: String(err) })
          })
        })
      })
    }
  }`;

code = code.replace(oldCode, newCode);
fs.writeFileSync(file, code);
console.log('patched auth.remove');
