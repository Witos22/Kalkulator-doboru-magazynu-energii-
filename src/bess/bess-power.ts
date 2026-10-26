import type { BessProduct } from "../types/bess.js";

/**
 * Moc ciągła magazynu [kW].
 * Bierze mniejszą z trzech wartości: moduły × moc modułu, limit wieży
 * (kolejna wieża dodaje kolejny limit) i maksymalną moc baterii falownika.
 */
export function bessPowerKw(product: BessProduct, unitCount: number, inverterBatteryKw?: number): number {
  const modules = product.batteryModulesPerUnit * unitCount;
  const towers = Math.max(1, Math.ceil(modules / product.maxBatteryModulesPerTower));
  const stackKw = Math.min(product.modulePowerKw * modules, product.towerPowerLimitKw * towers);
  if (inverterBatteryKw === undefined || !Number.isFinite(inverterBatteryKw)) return stackKw;
  return Math.min(stackKw, Math.max(0, inverterBatteryKw));
}
