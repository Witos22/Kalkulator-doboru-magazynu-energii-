import { test } from "node:test";
import assert from "node:assert/strict";
import { getProductByModel } from "../catalog/product-catalog.js";
import { BessStateMachine } from "./bess-state-machine.js";
import { bessPowerKw } from "./bess-power.js";
import { TariffArbitrageStrategy } from "../strategies/tariff-arbitrage.js";
import { createTariffSchedule } from "../types/tariff.js";
import { kwhPerStepToKw } from "../utils/energy-math.js";

test("LUNA2000-10 × 2 oddaje najwyżej 1,25 kWh w kroku 15 min", () => {
  const product = getProductByModel("LUNA2000-10-S0");
  assert.ok(product);
  assert.equal(bessPowerKw(product, 2, 5), 5);

  const bess = new BessStateMachine({ product, moduleCount: 2, inverterBatteryKw: 5 });
  const delivered = bess.discharge(10).dischargedKwh;
  assert.ok(Math.abs(delivered - 1.25) < 1e-9);
});

test("falownik 5 kW przy poborze 8 kW zostawia z sieci co najmniej 3 kW", () => {
  const product = getProductByModel("LUNA2000-10-S0");
  assert.ok(product);
  const tariff = createTariffSchedule("G12");
  const strategy = new TariffArbitrageStrategy(tariff, true);
  const bess = new BessStateMachine({ product, moduleCount: 2, inverterBatteryKw: 5, allowGridCharge: true });
  const step = strategy.execute(
    { timestamp: new Date(Date.UTC(2024, 6, 16, 12, 0)), loadKw: 8, pvProductionKw: 0 },
    bess,
    { pvSizeKwp: 6, contractedPowerKw: 0, bessConfig: { product, moduleCount: 2, inverterBatteryKw: 5, allowGridCharge: true } },
  );
  assert.ok(kwhPerStepToKw(step.gridImportKwh) >= 3);
  assert.ok(step.bessDischargedKwh <= 1.25 + 1e-9);
});
