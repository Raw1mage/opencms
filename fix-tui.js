import fs from 'fs';
const file = 'packages/opencode/src/cli/cmd/tui/component/dialog-account.tsx';
let code = fs.readFileSync(file, 'utf8');

const oldCode = `  const remove = async (providerKey: string, accountId: string) => {
    // Optimistic UI update
    setAccounts(prev => {
      const next = { ...prev }
      if (next[providerKey] && next[providerKey].accounts) {
        delete next[providerKey].accounts[accountId]
      }
      return next
    })
    
    // Background disposal
    const { Auth } = await import("../../../../auth")
    await Auth.remove(accountId)
    // Silently refresh true state in background
    loadAccounts()
  }`;

const newCode = `  const remove = async (providerKey: string, accountId: string) => {
    // Optimistic UI update
    setProviderAccounts(prev => {
      const next = { ...prev }
      if (next[providerKey] && next[providerKey].accounts) {
        // Deep copy the accounts object before mutating
        next[providerKey] = {
          ...next[providerKey],
          accounts: { ...next[providerKey].accounts }
        }
        delete next[providerKey].accounts[accountId]
      }
      return next
    })
    
    // Perform backend deletion
    const { Auth } = await import("../../../../auth")
    await Auth.remove(accountId)
    // Silently refresh true state in background
    loadAccounts()
  }`;

code = code.replace(oldCode, newCode);
fs.writeFileSync(file, code);
