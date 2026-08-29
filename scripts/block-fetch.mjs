/**
 * Test-suite safety boundary.
 *
 * Production OpenRouter traffic uses global fetch. Tests that exercise the
 * adapter replace this function with an explicit stub and restore this blocker
 * afterwards. Any unplanned fetch therefore fails before leaving the process.
 */
globalThis.fetch = async () => {
  throw new Error("Unexpected fetch: network access is blocked during tests");
};
