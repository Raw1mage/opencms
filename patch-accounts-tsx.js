import fs from 'fs';
const file = 'packages/opencode/src/cli/cmd/accounts.tsx';
let code = fs.readFileSync(file, 'utf8');

const oldCode = `        const extractedEmail = JWT.getEmail(keyVal as string)
        const finalName = nameIn && (nameIn as string).length > 0 ? (nameIn as string) : extractedEmail || "Default"

        const id = Account.generateId(finalFamily, "api", finalName)
        await Account.add(finalFamily, id, {
          type: "api",
          name: finalName,
          apiKey: keyVal as string,
          addedAt: Date.now(),
        })`;

const newCode = `        const { Auth } = await import("../../auth")
        const extractedEmail = JWT.getEmail(keyVal as string)
        const finalName = nameIn && (nameIn as string).length > 0 ? (nameIn as string) : extractedEmail || "Default"

        await Auth.set(finalFamily, {
          type: "api",
          name: finalName,
          key: keyVal as string,
        })`;

code = code.replace(oldCode, newCode);

const oldRemoveCode = `        if (item.active) {
          const others = flat.filter((x) => x.provider === item.provider && x.id !== item.id)
          if (others.length > 0) {
            await Account.setActive(item.provider, others[0].id)
          }
        }
        if (item.type === "api" || item.type === "subscription") {
          try {
            if (item.type === "subscription") {
              const { Provider } = await import("../../provider/provider")
              const p = await Provider.get(item.provider)
              if (p) {
                try {
                  const url = \`\${p.baseUrl}/v1/identity/me\`
                  await fetch(url, {
                    method: "DELETE",
                    headers: {
                      Authorization: \`Bearer \${item.apiKey}\`,
                    },
                  })
                } catch (e) {
                  // Ignore
                }
              }
            }
          } finally {
            if (item.provider === "google-api") {
              const { Provider } = await import("../../provider/provider")
              await Provider.dispose(item.provider, item.id)
            }
            await Account.remove(item.provider, item.id)
          }
        } else {
          await Account.remove(item.provider, item.id)
        }`;

const newRemoveCode = `        const { Auth } = await import("../../auth")
        await Auth.remove(item.id)`;

code = code.replace(oldRemoveCode, newRemoveCode);

fs.writeFileSync(file, code);
console.log('patched accounts.tsx');
