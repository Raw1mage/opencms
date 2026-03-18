import fs from 'fs';
const file = 'packages/opencode/src/account/index.ts';
let code = fs.readFileSync(file, 'utf8');

const oldCode = `    if (!providersOf(storage)[provider]) {
      providersOf(storage)[provider] = { accounts: {} }
      debugCheckpoint("Account.add", "Created new provider entry", { provider })
    }

    providersOf(storage)[provider].accounts[accountId] = info`;

const newCode = `    if (!providersOf(storage)[provider]) {
      providersOf(storage)[provider] = { accounts: {} }
      debugCheckpoint("Account.add", "Created new provider entry", { provider })
    }

    if (providersOf(storage)[provider].accounts[accountId]) {
      throw new Error(\`Account ID \${accountId} already exists for provider \${provider}. Account.add does not permit silent overwrites.\`)
    }

    providersOf(storage)[provider].accounts[accountId] = info`;

fs.writeFileSync(file, code.replace(oldCode, newCode));
console.log('patched add');
