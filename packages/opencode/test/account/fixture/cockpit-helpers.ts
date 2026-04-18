// Re-export the test-only hook from rate-limit-judge so test files don't
// have to spell the long symbol each time. Importing this helper AFTER
// mock.module("../../src/account/quota/openai", ...) ensures the spy takes
// effect (dynamic import order matters).
export async function fetchCockpitBackoffForTest(
  providerId: string,
  accountId: string,
  modelId: string,
  fallbackBackoffMs: number,
) {
  const { __testOnly_fetchCockpitBackoff } = await import("../../../src/account/rate-limit-judge")
  return __testOnly_fetchCockpitBackoff(providerId, accountId, modelId, fallbackBackoffMs)
}
