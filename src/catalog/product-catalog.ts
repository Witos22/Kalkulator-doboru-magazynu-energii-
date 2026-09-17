import type { BessProduct } from "../types/bess.js";

// ─── Huawei LUNA2000 S0 Series ────────────────────────────────
// Legacy generation: 5 kWh modules (LUNA2000-5-E0)
// Control module: LUNA2000-5KW-C0 (included in system price)
// Max power capped at 5 kW by C0 module
// Max 2 towers parallel = 30 kWh per inverter
// Prices from EU distributor (inc VAT), converted to PLN at ~4.3 PLN/EUR

const HUAWEI_S0: readonly BessProduct[] = [
  {
    manufacturer: "Huawei",
    model: "LUNA2000-5-S0",
    usableCapacityKwh: 5.0,
    maxChargePowerKw: 2.5,
    maxDischargePowerKw: 2.5,
    roundTripEfficiency: 0.95,
    dodPercent: 100,
    cycleLife: 6_000,
    degradationPerYear: 0.02,
    warrantyYears: 10,
    pricePerUnitPln: 14_400, // €3,346 inc VAT × 4.3
    isModular: true,
    maxModules: 2, // max 2 towers parallel
  },
  {
    manufacturer: "Huawei",
    model: "LUNA2000-10-S0",
    usableCapacityKwh: 10.0,
    maxChargePowerKw: 5.0,
    maxDischargePowerKw: 5.0,
    roundTripEfficiency: 0.95,
    dodPercent: 100,
    cycleLife: 6_000,
    degradationPerYear: 0.02,
    warrantyYears: 10,
    pricePerUnitPln: 24_600, // €5,718 inc VAT × 4.3
    isModular: true,
    maxModules: 2,
  },
  {
    manufacturer: "Huawei",
    model: "LUNA2000-15-S0",
    usableCapacityKwh: 15.0,
    maxChargePowerKw: 5.0,
    maxDischargePowerKw: 5.0,
    roundTripEfficiency: 0.95,
    dodPercent: 100,
    cycleLife: 6_000,
    degradationPerYear: 0.02,
    warrantyYears: 10,
    pricePerUnitPln: 34_800, // €8,092 inc VAT × 4.3
    isModular: true,
    maxModules: 2,
  },
] as const;

// ─── Huawei LUNA2000 S1 Series ────────────────────────────────
// Newer flagship: 6.9 kWh modules (LUNA2000-7-E1)
// Control module: LUNA2000-10KW-C1 (10 kW rated, included in system price)
// Module+ Architecture: independent DC-DC optimizer per module
// 12,000+ cycle life, 15 year warranty
// Cable-free stacking, 5-layer safety, -20°C to +55°C
// Max 4 towers parallel = 82.8 kWh (residential: typically 2)

const HUAWEI_S1: readonly BessProduct[] = [
  {
    manufacturer: "Huawei",
    model: "LUNA2000-7-S1",
    usableCapacityKwh: 6.9,
    maxChargePowerKw: 3.5,
    maxDischargePowerKw: 3.5,
    roundTripEfficiency: 0.951,
    dodPercent: 100,
    cycleLife: 12_000,
    degradationPerYear: 0.015, // better cell tech → ~1.5%/yr
    warrantyYears: 15,
    pricePerUnitPln: 19_700, // €4,582 inc VAT × 4.3
    isModular: true,
    maxModules: 2, // residential practical limit
  },
  {
    manufacturer: "Huawei",
    model: "LUNA2000-14-S1",
    usableCapacityKwh: 13.8,
    maxChargePowerKw: 7.0,
    maxDischargePowerKw: 7.0,
    roundTripEfficiency: 0.951,
    dodPercent: 100,
    cycleLife: 12_000,
    degradationPerYear: 0.015,
    warrantyYears: 15,
    pricePerUnitPln: 34_200, // €7,948 inc VAT × 4.3
    isModular: true,
    maxModules: 2,
  },
  {
    manufacturer: "Huawei",
    model: "LUNA2000-21-S1",
    usableCapacityKwh: 20.7,
    maxChargePowerKw: 10.5,
    maxDischargePowerKw: 10.5,
    roundTripEfficiency: 0.951,
    dodPercent: 100,
    cycleLife: 12_000,
    degradationPerYear: 0.015,
    warrantyYears: 15,
    pricePerUnitPln: 48_700, // €11,316 inc VAT × 4.3
    isModular: true,
    maxModules: 2,
  },
] as const;

// ─── Sigenergy SigenStor Series ───────────────────────────────
// All-in-One 5-in-1: Hybrid Inverter + Battery + EMS + optional DC EV Charger + Gateway
// Pack-level DC-DC optimizer allows mixing module sizes and ages
// IP66, built-in heating pads (-20°C), integrated fire suppression
// Up to 6 modules per tower
// NOTE: SigenStor is all-in-one (includes inverter), so comparing
// price directly with Huawei (battery-only) is not apples-to-apples.
// Huawei requires a separate SUN2000 hybrid inverter (~5,000-10,000 PLN).

const SIGENERGY: readonly BessProduct[] = [
  {
    manufacturer: "Sigenergy",
    model: "SigenStor BAT 5.0",
    usableCapacityKwh: 5.2,
    maxChargePowerKw: 2.5,
    maxDischargePowerKw: 2.5,
    roundTripEfficiency: 0.95,
    dodPercent: 100,
    cycleLife: 10_000,
    degradationPerYear: 0.015,
    warrantyYears: 10,
    pricePerUnitPln: 9_000, // mid-range estimate ~8,000-9,500 PLN/module
    isModular: true,
    maxModules: 6,
  },
  {
    manufacturer: "Sigenergy",
    model: "SigenStor BAT 6.0",
    usableCapacityKwh: 5.84,
    maxChargePowerKw: 3.0,
    maxDischargePowerKw: 3.0,
    roundTripEfficiency: 0.955,
    dodPercent: 100,
    cycleLife: 10_000,
    degradationPerYear: 0.015,
    warrantyYears: 10,
    pricePerUnitPln: 9_000, // ~8,000-10,000 PLN/module
    isModular: true,
    maxModules: 6,
  },
  {
    manufacturer: "Sigenergy",
    model: "SigenStor BAT 8.0",
    usableCapacityKwh: 7.8,
    maxChargePowerKw: 4.0,
    maxDischargePowerKw: 4.0,
    roundTripEfficiency: 0.95,
    dodPercent: 100,
    cycleLife: 10_000,
    degradationPerYear: 0.015,
    warrantyYears: 10,
    pricePerUnitPln: 11_500, // ~10,000-12,500 PLN/module
    isModular: true,
    maxModules: 6,
  },
  {
    manufacturer: "Sigenergy",
    model: "SigenStor BAT 10.0",
    usableCapacityKwh: 8.76,
    maxChargePowerKw: 4.6,
    maxDischargePowerKw: 4.6,
    roundTripEfficiency: 0.955,
    dodPercent: 100,
    cycleLife: 10_000,
    degradationPerYear: 0.015,
    warrantyYears: 10,
    pricePerUnitPln: 11_500, // ~9,900-13,000 PLN/module
    isModular: true,
    maxModules: 6,
  },
] as const;

// ─── Combined Catalog ────────────────────────────────────────

/**
 * Complete product catalog — Huawei LUNA2000 (S0 + S1) and Sigenergy SigenStor.
 *
 * Prices sourced from EU distributor screenshots (inc VAT), converted to PLN.
 * Last updated: Q3 2026.
 */
export const PRODUCT_CATALOG: readonly BessProduct[] = [
  ...HUAWEI_S0,
  ...HUAWEI_S1,
  ...SIGENERGY,
];

/**
 * Gets products filtered by manufacturer name (case-insensitive).
 */
export function getProductsByManufacturer(manufacturer: string): BessProduct[] {
  return PRODUCT_CATALOG.filter(
    (p) => p.manufacturer.toLowerCase() === manufacturer.toLowerCase(),
  );
}

/**
 * Gets products filtered by series (e.g., "S0", "S1", "BAT").
 */
export function getProductsBySeries(seriesKeyword: string): BessProduct[] {
  return PRODUCT_CATALOG.filter(
    (p) => p.model.toLowerCase().includes(seriesKeyword.toLowerCase()),
  );
}

/**
 * Gets all products from the catalog.
 */
export function getAllProducts(): readonly BessProduct[] {
  return PRODUCT_CATALOG;
}

/**
 * Gets product by exact model name.
 */
export function getProductByModel(model: string): BessProduct | undefined {
  return PRODUCT_CATALOG.find(
    (p) => p.model.toLowerCase() === model.toLowerCase(),
  );
}
