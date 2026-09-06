import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { indictmentSchema } from "../schemas.js";
import type { Indictment, Stance } from "../types.js";

/**
 * Evaluation fixtures.
 *
 * Indictments are validated with the same `indictmentSchema` the API uses, so a
 * fixture that the product would reject cannot silently enter an evaluation.
 *
 * Fixtures deliberately record no expected decision. Tribunal never decides
 * which decision is correct, so treating one as ground truth would smuggle a
 * verdict-quality judgement into the harness. What a fixture does fix is the
 * evidence: four reference arguments, identical for every model, so that judge
 * behaviour can be compared without advocate variance leaking into the result.
 */

const referenceArgument = z.object({
  instance_no: z.number().int().min(1).max(4),
  position: z.enum(["justified", "not_justified"]),
  reasoning: z.string().trim().min(200).max(4000),
}).strict();

const fixtureSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "fixture ids are stable kebab-case slugs"),
  label: z.string().min(3).max(120),
  domain: z.string().min(3).max(60),
  ambiguity: z.enum(["balanced", "leaning"]),
  note: z.string().min(3).max(300),
  indictment: indictmentSchema,
  reference_arguments: z.array(referenceArgument).length(4),
}).strict();

const fileSchema = z.object({
  format_version: z.string(),
  description: z.string(),
  cases: z.array(fixtureSchema).min(1),
}).strict();

export interface ReferenceArgument {
  readonly instance_no: number;
  readonly position: Stance;
  readonly reasoning: string;
}

export interface Fixture {
  readonly id: string;
  readonly label: string;
  readonly domain: string;
  readonly ambiguity: "balanced" | "leaning";
  readonly note: string;
  readonly indictment: Indictment;
  readonly reference_arguments: readonly ReferenceArgument[];
}

export const FIXTURES_PATH = path.join("evaluation", "fixtures.json");

/** Advocates 1-2 argue `justified` and 3-4 argue `not_justified` (T-02). */
const EXPECTED_STANCES: readonly Stance[] = ["justified", "justified", "not_justified", "not_justified"];

export function assertFixtureShape(fixture: Fixture): void {
  const instances = fixture.reference_arguments.map(a => a.instance_no).sort((a, b) => a - b);
  if (instances.join(",") !== "1,2,3,4") {
    throw new Error(`fixture ${fixture.id}: reference arguments must cover advocate instances 1..4`);
  }
  for (const argument of fixture.reference_arguments) {
    const expected = EXPECTED_STANCES[argument.instance_no - 1];
    if (argument.position !== expected) {
      throw new Error(
        `fixture ${fixture.id}: advocate ${argument.instance_no} must argue ${expected}, not ${argument.position}`,
      );
    }
  }
}

export async function loadFixtures(file: string = FIXTURES_PATH): Promise<Fixture[]> {
  const parsed = fileSchema.parse(JSON.parse(await readFile(path.resolve(file), "utf8")));
  const seen = new Set<string>();
  const fixtures = parsed.cases.map(entry => {
    if (seen.has(entry.id)) throw new Error(`duplicate fixture id: ${entry.id}`);
    seen.add(entry.id);
    return entry as Fixture;
  });
  for (const fixture of fixtures) assertFixtureShape(fixture);
  // Stable order keeps every report reproducible regardless of file ordering.
  return fixtures.sort((a, b) => a.id.localeCompare(b.id));
}

export function selectFixtures(all: readonly Fixture[], ids: readonly string[] | undefined): Fixture[] {
  if (!ids || ids.length === 0) return [...all];
  const index = new Map(all.map(f => [f.id, f]));
  return ids.map(id => {
    const found = index.get(id);
    if (!found) throw new Error(`unknown fixture id: ${id}`);
    return found;
  });
}
