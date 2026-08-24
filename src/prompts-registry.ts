import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { Stance } from "./types.js";

export type PanelName = "ethical" | "evidentiary" | "analytical" | "control";
export type AdvocateScheme = "grounds" | "control";

export interface RoleSlot {
  role: "advocate" | "judge";
  instance: number;
  stance: Stance | null;
  /** Block that defines a judge lens or advocate ground. */
  lens: string;
  /** Prompt name stored with the run; the panel can be recovered from it. */
  name: string;
}

/**
 * Seven slots are part of the protocol, not configuration. A panel changes how
 * each judge reasons, never how many judges exist (T-01, ARCHITECTURE §2.2).
 */
const SLOTS: readonly { role: "advocate" | "judge"; instance: number; stance: Stance | null }[] = [
  { role: "advocate", instance: 1, stance: "justified" },
  { role: "advocate", instance: 2, stance: "justified" },
  { role: "advocate", instance: 3, stance: "not_justified" },
  { role: "advocate", instance: 4, stance: "not_justified" },
  { role: "judge", instance: 1, stance: null },
  { role: "judge", instance: 2, stance: null },
  { role: "judge", instance: 3, stance: null },
];

/** Judge panels. `control` is an evaluation baseline and is not selectable by default. */
export const JUDGE_PANELS: Record<PanelName, readonly [string, string, string]> = {
  ethical: ["ethical/duty", "ethical/consequences", "ethical/character"],
  evidentiary: ["evidentiary/high_bar", "evidentiary/balance", "evidentiary/benefit_of_doubt"],
  analytical: ["analytical/strongest", "analytical/assumptions", "analytical/gaps"],
  control: ["control/uniform", "control/uniform", "control/uniform"],
};

/**
 * Panels available when a user creates a case. `control` is intentionally
 * excluded: three identical judges are an evaluation baseline, not a product mode.
 */
export const SELECTABLE_PANELS = ["ethical", "evidentiary", "analytical"] as const;
export type SelectablePanel = (typeof SELECTABLE_PANELS)[number];

const PANEL_META: Record<SelectablePanel, { title: string; summary: string }> = {
  ethical: {
    title: "Ethical frameworks",
    summary: "Duties, consequences, and character offer three views of what makes a decision defensible.",
  },
  evidentiary: {
    title: "Evidentiary standards",
    summary: "A high burden of proof, balanced evidence, and the benefit of the doubt for the defendant.",
  },
  analytical: {
    title: "Analytical review",
    summary: "The strongest arguments, unsupported assumptions, and gaps in the case narrative.",
  },
};

/** Panel descriptions come from the server so product copy is not duplicated in the client. */
export function selectablePanels(): { name: SelectablePanel; title: string; summary: string; lenses: string[] }[] {
  return SELECTABLE_PANELS.map(name => ({
    name,
    title: PANEL_META[name].title,
    summary: PANEL_META[name].summary,
    lenses: JUDGE_PANELS[name].map(lens => LENS_LABELS[lens] ?? lens),
  }));
}

/** Advocate grounds in slot order 1..4, symmetric across the two stances. */
export const ADVOCATE_SCHEMES: Record<AdvocateScheme, readonly [string, string, string, string]> = {
  grounds: ["ex_ante", "ex_post", "ex_ante", "ex_post"],
  control: ["flat", "flat", "flat", "flat"],
};

/** UI labels: judge disagreement is meaningful only when shown with each lens. */
export const LENS_LABELS: Record<string, string> = {
  "ethical/duty": "Duties and rules",
  "ethical/consequences": "Consequences and costs",
  "ethical/character": "Intent and character",
  "evidentiary/high_bar": "High burden of proof",
  "evidentiary/balance": "Balance of established facts",
  "evidentiary/benefit_of_doubt": "Benefit of the doubt",
  "analytical/strongest": "Strongest argument from each side",
  "analytical/assumptions": "Unsupported assumptions",
  "analytical/gaps": "Gaps in the case",
  "control/uniform": "No assigned lens",
  ex_ante: "At the time of the decision",
  ex_post: "Consequences and proportionality",
  flat: "No assigned ground",
};

export function activeRoles(
  panel: PanelName = config.JUDGE_PANEL,
  scheme: AdvocateScheme = config.ADVOCATE_SCHEME,
): RoleSlot[] {
  const lenses = JUDGE_PANELS[panel];
  const grounds = ADVOCATE_SCHEMES[scheme];
  return SLOTS.map(slot => {
    if (slot.role === "advocate") {
      const ground = grounds[slot.instance - 1] ?? "flat";
      return { ...slot, lens: ground, name: `advocate.${slot.instance}.${ground}` };
    }
    const lens = lenses[slot.instance - 1] ?? "control/uniform";
    return { ...slot, lens, name: `judge.${slot.instance}.${panel}` };
  });
}

/** Slots for the current configuration. */
export const roles: RoleSlot[] = activeRoles();

export function panelOf(promptName: string): string | null {
  const parts = promptName.split(".");
  return parts[0] === "judge" && parts.length === 3 ? parts[2]! : null;
}

/** Every panel and scheme slot, used for name resolution and lock-file verification. */
function allSlots(): RoleSlot[] {
  const seen = new Map<string, RoleSlot>();
  for (const panel of Object.keys(JUDGE_PANELS) as PanelName[]) {
    for (const scheme of Object.keys(ADVOCATE_SCHEMES) as AdvocateScheme[]) {
      for (const slot of activeRoles(panel, scheme)) seen.set(slot.name, slot);
    }
  }
  return [...seen.values()];
}

export function lensLabelFor(promptName: string): string | null {
  const slot = allSlots().find(s => s.name === promptName);
  return slot ? LENS_LABELS[slot.lens] ?? null : null;
}

// --- composition ---------------------------------------------------------

const fileCache = new Map<string, string>();
async function block(relative: string): Promise<string> {
  const cached = fileCache.get(relative);
  if (cached !== undefined) return cached;
  const text = await readFile(path.resolve("prompts", relative), "utf8");
  fileCache.set(relative, text);
  return text;
}

let versionTable: Record<string, string> | null = null;
async function versions(): Promise<Record<string, string>> {
  if (!versionTable) {
    versionTable = JSON.parse(await readFile(path.resolve("prompts", "versions.json"), "utf8")) as Record<string, string>;
  }
  return versionTable;
}

/**
 * Block order matters: guardrails and the role contract precede case data,
 * creating a long shared prefix for prompt caching (ARCHITECTURE §14.7).
 */
function blocksFor(slot: RoleSlot): string[] {
  if (slot.role === "advocate") {
    return ["shared/guardrails.md", "advocate/core.md",
      `advocate/stance/${slot.stance}.md`, `advocate/ground/${slot.lens}.md`];
  }
  return ["shared/guardrails.md", "judge/core.md", `judge/lens/${slot.lens}.md`];
}

export interface ComposedPrompt {
  text: string; hash: Buffer; version: string; lens: string; label: string | null;
}

export async function promptFor(name: string): Promise<ComposedPrompt> {
  const slot = allSlots().find(s => s.name === name);
  if (!slot) throw new Error("unknown_prompt");
  const paths = blocksFor(slot);
  const [table, parts] = await Promise.all([versions(), Promise.all(paths.map(block))]);
  const text = parts.join("\n\n---\n\n");
  // Versions are composed from block versions in a fixed order. Updating a
  // shared block must change the identity of every prompt that includes it (PV-1).
  const version = paths.map(p => table[p] ?? "0.0.0").join("+");
  return {
    text,
    hash: createHash("sha256").update(text).digest(),
    version,
    lens: slot.lens,
    label: LENS_LABELS[slot.lens] ?? null,
  };
}

// --- lock ----------------------------------------------------------------

export interface PromptLock { slots: Record<string, { version: string; hash: string }> }

export async function computeLock(): Promise<PromptLock> {
  const slots: PromptLock["slots"] = {};
  for (const slot of allSlots().sort((a, b) => a.name.localeCompare(b.name))) {
    const prompt = await promptFor(slot.name);
    slots[slot.name] = { version: prompt.version, hash: prompt.hash.toString("hex") };
  }
  return { slots };
}

/**
 * PV-2: content that differs from its locked hash is a startup error. Without
 * this check, prompt edits would change product behavior without an audit trail.
 */
export async function verifyPromptLock(): Promise<void> {
  const raw = await readFile(path.resolve("prompts", "prompts.lock.json"), "utf8");
  const locked = JSON.parse(raw) as PromptLock;
  const current = await computeLock();
  const names = new Set([...Object.keys(locked.slots), ...Object.keys(current.slots)]);
  const problems: string[] = [];
  for (const name of names) {
    const was = locked.slots[name];
    const now = current.slots[name];
    if (!was) { problems.push(`${name}: missing from prompts.lock.json`); continue; }
    if (!now) { problems.push(`${name}: present in lock but cannot be composed`); continue; }
    if (was.hash !== now.hash) {
      problems.push(was.version === now.version
        ? `${name}: content changed without a version bump (${now.version})`
        : `${name}: version ${was.version} → ${now.version}; run npm run prompts:lock`);
    }
  }
  if (problems.length) throw new Error(`prompt_lock_mismatch: ${problems.join("; ")}`);
}
