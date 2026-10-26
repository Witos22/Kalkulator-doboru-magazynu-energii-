import type { BessProduct } from "../types/bess.js";
import { loadDeviceDatabase } from "./device-database.js";
import type { StorageRecord } from "./device-database.js";

/**
 * Dane handlowe, których nie ma na karcie katalogowej (cena, montaż, szacunek strat).
 * Parametry elektryczne biorą się z `public/storages.json`.
 */
interface CommercialTerms {
  readonly roundTripEfficiency: number;
  readonly dodPercent: number;
  readonly cycleLife: number;
  readonly degradationPerYear: number;
  readonly warrantyYears: number;
  readonly pricePerUnitPln: number;
  readonly isModular: boolean;
  readonly maxModules: number;
  readonly requiredInverterBrand: string;
  readonly estimatedInverterUpgradeCostPln: number;
  readonly estimatedInstallationCostPln: number;
  readonly standbyPowerW: number;
}

const COMMERCIAL: Readonly<Record<string, CommercialTerms>> = {
  "luna2000-5-s0": {
    roundTripEfficiency: 0.95,
    dodPercent: 100,
    cycleLife: 6_000,
    degradationPerYear: 0.02,
    warrantyYears: 10,
    pricePerUnitPln: 14_400,
    isModular: true,
    maxModules: 2,
    requiredInverterBrand: "Huawei",
    estimatedInverterUpgradeCostPln: 8_000,
    estimatedInstallationCostPln: 3_000,
    standbyPowerW: 30,
  },
  "luna2000-10-s0": {
    roundTripEfficiency: 0.95,
    dodPercent: 100,
    cycleLife: 6_000,
    degradationPerYear: 0.02,
    warrantyYears: 10,
    pricePerUnitPln: 24_600,
    isModular: true,
    maxModules: 2,
    requiredInverterBrand: "Huawei",
    estimatedInverterUpgradeCostPln: 8_000,
    estimatedInstallationCostPln: 3_000,
    standbyPowerW: 30,
  },
  "luna2000-15-s0": {
    roundTripEfficiency: 0.95,
    dodPercent: 100,
    cycleLife: 6_000,
    degradationPerYear: 0.02,
    warrantyYears: 10,
    pricePerUnitPln: 34_800,
    isModular: true,
    maxModules: 2,
    requiredInverterBrand: "Huawei",
    estimatedInverterUpgradeCostPln: 8_000,
    estimatedInstallationCostPln: 3_500,
    standbyPowerW: 30,
  },
  "luna2000-7-s1": {
    roundTripEfficiency: 0.951,
    dodPercent: 100,
    cycleLife: 12_000,
    degradationPerYear: 0.015,
    warrantyYears: 15,
    pricePerUnitPln: 19_700,
    isModular: true,
    maxModules: 2,
    requiredInverterBrand: "Huawei",
    estimatedInverterUpgradeCostPln: 8_000,
    estimatedInstallationCostPln: 3_000,
    standbyPowerW: 30,
  },
  "luna2000-14-s1": {
    roundTripEfficiency: 0.951,
    dodPercent: 100,
    cycleLife: 12_000,
    degradationPerYear: 0.015,
    warrantyYears: 15,
    pricePerUnitPln: 34_200,
    isModular: true,
    maxModules: 2,
    requiredInverterBrand: "Huawei",
    estimatedInverterUpgradeCostPln: 8_000,
    estimatedInstallationCostPln: 3_500,
    standbyPowerW: 30,
  },
  "luna2000-21-s1": {
    roundTripEfficiency: 0.951,
    dodPercent: 100,
    cycleLife: 12_000,
    degradationPerYear: 0.015,
    warrantyYears: 15,
    pricePerUnitPln: 48_700,
    isModular: true,
    maxModules: 2,
    requiredInverterBrand: "Huawei",
    estimatedInverterUpgradeCostPln: 9_000,
    estimatedInstallationCostPln: 4_000,
    standbyPowerW: 30,
  },
  "sigenstor-bat-5": {
    roundTripEfficiency: 0.95,
    dodPercent: 100,
    cycleLife: 10_000,
    degradationPerYear: 0.015,
    warrantyYears: 10,
    pricePerUnitPln: 9_000,
    isModular: true,
    maxModules: 6,
    requiredInverterBrand: "Sigenergy",
    estimatedInverterUpgradeCostPln: 0,
    estimatedInstallationCostPln: 2_500,
    standbyPowerW: 30,
  },
  "sigenstor-bat-6": {
    roundTripEfficiency: 0.955,
    dodPercent: 100,
    cycleLife: 10_000,
    degradationPerYear: 0.015,
    warrantyYears: 10,
    pricePerUnitPln: 9_000,
    isModular: true,
    maxModules: 6,
    requiredInverterBrand: "Sigenergy",
    estimatedInverterUpgradeCostPln: 0,
    estimatedInstallationCostPln: 2_500,
    standbyPowerW: 30,
  },
  "sigenstor-bat-8": {
    roundTripEfficiency: 0.95,
    dodPercent: 100,
    cycleLife: 10_000,
    degradationPerYear: 0.015,
    warrantyYears: 10,
    pricePerUnitPln: 11_500,
    isModular: true,
    maxModules: 6,
    requiredInverterBrand: "Sigenergy",
    estimatedInverterUpgradeCostPln: 0,
    estimatedInstallationCostPln: 3_000,
    standbyPowerW: 30,
  },
  "sigenstor-bat-10": {
    roundTripEfficiency: 0.955,
    dodPercent: 100,
    cycleLife: 10_000,
    degradationPerYear: 0.015,
    warrantyYears: 10,
    pricePerUnitPln: 11_500,
    isModular: true,
    maxModules: 6,
    requiredInverterBrand: "Sigenergy",
    estimatedInverterUpgradeCostPln: 0,
    estimatedInstallationCostPln: 3_000,
    standbyPowerW: 30,
  },
};

function toProduct(storage: StorageRecord): BessProduct {
  const commercial = COMMERCIAL[storage.id];
  if (commercial === undefined) {
    throw new Error(`Baza urządzeń: brak danych handlowych dla ${storage.id}`);
  }
  const unitPowerKw = Math.min(
    storage.modulePowerKw.value * storage.batteryModuleCount.value,
    storage.towerPowerLimitKw.value,
  );
  return {
    id: storage.id,
    manufacturer: storage.manufacturer.value,
    model: storage.model.value,
    usableCapacityKwh: storage.usableCapacityKwh.value,
    maxChargePowerKw: unitPowerKw,
    maxDischargePowerKw: unitPowerKw,
    modulePowerKw: storage.modulePowerKw.value,
    towerPowerLimitKw: storage.towerPowerLimitKw.value,
    batteryModulesPerUnit: storage.batteryModuleCount.value,
    maxBatteryModulesPerTower: storage.maxBatteryModulesPerTower.value,
    ...commercial,
  };
}

function catalog(): readonly BessProduct[] {
  return loadDeviceDatabase().storages.map(toProduct);
}

export function getProductsByManufacturer(manufacturer: string): BessProduct[] {
  return catalog().filter(
    (product) => product.manufacturer.toLowerCase() === manufacturer.toLowerCase(),
  );
}

export function getProductsBySeries(seriesKeyword: string): BessProduct[] {
  return catalog().filter(
    (product) => product.model.toLowerCase().includes(seriesKeyword.toLowerCase()),
  );
}

export function getAllProducts(): readonly BessProduct[] {
  return catalog();
}

export function getProductByModel(model: string): BessProduct | undefined {
  return catalog().find(
    (product) => product.model.toLowerCase() === model.toLowerCase(),
  );
}
