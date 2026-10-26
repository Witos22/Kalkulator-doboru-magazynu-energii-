import { test } from "node:test";
import assert from "node:assert/strict";
import { replacementPlan, suggestStorageSize } from "./storage-sizing.js";

test("wymiana wypada po krótszym z limitów: gwarancja albo cykle", () => {
  const byWarranty = replacementPlan(10, 6_000, 200, 15);
  assert.equal(byWarranty.replacementYear, 11);
  assert.match(byWarranty.replacementReason, /gwarancj/);

  const byCycles = replacementPlan(10, 6_000, 1_000, 15);
  assert.equal(byCycles.replacementYear, 7);
  assert.match(byCycles.replacementReason, /cykl/);

  const withinHorizon = replacementPlan(15, 12_000, 100, 15);
  assert.equal(withinHorizon.replacementYear, null);
});

test("sugerowana pojemność i moc z godzin profilu", () => {
  const load: { timestamp: Date; loadKw: number }[] = [];
  const evening = Date.UTC(2024, 2, 15, 16, 0);
  for (let step = 0; step < 16 * 4; step++) {
    load.push({ timestamp: new Date(evening + step * 15 * 60_000), loadKw: 1 });
  }
  load.push({ timestamp: new Date(Date.UTC(2024, 2, 15, 12, 0)), loadKw: 100 });
  for (let step = 0; step < 20; step++) {
    load.push({ timestamp: new Date(Date.UTC(2024, 0, 15, 18, 0)), loadKw: 10 });
  }

  const suggestion = suggestStorageSize(load);
  assert.ok(Math.abs(suggestion.suggestedCapacityKwh - 16) < 1e-9);
  assert.equal(suggestion.suggestedPowerKw, 10);
});
