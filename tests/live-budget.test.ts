import assert from "node:assert/strict";
import test from "node:test";
import { BudgetError, BudgetLedger, parseBudgetUsd } from "../src/live/budget.js";

test("budget: an empty, zero, negative, or malformed limit is rejected", () => {
  for (const bad of ["", "   ", "0", "-1", "abc", "1.2.3", "NaN", "Infinity", "1e5", undefined, null]) {
    assert.throws(() => parseBudgetUsd(bad as string | undefined), /budget_invalid/, `expected rejection for ${String(bad)}`);
  }
  assert.equal(parseBudgetUsd("0.25"), 0.25);
  assert.equal(parseBudgetUsd(" 1 "), 1);
});

test("budget: a ledger cannot be created with a non-positive limit", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new BudgetLedger(bad), /budget_invalid/);
  }
});

test("budget: a reservation larger than the remaining limit is refused", () => {
  const ledger = new BudgetLedger(1);
  ledger.reserve(0.9);
  assert.throws(() => ledger.reserve(0.2), (error: unknown) => {
    assert.ok(error instanceof BudgetError);
    assert.equal(error.code, "budget_exhausted");
    return true;
  });
});

test("budget: settling records the real cost even when it differs from the estimate", () => {
  const ledger = new BudgetLedger(1);
  const first = ledger.reserve(0.5);
  ledger.settle(first, 0.1);
  assert.equal(ledger.spentUsd, 0.1);
  assert.equal(ledger.reservedUsd, 0, "the held estimate is released on settle");
  assert.equal(ledger.remainingUsd, 0.9);

  // A failed call still releases its hold and may still have been billed.
  const second = ledger.reserve(0.5);
  ledger.settle(second, 0.2);
  assert.ok(Math.abs(ledger.spentUsd - 0.3) < 1e-9, `expected 0.3, got ${ledger.spentUsd}`);
});

test("budget: a released reservation costs nothing", () => {
  const ledger = new BudgetLedger(1);
  const reservation = ledger.reserve(0.4);
  ledger.release(reservation);
  assert.equal(ledger.spentUsd, 0);
  assert.equal(ledger.remainingUsd, 1);
});

test("budget: concurrent reservations never exceed the approved limit", async () => {
  const ledger = new BudgetLedger(1);
  const each = 0.3;
  // Ten callers race for a limit that fits only three of them.
  const attempts = await Promise.all(
    Array.from({ length: 10 }, async () => {
      await Promise.resolve();
      try { ledger.reserve(each); return "granted"; } catch { return "refused"; }
    }),
  );
  const granted = attempts.filter(a => a === "granted").length;
  assert.equal(granted, 3, "only three reservations of 0.3 fit inside 1.0");
  assert.ok(ledger.reservedUsd <= ledger.approvedUsd, "reserved must never exceed approved");
  assert.ok(Math.abs(ledger.reservedUsd - 0.9) < 1e-9);
});

test("budget: an overrun is reported rather than hidden", () => {
  const ledger = new BudgetLedger(0.1);
  const reservation = ledger.reserve(0.1);
  // A provider may bill more than the conservative estimate predicted.
  ledger.settle(reservation, 0.5);
  assert.equal(ledger.overrun, true);
  assert.equal(ledger.snapshot().spentUsd, 0.5);
});
