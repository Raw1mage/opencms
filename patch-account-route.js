import fs from 'fs';
const file = 'packages/opencode/src/server/routes/account.ts';
let code = fs.readFileSync(file, 'utf8');

const oldCode = `        await Account.remove(providerKey, accountId)
        return c.json(true)`;

const newCode = `        const { Auth } = await import("../../auth")
        await Auth.remove(accountId)
        return c.json(true)`;

code = code.replace(oldCode, newCode);
fs.writeFileSync(file, code);
console.log('patched account route');
