import fs from 'fs';
const file = 'packages/opencode/src/auth/index.ts';
let code = fs.readFileSync(file, 'utf8');

const oldCodeApi = `      const raw = providerId.startsWith(\`\${providerKey}-\`) ? providerId.slice(providerKey.length + 1) : providerId
      let label = info.name || raw || providerId
      let accountId = Account.generateId(providerKey, "api", label)
      
      const existingAccounts = await Account.list(providerKey)
      if (!info.name && existingAccounts[accountId]) {
        label = \`\${label}-\${Date.now().toString(36)}\`
        accountId = Account.generateId(providerKey, "api", label)
      }

      await Account.add(providerKey, accountId, {
        type: "api",
        name: label,
        apiKey: info.key,
        addedAt: Date.now(),
        projectId: info.projectId,
      })`;

const newCodeApi = `      const raw = providerId.startsWith(\`\${providerKey}-\`) ? providerId.slice(providerKey.length + 1) : providerId
      let label = info.name || raw || providerId
      let accountId = Account.generateId(providerKey, "api", label)
      
      const existingAccounts = await Account.list(providerKey)
      
      // API Key Deduplication: if the exact same API key already exists for this provider, we update it or return it,
      // rather than creating a phantom duplicate account under a new name.
      let duplicateId: string | undefined
      for (const [id, acc] of Object.entries(existingAccounts)) {
        if (acc.type === "api" && acc.apiKey === info.key) {
          duplicateId = id
          break
        }
      }

      if (duplicateId) {
        // If the key exists, we simply update its name/projectId if they were provided
        await Account.update(providerKey, duplicateId, {
          name: info.name || existingAccounts[duplicateId].name,
          projectId: info.projectId || (existingAccounts[duplicateId] as any).projectId,
        })
        return duplicateId
      }

      // Handle ID collision if the user happened to provide a generic name like "Default" that already exists
      let counter = 1
      while (existingAccounts[accountId]) {
        label = \`\${info.name || raw || providerId}-\${counter}\`
        accountId = Account.generateId(providerKey, "api", label)
        counter++
      }

      await Account.add(providerKey, accountId, {
        type: "api",
        name: label,
        apiKey: info.key,
        addedAt: Date.now(),
        projectId: info.projectId,
      })
      return accountId`;

code = code.replace(oldCodeApi, newCodeApi);

// Also need to return accountId for OAuth
const oldCodeOauthUpdate = `        await Account.update(providerKey, existingAccountId, {
          email: email,
          refreshToken: baseToken, // Store base token without projectId suffix
          accessToken: info.access,
          expiresAt: info.expires,
          projectId,
          managedProjectId,
          metadata: info.orgID ? { orgID: info.orgID } : undefined,
        })`;

const newCodeOauthUpdate = `        await Account.update(providerKey, existingAccountId, {
          email: email,
          refreshToken: baseToken, // Store base token without projectId suffix
          accessToken: info.access,
          expiresAt: info.expires,
          projectId,
          managedProjectId,
          metadata: info.orgID ? { orgID: info.orgID } : undefined,
        })
        return existingAccountId`;

code = code.replace(oldCodeOauthUpdate, newCodeOauthUpdate);

const oldCodeOauthAdd = `        await Account.add(providerKey, accountId, {
          type: "subscription",
          name: email || username || providerId,
          email: email,
          refreshToken: baseToken, // Store base token without projectId suffix
          accessToken: info.access,
          expiresAt: info.expires,
          accountId: info.accountId,
          projectId,
          managedProjectId,
          addedAt: Date.now(),
          metadata: info.orgID ? { orgID: info.orgID } : undefined,
        })`;

const newCodeOauthAdd = `        await Account.add(providerKey, accountId, {
          type: "subscription",
          name: email || username || providerId,
          email: email,
          refreshToken: baseToken, // Store base token without projectId suffix
          accessToken: info.access,
          expiresAt: info.expires,
          accountId: info.accountId,
          projectId,
          managedProjectId,
          addedAt: Date.now(),
          metadata: info.orgID ? { orgID: info.orgID } : undefined,
        })
        return accountId`;

code = code.replace(oldCodeOauthAdd, newCodeOauthAdd);

// Change `set` return type from void to string
code = code.replace('export async function set(providerId: string, info: Info) {', 'export async function set(providerId: string, info: Info): Promise<string> {');

fs.writeFileSync(file, code);
console.log('patched auth.set');
