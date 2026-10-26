import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadDeviceDatabase } from "./device-database.js";
import { getProductByModel } from "./product-catalog.js";
import { inverterPaths } from "./inverter-decision.js";
import type { InverterSite } from "./inverter-decision.js";
import { FinancialCalculator, DEFAULT_FINANCIAL_CONFIG } from "../engine/financial-calculator.js";
import { TariffArbitrageStrategy } from "../strategies/tariff-arbitrage.js";
import { BessStateMachine } from "../bess/bess-state-machine.js";
import { buildAssumptions } from "../analysis-runner.js";
import { createTariffSchedule } from "../types/tariff.js";
import type { BessConfig } from "../types/bess.js";
import type { SimulationResult } from "../types/simulation.js";
import type { AnalysisParams } from "../analysis-runner.js";

function site(patch: Partial<InverterSite> & Pick<InverterSite, "hasExistingPv" | "planes" | "pvKwp" | "compatibleInverterIds" | "replacementCostNetPln">): InverterSite {
  const db = loadDeviceDatabase();
  return {
    builtInInverter: false,
    inverters: db.inverters,
    ...patch,
  };
}

function lunaIds(): readonly string[] {
  const storage = loadDeviceDatabase().storages.find((item) => item.id === "luna2000-5-s0");
  assert.ok(storage);
  return storage.compatibleInverterIds;
}

describe("decyzja o falowniku", () => {
  test("brak PV: hybryda w koszcie PV, bez dopłaty, z ładowaniem z sieci", () => {
    const paths = inverterPaths(site({
      hasExistingPv: false,
      planes: [],
      pvKwp: 6,
      phases: 3,
      compatibleInverterIds: lunaIds(),
      replacementCostNetPln: 8_000,
    }));
    assert.equal(paths.length, 1);
    assert.equal(paths[0]!.coupling, "DC");
    assert.equal(paths[0]!.inverterCostNetPln, 0);
    assert.equal(paths[0]!.rteFactor, 1);
    assert.equal(paths[0]!.allowGridCharge, true);
  });

  test("SUN2000 M1 + LUNA: sprzężenie DC i 0 zł", () => {
    const paths = inverterPaths(site({
      hasExistingPv: true,
      planes: [{ brand: "Huawei", model: "SUN2000-5KTL-M1" }],
      pvKwp: 6,
      compatibleInverterIds: lunaIds(),
      replacementCostNetPln: 8_000,
    }));
    assert.equal(paths.length, 1);
    assert.equal(paths[0]!.inverterCostNetPln, 0);
    assert.equal(paths[0]!.coupling, "DC");
    assert.equal(paths[0]!.allowGridCharge, true);
    assert.match(paths[0]!.label, /SUN2000-5KTL-M1/);
  });

  test("Fronius Symo + LUNA: AC albo wymiana na hybrydę", () => {
    const paths = inverterPaths(site({
      hasExistingPv: true,
      planes: [{ brand: "Fronius", model: "Symo 10.0-3-M" }],
      pvKwp: 8,
      compatibleInverterIds: lunaIds(),
      replacementCostNetPln: 8_000,
    }));
    assert.equal(paths.length, 2);
    const ac = paths.find((item) => item.coupling === "AC");
    const dc = paths.find((item) => item.coupling === "DC");
    assert.ok(ac);
    assert.ok(dc);
    assert.equal(ac.inverterCostNetPln, 0);
    assert.equal(ac.rteFactor, 0.95);
    assert.equal(ac.allowGridCharge, false);
    assert.equal(dc.inverterCostNetPln, 8_000);
    assert.equal(dc.allowGridCharge, true);
    assert.match(dc.label, /SUN2000-8KTL-M1/);
  });

  test("nie wiem daje dwa warianty i zdanie w założeniach", () => {
    const paths = inverterPaths(site({
      hasExistingPv: true,
      planes: [{ brand: "nie wiem" }],
      pvKwp: 6,
      phases: 3,
      compatibleInverterIds: lunaIds(),
      replacementCostNetPln: 8_000,
    }));
    assert.equal(paths.length, 2);
    assert.ok(paths.some((item) => item.coupling === "AC" && item.allowGridCharge === false));
    assert.ok(paths.some((item) => item.coupling === "DC" && item.inverterCostNetPln === 8_000));

    const params: AnalysisParams = {
      adapter: "moj-licznik-daily",
      tariff: "G12",
      lat: 52.23,
      lon: 21.01,
      contractedPowerKw: 0,
      existingPvKwp: 6,
      tilt: 35,
      azimuth: 180,
      installations: [{
        kwp: 6,
        tilt: 35,
        azimuth: 180,
        inverterBrand: "nie wiem",
        inverterAcKw: 5,
      }],
    };
    const lines = buildAssumptions(params, DEFAULT_FINANCIAL_CONFIG, "sugestia kalkulatora", "prosument", 4500);
    assert.ok(lines.some((line) => line.includes("Falownik jest nieznany") && line.includes("0,95") && line.includes("NPV")));
  });

  test("koszt z decyzji wygrywa ze starym doliczeniem po marce", () => {
    const product = getProductByModel("LUNA2000-5-S0");
    assert.ok(product);
    const config: BessConfig = { product, moduleCount: 1, inverterCostNetPln: 0, allowGridCharge: true, coupling: "DC" };
    const empty: SimulationResult = {
      bessConfig: config,
      pvSizeKwp: 6,
      totalLoadKwh: 0,
      totalPvProductionKwh: 0,
      totalSelfConsumedKwh: 0,
      totalGridImportKwh: 0,
      totalGridExportKwh: 0,
      totalCurtailedKwh: 0,
      totalBessChargedKwh: 0,
      totalBessDischargedKwh: 0,
      selfConsumptionRate: 0,
      autarkyRate: 0,
      peakGridImportKw: 0,
      annualCycles: 1,
      dailyCyclesSeasonPv: 0,
      storageUtilizationPercent: 0,
      steps: [],
    };
    const result = new FinancialCalculator().calculate(
      empty,
      empty,
      createTariffSchedule("G11"),
      0,
      "prosument",
      [],
    );
    assert.equal(result.inverterUpgradeCostPln, 0);
    assert.ok(result.pvInvestmentCostPln > 0);
  });

  test("arbitraż z sieci jest wyłączony, gdy falownik nie ładuje z sieci", () => {
    const product = getProductByModel("LUNA2000-5-S0");
    assert.ok(product);
    const tariff = createTariffSchedule("G12");
    const strategy = new TariffArbitrageStrategy(tariff, true);
    const night = new Date(2024, 0, 15, 2, 0, 0);
    const record = { timestamp: night, loadKw: 0, pvProductionKw: 0 };
    const charged = (allowGridCharge: boolean): number => {
      const bess = new BessStateMachine({ product, moduleCount: 1, allowGridCharge });
      return strategy.execute(record, bess, {
        pvSizeKwp: 6,
        contractedPowerKw: 0,
        bessConfig: { product, moduleCount: 1, allowGridCharge },
      }).bessChargedFromGridKwh;
    };
    assert.ok(charged(true) > 0);
    assert.equal(charged(false), 0);
  });
});
