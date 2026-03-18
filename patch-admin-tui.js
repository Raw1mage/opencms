import fs from 'fs';
const file = 'packages/opencode/src/cli/cmd/tui/component/dialog-admin.tsx';
let code = fs.readFileSync(file, 'utf8');

const oldCode1 = `      const info: Account.ApiAccount = {
        type: "api",
        name: nextName,
        apiKey: nextKey,
        addedAt: Date.now(),
      }
      const wrote = await Account.add("google-api", id, info)
        .then(() => true)
        .catch((err) => {
          const msg = String(err instanceof Error ? err.stack || err.message : err)
          setSaveErr(msg)
          debugCheckpoint("admin.google_add", "save failed", { error: msg })
          return false
        })`;

const newCode1 = `      const { Auth } = await import("../../../../auth")
      const wrote = await Auth.set("google-api", {
        type: "api",
        name: nextName,
        key: nextKey,
      })
        .then(() => true)
        .catch((err) => {
          const msg = String(err instanceof Error ? err.stack || err.message : err)
          setSaveErr(msg)
          debugCheckpoint("admin.google_add", "save failed", { error: msg })
          return false
        })`;

code = code.replace(oldCode1, newCode1);

const oldCode2 = `    const info: Account.ApiAccount = {
      type: "api",
      name: nextName,
      apiKey: nextKey,
      addedAt: Date.now(),
    }
    const wrote = await Account.add(props.providerId, id, info)
      .then(() => true)
      .catch((err) => {
        const msg = String(err instanceof Error ? err.stack || err.message : err)
        setSaveErr(msg)
        debugCheckpoint("admin.apikey_add", "save failed", { error: msg })
        return false
      })`;

const newCode2 = `    const { Auth } = await import("../../../../auth")
    const wrote = await Auth.set(props.providerId, {
      type: "api",
      name: nextName,
      key: nextKey,
    })
      .then(() => true)
      .catch((err) => {
        const msg = String(err instanceof Error ? err.stack || err.message : err)
        setSaveErr(msg)
        debugCheckpoint("admin.apikey_add", "save failed", { error: msg })
        return false
      })`;

code = code.replace(oldCode2, newCode2);
fs.writeFileSync(file, code);
console.log('patched admin tui');
