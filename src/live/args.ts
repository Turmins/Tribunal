/**
 * Minimal argument parsing for the guarded live tools.
 *
 * Unknown flags are rejected rather than ignored: a mistyped `--exceute` must
 * not silently leave a run in dry-run mode while the operator believes it
 * executed, and a mistyped budget flag must not silently drop a limit.
 *
 * Credentials are refused outright. The key is read from the server environment
 * only, because an argument appears in shell history, process listings, and CI
 * logs.
 */

export class ArgError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ArgError";
  }
}

const CREDENTIAL_FLAG = /(key|token|secret|password|authorization|bearer)/i;

export type FlagValue = string | true;

export function parseArgs(argv: readonly string[], allowed: readonly string[]): Map<string, FlagValue> {
  const known = new Set(allowed);
  const out = new Map<string, FlagValue>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) throw new ArgError("unexpected_argument", `Unexpected argument: ${token}`);
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    if (CREDENTIAL_FLAG.test(name)) {
      throw new ArgError(
        "credential_flag_refused",
        `Refusing --${name}. Credentials are read from the server environment only, never from the command line.`,
      );
    }
    if (!known.has(name)) throw new ArgError("unknown_flag", `Unknown flag: --${name}`);
    if (eq !== -1) { out.set(name, body.slice(eq + 1)); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { out.set(name, true); continue; }
    out.set(name, next);
    i += 1;
  }
  return out;
}

export function stringFlag(flags: Map<string, FlagValue>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new ArgError("missing_value", `--${name} requires a value`);
  return value;
}

export function boolFlag(flags: Map<string, FlagValue>, name: string): boolean {
  const value = flags.get(name);
  if (value === undefined) return false;
  if (value === true) return true;
  const text = value.toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  throw new ArgError("invalid_value", `--${name} takes no value`);
}

export function listFlag(flags: Map<string, FlagValue>, name: string): string[] | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const items = value.split(",").map(part => part.trim()).filter(Boolean);
  if (items.length === 0) throw new ArgError("invalid_value", `--${name} requires at least one value`);
  return items;
}

export function numberFlag(flags: Map<string, FlagValue>, name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/.test(value.trim())) {
    throw new ArgError("invalid_value", `--${name} must be a non-negative number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ArgError("invalid_value", `--${name} must be a finite number`);
  return parsed;
}
