/**
 * Spend ledger for guarded live model runs.
 *
 * Every paid call must reserve its conservative worst-case cost before the
 * request leaves the process, and settle the real billed cost afterwards. A
 * reservation that is only checked after the fact cannot stop an overrun, so
 * `reserve()` is deliberately synchronous: it validates and mutates without an
 * intervening `await`, which makes the check-and-commit atomic against every
 * other caller on the event loop. Concurrent callers therefore cannot both pass
 * a check that only one of them fits.
 */

export class BudgetError extends Error {
  constructor(
    readonly code: "budget_invalid" | "budget_exhausted",
    readonly detail: Readonly<Record<string, number>> = {},
  ) {
    super(code);
    this.name = "BudgetError";
  }
}

export interface Reservation {
  readonly id: number;
  readonly estimateUsd: number;
}

/** Reject anything that would make a limit meaningless: empty, zero, negative, or not a number. */
export function parseBudgetUsd(raw: string | undefined | null): number {
  if (raw === undefined || raw === null) throw new BudgetError("budget_invalid");
  const text = String(raw).trim();
  if (!text) throw new BudgetError("budget_invalid");
  // Number("") is 0 and Number(" 1 ") is 1, so the shape is checked explicitly.
  if (!/^\d+(\.\d+)?$/.test(text)) throw new BudgetError("budget_invalid");
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new BudgetError("budget_invalid");
  return value;
}

export class BudgetLedger {
  #approved: number;
  #reserved = 0;
  #spent = 0;
  #nextId = 1;
  #open = new Map<number, number>();

  constructor(approvedUsd: number) {
    if (!Number.isFinite(approvedUsd) || approvedUsd <= 0) throw new BudgetError("budget_invalid");
    this.#approved = approvedUsd;
  }

  get approvedUsd(): number { return this.#approved; }
  get spentUsd(): number { return this.#spent; }
  get reservedUsd(): number { return this.#reserved; }
  /** Approved minus everything already spent or currently held by an open reservation. */
  get remainingUsd(): number { return this.#approved - this.#spent - this.#reserved; }
  /** True when settled cost exceeded the approved limit, which only a provider overcharge can cause. */
  get overrun(): boolean { return this.#spent > this.#approved; }

  /**
   * Hold `estimateUsd` against the limit. Throws before any network call when
   * the estimate does not fit, which is the only point where a run can still be
   * stopped for free.
   */
  reserve(estimateUsd: number): Reservation {
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) throw new BudgetError("budget_invalid");
    if (estimateUsd > this.remainingUsd) {
      throw new BudgetError("budget_exhausted", {
        approvedUsd: this.#approved,
        spentUsd: this.#spent,
        reservedUsd: this.#reserved,
        remainingUsd: this.remainingUsd,
        requestedUsd: estimateUsd,
      });
    }
    const id = this.#nextId++;
    this.#reserved += estimateUsd;
    this.#open.set(id, estimateUsd);
    return { id, estimateUsd };
  }

  /**
   * Close a reservation with the cost actually billed. A failed or contract-violating
   * response is still charged by the provider, so callers settle on failure too;
   * dropping it would understate spend (ARCHITECTURE §17.1).
   */
  settle(reservation: Reservation, actualCostUsd: number): void {
    const held = this.#open.get(reservation.id);
    if (held === undefined) throw new BudgetError("budget_invalid");
    this.#open.delete(reservation.id);
    this.#reserved -= held;
    const cost = Number.isFinite(actualCostUsd) && actualCostUsd > 0 ? actualCostUsd : 0;
    this.#spent += cost;
  }

  /** Close a reservation for a call that never reached the provider. */
  release(reservation: Reservation): void {
    this.settle(reservation, 0);
  }

  snapshot(): { approvedUsd: number; spentUsd: number; remainingUsd: number; overrun: boolean } {
    return {
      approvedUsd: round(this.#approved),
      spentUsd: round(this.#spent),
      remainingUsd: round(this.#approved - this.#spent),
      overrun: this.overrun,
    };
  }
}

/** Six decimals matches the `numeric(12,6)` cost column used for run accounting. */
export const round = (value: number): number => Math.round(value * 1e6) / 1e6;
