import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Liczba albo tekst z karty katalogowej. Brak `value` albo `source` jest błędem. */
export interface Sourced<T> {
  readonly value: T;
  readonly source: string;
}

export interface StorageRecord {
  readonly id: string;
  readonly manufacturer: Sourced<string>;
  readonly model: Sourced<string>;
  /** Moc ciągła jednego modułu bateryjnego [kW]. */
  readonly modulePowerKw: Sourced<number>;
  /** Limit mocy jednej wieży / sterownika [kW]. Huawei: C0 = 5, C1 = 10,5 wg karty. */
  readonly towerPowerLimitKw: Sourced<number>;
  readonly nominalCapacityKwh: Sourced<number>;
  readonly usableCapacityKwh: Sourced<number>;
  readonly coupling: Sourced<string>;
  /** Ile modułów bateryjnych jest w tym rekordzie (1 = sam moduł, 3 = wieża 15 kWh). */
  readonly batteryModuleCount: Sourced<number>;
  /** Ile modułów bateryjnych mieści jedna wieża, zanim potrzebny jest kolejny sterownik. */
  readonly maxBatteryModulesPerTower: Sourced<number>;
  readonly builtInInverter: boolean;
  readonly compatibleInverterIds: readonly string[];
}

export interface InverterRecord {
  readonly id: string;
  readonly manufacturer: Sourced<string>;
  readonly model: Sourced<string>;
  readonly acKw: Sourced<number>;
  readonly phases: Sourced<number>;
  readonly batteryCapable: Sourced<boolean>;
  readonly coupling: Sourced<string>;
  readonly gridChargeCapable: Sourced<boolean>;
  readonly backupEps: Sourced<boolean>;
  readonly maxDcKw: Sourced<number>;
  readonly mpptCount: Sourced<number>;
}

export interface PvModuleRecord {
  readonly id: string;
  readonly manufacturer: Sourced<string>;
  readonly model: Sourced<string>;
  readonly pStcW: Sourced<number>;
  readonly gammaPerK: Sourced<number>;
  readonly noctC: Sourced<number>;
  readonly widthMm: Sourced<number>;
  readonly heightMm: Sourced<number>;
  readonly depthMm: Sourced<number>;
}

export interface DeviceDatabase {
  readonly storages: readonly StorageRecord[];
  readonly inverters: readonly InverterRecord[];
  readonly pvModules: readonly PvModuleRecord[];
}

export class DeviceDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceDatabaseError";
  }
}

const STORAGE_SOURCED = [
  "manufacturer",
  "model",
  "modulePowerKw",
  "towerPowerLimitKw",
  "nominalCapacityKwh",
  "usableCapacityKwh",
  "coupling",
  "batteryModuleCount",
  "maxBatteryModulesPerTower",
] as const;

const INVERTER_SOURCED_NUMBER = ["acKw", "phases", "maxDcKw", "mpptCount"] as const;
const INVERTER_SOURCED_BOOLEAN = ["batteryCapable", "gridChargeCapable", "backupEps"] as const;

const MODULE_SOURCED = ["manufacturer", "model", "pStcW", "gammaPerK", "noctC", "widthMm", "heightMm", "depthMm"] as const;

function fail(where: string): never {
  throw new DeviceDatabaseError(`Baza urządzeń: ${where}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireArray(value: unknown, file: string): unknown[] {
  if (!Array.isArray(value)) fail(`${file}: oczekiwano tablicy`);
  return value;
}

function sourced(raw: unknown, where: string): { value: unknown; source: string } {
  if (!isRecord(raw)) fail(`${where}: brak pola (oczekiwano { value, source })`);
  if (!("value" in raw)) fail(`${where}.value: brak pola`);
  if (!("source" in raw)) fail(`${where}.source: brak pola`);
  if (typeof raw["source"] !== "string" || !/^https?:\/\//.test(raw["source"])) {
    fail(`${where}.source: każda wartość musi mieć link do karty katalogowej`);
  }
  return { value: raw["value"], source: raw["source"] };
}

function sourcedString(raw: unknown, where: string): Sourced<string> {
  const item = sourced(raw, where);
  if (typeof item.value !== "string" || item.value.trim() === "") fail(`${where}.value: brak tekstu`);
  return { value: item.value, source: item.source };
}

function sourcedNumber(raw: unknown, where: string): Sourced<number> {
  const item = sourced(raw, where);
  if (typeof item.value !== "number" || !Number.isFinite(item.value)) fail(`${where}.value: brak liczby`);
  return { value: item.value, source: item.source };
}

function sourcedBoolean(raw: unknown, where: string): Sourced<boolean> {
  const item = sourced(raw, where);
  if (typeof item.value !== "boolean") fail(`${where}.value: brak pola logicznego`);
  return { value: item.value, source: item.source };
}

function requireString(raw: Record<string, unknown>, key: string, where: string): string {
  if (!(key in raw)) fail(`${where}.${key}: brak pola`);
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") fail(`${where}.${key}: brak tekstu`);
  return value;
}

function requireBoolean(raw: Record<string, unknown>, key: string, where: string): boolean {
  if (!(key in raw)) fail(`${where}.${key}: brak pola`);
  if (typeof raw[key] !== "boolean") fail(`${where}.${key}: brak pola logicznego`);
  return raw[key] as boolean;
}

function parseStorage(raw: unknown, index: number): StorageRecord {
  const where = `storages.json[${index}]`;
  if (!isRecord(raw)) fail(`${where}: brak rekordu`);
  const id = requireString(raw, "id", where);
  const label = `storages.json → ${id}`;
  const fields = {} as Record<(typeof STORAGE_SOURCED)[number], Sourced<string> | Sourced<number>>;
  for (const key of STORAGE_SOURCED) {
    if (!(key in raw)) fail(`${label}.${key}: brak pola`);
    fields[key] = key === "manufacturer" || key === "model" || key === "coupling"
      ? sourcedString(raw[key], `${label}.${key}`)
      : sourcedNumber(raw[key], `${label}.${key}`);
  }
  if (!("builtInInverter" in raw)) fail(`${label}.builtInInverter: brak pola`);
  const builtInInverter = requireBoolean(raw, "builtInInverter", label);
  if (!("compatibleInverterIds" in raw)) fail(`${label}.compatibleInverterIds: brak pola`);
  if (!Array.isArray(raw["compatibleInverterIds"]) || raw["compatibleInverterIds"].some((id) => typeof id !== "string" || id.trim() === "")) {
    fail(`${label}.compatibleInverterIds: brak listy identyfikatorów falowników`);
  }
  const coupling = fields.coupling as Sourced<string>;
  if (coupling.value !== "DC" && coupling.value !== "AC") fail(`${label}.coupling: dozwolone DC albo AC`);
  return {
    id,
    manufacturer: fields.manufacturer as Sourced<string>,
    model: fields.model as Sourced<string>,
    modulePowerKw: fields.modulePowerKw as Sourced<number>,
    towerPowerLimitKw: fields.towerPowerLimitKw as Sourced<number>,
    nominalCapacityKwh: fields.nominalCapacityKwh as Sourced<number>,
    usableCapacityKwh: fields.usableCapacityKwh as Sourced<number>,
    coupling,
    batteryModuleCount: fields.batteryModuleCount as Sourced<number>,
    maxBatteryModulesPerTower: fields.maxBatteryModulesPerTower as Sourced<number>,
    builtInInverter,
    compatibleInverterIds: raw["compatibleInverterIds"] as string[],
  };
}

function parseInverter(raw: unknown, index: number): InverterRecord {
  const where = `inverters.json[${index}]`;
  if (!isRecord(raw)) fail(`${where}: brak rekordu`);
  const id = requireString(raw, "id", where);
  const label = `inverters.json → ${id}`;
  if (!("manufacturer" in raw)) fail(`${label}.manufacturer: brak pola`);
  if (!("model" in raw)) fail(`${label}.model: brak pola`);
  if (!("coupling" in raw)) fail(`${label}.coupling: brak pola`);
  const numbers = {} as Record<(typeof INVERTER_SOURCED_NUMBER)[number], Sourced<number>>;
  for (const key of INVERTER_SOURCED_NUMBER) {
    if (!(key in raw)) fail(`${label}.${key}: brak pola`);
    numbers[key] = sourcedNumber(raw[key], `${label}.${key}`);
  }
  const flags = {} as Record<(typeof INVERTER_SOURCED_BOOLEAN)[number], Sourced<boolean>>;
  for (const key of INVERTER_SOURCED_BOOLEAN) {
    if (!(key in raw)) fail(`${label}.${key}: brak pola`);
    flags[key] = sourcedBoolean(raw[key], `${label}.${key}`);
  }
  const phases = numbers.phases.value;
  if (phases !== 1 && phases !== 3) fail(`${label}.phases: dozwolone 1 albo 3`);
  const coupling = sourcedString(raw["coupling"], `${label}.coupling`);
  if (coupling.value !== "DC" && coupling.value !== "AC" && coupling.value !== "none") {
    fail(`${label}.coupling: dozwolone DC, AC albo none`);
  }
  return {
    id,
    manufacturer: sourcedString(raw["manufacturer"], `${label}.manufacturer`),
    model: sourcedString(raw["model"], `${label}.model`),
    acKw: numbers.acKw,
    phases: numbers.phases,
    batteryCapable: flags.batteryCapable,
    coupling,
    gridChargeCapable: flags.gridChargeCapable,
    backupEps: flags.backupEps,
    maxDcKw: numbers.maxDcKw,
    mpptCount: numbers.mpptCount,
  };
}

function parseModule(raw: unknown, index: number): PvModuleRecord {
  const where = `pv-modules.json[${index}]`;
  if (!isRecord(raw)) fail(`${where}: brak rekordu`);
  const id = requireString(raw, "id", where);
  const label = `pv-modules.json → ${id}`;
  const fields = {} as Record<(typeof MODULE_SOURCED)[number], Sourced<string> | Sourced<number>>;
  for (const key of MODULE_SOURCED) {
    if (!(key in raw)) fail(`${label}.${key}: brak pola`);
    fields[key] = key === "manufacturer" || key === "model"
      ? sourcedString(raw[key], `${label}.${key}`)
      : sourcedNumber(raw[key], `${label}.${key}`);
  }
  return {
    id,
    manufacturer: fields.manufacturer as Sourced<string>,
    model: fields.model as Sourced<string>,
    pStcW: fields.pStcW as Sourced<number>,
    gammaPerK: fields.gammaPerK as Sourced<number>,
    noctC: fields.noctC as Sourced<number>,
    widthMm: fields.widthMm as Sourced<number>,
    heightMm: fields.heightMm as Sourced<number>,
    depthMm: fields.depthMm as Sourced<number>,
  };
}

function linkStorages(storages: readonly StorageRecord[], inverters: readonly InverterRecord[]): void {
  const byId = new Map(inverters.map((item) => [item.id, item]));
  for (const storage of storages) {
    if (storage.builtInInverter) continue;
    if (storage.compatibleInverterIds.length === 0) {
      fail(`storages.json → ${storage.id}: brak zgodnego falownika i brak falownika wbudowanego`);
    }
    for (const inverterId of storage.compatibleInverterIds) {
      const inverter = byId.get(inverterId);
      if (inverter === undefined) fail(`storages.json → ${storage.id}: nieznany falownik ${inverterId}`);
      if (!inverter.batteryCapable.value) {
        fail(`storages.json → ${storage.id}: falownik ${inverterId} nie obsługuje magazynu`);
      }
      if (inverter.coupling.value !== storage.coupling.value) {
        fail(`storages.json → ${storage.id}: coupling falownika ${inverterId} nie zgadza się z magazynem`);
      }
    }
  }
}

export function validateDeviceDatabase(input: {
  readonly storages: unknown;
  readonly inverters: unknown;
  readonly pvModules: unknown;
}): DeviceDatabase {
  const storages = requireArray(input.storages, "storages.json").map(parseStorage);
  const inverters = requireArray(input.inverters, "inverters.json").map(parseInverter);
  const pvModules = requireArray(input.pvModules, "pv-modules.json").map(parseModule);

  if (storages.length < 10) fail(`storages.json: jest ${storages.length}, wymagane minimum 10`);
  if (inverters.length < 12) fail(`inverters.json: jest ${inverters.length}, wymagane minimum 12`);
  if (pvModules.length < 3) fail(`pv-modules.json: jest ${pvModules.length}, wymagane minimum 3`);
  if (!inverters.some((item) => item.batteryCapable.value)) fail("inverters.json: brak hybrydy");
  if (!inverters.some((item) => !item.batteryCapable.value)) fail("inverters.json: brak falownika on-grid");

  const storageIds = new Set<string>();
  for (const storage of storages) {
    if (storageIds.has(storage.id)) fail(`storages.json: powtórzony id ${storage.id}`);
    storageIds.add(storage.id);
  }
  const inverterIds = new Set<string>();
  for (const inverter of inverters) {
    if (inverterIds.has(inverter.id)) fail(`inverters.json: powtórzony id ${inverter.id}`);
    inverterIds.add(inverter.id);
  }
  linkStorages(storages, inverters);
  return { storages, inverters, pvModules };
}

function catalogFile(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../public", name);
}

function readJson(name: string): unknown {
  const file = catalogFile(name);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    fail(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let cached: DeviceDatabase | undefined;

/** Wczytuje trzy pliki JSON i przerywa start, gdy brakuje pola albo linku do karty. */
export function loadDeviceDatabase(): DeviceDatabase {
  if (cached !== undefined) return cached;
  cached = validateDeviceDatabase({
    storages: readJson("storages.json"),
    inverters: readJson("inverters.json"),
    pvModules: readJson("pv-modules.json"),
  });
  return cached;
}
