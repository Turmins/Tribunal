// Rebuild prompts.lock.json. Refuse to write when slot content changed without
// a corresponding block version bump (PV-1).
import { readFile, writeFile } from "node:fs/promises";
import { computeLock } from "../dist/server/prompts-registry.js";

const target = "prompts/prompts.lock.json";
const next = await computeLock();
let previous = { slots: {} };
try { previous = JSON.parse(await readFile(target, "utf8")); } catch { /* first run */ }

const stale = Object.entries(next.slots).filter(([name, slot]) => {
  const was = previous.slots[name];
  return was && was.hash !== slot.hash && was.version === slot.version;
});
if (stale.length) {
  console.error("Content changed without a version bump in prompts/versions.json:");
  for (const [name, slot] of stale) console.error(`  ${name} (version remains ${slot.version})`);
  process.exit(1);
}
await writeFile(target, JSON.stringify(next, null, 2) + "\n");
console.log(`prompts.lock.json updated: ${Object.keys(next.slots).length} slots`);
