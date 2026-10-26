import type { BessConfig, BessProduct } from "../types/bess.js";
import type { InverterRecord } from "./device-database.js";

/** Dodatkowa przemiana AC obcina sprawność cyklu do 95% sprawności karty. */
export const AC_COUPLING_RTE_FACTOR = 0.95;

export interface RoofInverter {
  readonly brand: string;
  readonly model?: string | undefined;
}

/** Jedna droga podłączenia magazynu. Skaner liczy NPV każdej i zostawia wyższą. */
export interface InverterPath {
  readonly coupling: "DC" | "AC";
  readonly rteFactor: number;
  readonly inverterCostNetPln: number;
  readonly allowGridCharge: boolean;
  readonly label: string;
  /** Moc baterii falownika, który obsługuje magazyn w tym wariancie [kW]. */
  readonly inverterBatteryKw?: number;
}

export interface InverterSite {
  readonly hasExistingPv: boolean;
  readonly planes: readonly RoofInverter[];
  /** Liczba faz przyłącza, gdy żaden istniejący falownik nie jest w katalogu. */
  readonly phases?: 1 | 3 | undefined;
  readonly pvKwp: number;
  readonly compatibleInverterIds: readonly string[];
  readonly builtInInverter: boolean;
  readonly replacementCostNetPln: number;
  readonly inverters: readonly InverterRecord[];
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isUnknown(value: string | undefined): boolean {
  return value !== undefined && norm(value) === "nie wiem";
}

function compatibleHybrids(site: InverterSite): InverterRecord[] {
  const ids = new Set(site.compatibleInverterIds);
  return site.inverters.filter((item) =>
    ids.has(item.id) && item.batteryCapable.value && item.coupling.value === "DC",
  );
}

function findCatalogInverter(site: InverterSite, plane: RoofInverter): InverterRecord | undefined {
  if (plane.model === undefined || plane.model.trim() === "") return undefined;
  const brand = norm(plane.brand);
  const model = norm(plane.model);
  return site.inverters.find((item) => norm(item.manufacturer.value) === brand && norm(item.model.value) === model)
    ?? site.inverters.find((item) => norm(item.model.value) === model);
}

function phaseRequirement(site: InverterSite): 1 | 3 | undefined {
  const known: number[] = [];
  for (const plane of site.planes) {
    if (isUnknown(plane.brand) || isUnknown(plane.model)) continue;
    const inverter = findCatalogInverter(site, plane);
    if (inverter !== undefined) known.push(inverter.phases.value);
  }
  if (site.phases === 1) return 1;
  if (known.some((phases) => phases === 3)) return 3;
  if (known.length > 0 && known.every((phases) => phases === 1)) return 1;
  return site.phases;
}

function pickHybrid(site: InverterSite, planeCount: number): InverterRecord | undefined {
  const phases = phaseRequirement(site);
  return compatibleHybrids(site)
    .filter((item) =>
      item.maxDcKw.value + 1e-9 >= site.pvKwp
      && item.mpptCount.value >= planeCount
      && (phases === undefined || item.phases.value === phases),
    )
    .sort((a, b) => a.maxDcKw.value - b.maxDcKw.value || a.acKw.value - b.acKw.value || a.id.localeCompare(b.id))[0];
}

function existingHybrid(site: InverterSite): { readonly name: string; readonly allowGridCharge: boolean; readonly batteryKw?: number } | undefined {
  const hybrids = compatibleHybrids(site);
  for (const plane of site.planes) {
    if (isUnknown(plane.brand) || isUnknown(plane.model)) continue;
    const listed = findCatalogInverter(site, plane);
    if (listed !== undefined) {
      if (site.phases === 1 && listed.phases.value !== 1) continue;
      if (!hybrids.some((item) => item.id === listed.id)) continue;
      return {
        name: `${listed.manufacturer.value} ${listed.model.value}`,
        allowGridCharge: listed.gridChargeCapable.value,
        batteryKw: listed.acKw.value,
      };
    }
    const brand = norm(plane.brand);
    const ofBrand = hybrids.filter((item) =>
      norm(item.manufacturer.value) === brand && (site.phases !== 1 || item.phases.value === 1),
    );
    if (plane.model === undefined && ofBrand.length > 0) {
      return {
        name: ofBrand[0]!.manufacturer.value,
        allowGridCharge: ofBrand.every((item) => item.gridChargeCapable.value),
      };
    }
  }
  return undefined;
}

/**
 * Ścieżki podłączenia magazynu.
 * Brak PV: hybryda wchodzi w koszt PV. Zgodna hybryda: DC i 0 zł.
 * On-grid albo „nie wiem”: AC (zostaje stary falownik, sprawność × 0,95)
 * oraz wymiana, jeśli jakaś hybryda mieści moc i liczbę połaci.
 */
export function inverterPaths(site: InverterSite): readonly InverterPath[] {
  if (site.builtInInverter) {
    return [{
      coupling: "DC",
      rteFactor: 1,
      inverterCostNetPln: 0,
      allowGridCharge: compatibleHybrids(site).some((item) => item.gridChargeCapable.value),
      label: "Magazyn ma falownik wbudowany — sprzężenie DC, koszt falownika 0 zł.",
    }];
  }

  const planeCount = site.hasExistingPv ? Math.max(1, site.planes.length) : 1;

  if (!site.hasExistingPv) {
    const hybrid = pickHybrid(site, planeCount);
    return [{
      coupling: "DC",
      rteFactor: 1,
      inverterCostNetPln: 0,
      allowGridCharge: hybrid?.gridChargeCapable.value ?? false,
      label: "Hybryda jest w koszcie nowej instalacji PV — bez dopłaty za falownik.",
      ...(hybrid !== undefined ? { inverterBatteryKw: hybrid.acKw.value } : {}),
    }];
  }

  const owned = existingHybrid(site);
  if (owned !== undefined) {
    return [{
      coupling: "DC",
      rteFactor: 1,
      inverterCostNetPln: 0,
      allowGridCharge: owned.allowGridCharge,
      label: `Hybryda zgodna (${owned.name}) — sprzężenie DC, koszt falownika 0 zł.`,
      ...(owned.batteryKw !== undefined ? { inverterBatteryKw: owned.batteryKw } : {}),
    }];
  }

  const paths: InverterPath[] = [{
    coupling: "AC",
    rteFactor: AC_COUPLING_RTE_FACTOR,
    inverterCostNetPln: 0,
    allowGridCharge: false,
    label: "Zostaje obecny falownik, sprzężenie AC, sprawność cyklu × 0,95.",
  }];
  const replacement = pickHybrid(site, planeCount);
  if (replacement !== undefined) {
    paths.push({
      coupling: "DC",
      rteFactor: 1,
      inverterCostNetPln: site.replacementCostNetPln,
      allowGridCharge: replacement.gridChargeCapable.value,
      label: `Wymiana na ${replacement.manufacturer.value} ${replacement.model.value} — sprzężenie DC.`,
      inverterBatteryKw: replacement.acKw.value,
    });
  }
  return paths;
}

export function bessConfigForPath(product: BessProduct, moduleCount: number, path: InverterPath): BessConfig {
  const scaled = path.rteFactor === 1
    ? product
    : { ...product, roundTripEfficiency: product.roundTripEfficiency * path.rteFactor };
  return {
    product: scaled,
    moduleCount,
    inverterCostNetPln: path.inverterCostNetPln,
    allowGridCharge: path.allowGridCharge,
    coupling: path.coupling,
    inverterDecisionLabel: path.label,
    ...(path.inverterBatteryKw !== undefined ? { inverterBatteryKw: path.inverterBatteryKw } : {}),
  };
}
