import { Account } from "./packages/opencode/src/account/index.ts"

async function run() {
  console.log("Adding account 1");
  await Account.add("test-provider", "test-id", {
    type: "api",
    name: "Test",
    apiKey: "key1",
    addedAt: Date.now()
  });

  try {
    console.log("Adding account 2 with same ID");
    await Account.add("test-provider", "test-id", {
      type: "api",
      name: "Test 2",
      apiKey: "key2",
      addedAt: Date.now()
    });
    console.log("FAIL: Did not throw");
  } catch (e) {
    console.log("SUCCESS: Threw error as expected ->", e.message);
  }
}
run().then(() => process.exit(0));
