const DEFAULT_CONNECTION_KW = { 1: 5.75, 3: 14 } as const;

/** Kandydaci nowej instalacji, zanim przyłącze je obetnie. */
export const NEW_PV_SIZES_KWP = [3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 40, 50] as const;

/** Dokładane kWp ponad istniejącą instalację. */
export const PV_EXPANSION_EXTRAS_KWP = [0, 1, 2, 3, 4, 6, 8, 10, 12, 15, 20] as const;

/** Szersze moce sprawdzane, gdy magazyn się nie zwraca. */
export const PV_EXPANSION_SEARCH_KWP = [20, 25, 30, 40, 50, 75, 100] as const;

export function connectionPowerKw(phases: 1 | 3 | undefined, declaredKw: number | undefined): number | undefined {
  if (declaredKw !== undefined && Number.isFinite(declaredKw) && declaredKw >= 0) return declaredKw;
  if (phases === 1 || phases === 3) return DEFAULT_CONNECTION_KW[phases];
  return undefined;
}

/** Najwyższe nowe PV [kWp], które mieści się w zadeklarowanej mocy przyłącza. */
export function maxInstallablePvKwp(phases: 1 | 3 | undefined, declaredConnectionKw: number | undefined): number | undefined {
  return connectionPowerKw(phases, declaredConnectionKw);
}

function plKw(value: number): string {
  return value.toLocaleString("pl-PL", { maximumFractionDigits: 2 });
}

/**
 * Audyt, sekcja przyłącza i I10: przekroczenie mocy przyłącza nie zatrzymuje analizy.
 * Raport dostaje flagę o konieczności zmiany warunków przyłączenia.
 */
export function connectionUpgradeWarning(
  pvKwp: number,
  declaredConnectionKw: number | undefined,
): string | undefined {
  if (!(pvKwp > 0)) return undefined;
  const connection = connectionPowerKw(undefined, declaredConnectionKw);
  if (connection === undefined || pvKwp <= connection + 1e-9) return undefined;
  return `Wymaga zmiany warunków przyłączenia: moc PV ${plKw(pvKwp)} kWp przekracza moc przyłączeniową ${plKw(connection)} kW.`;
}

/** Zostawia moce nie większe niż limit. Sam limit dopisuje, jeśli leży pomiędzy kandydatami. */
export function pvSizesWithinLimit(
  candidates: readonly number[],
  maxKwp: number | undefined,
  includeCap = true,
): number[] {
  if (maxKwp === undefined || !Number.isFinite(maxKwp)) return [...candidates];
  const kept = candidates.filter((size) => size <= maxKwp + 1e-9);
  if (includeCap && maxKwp > 0 && !kept.some((size) => Math.abs(size - maxKwp) < 1e-6)) {
    kept.push(maxKwp);
  }
  kept.sort((a, b) => a - b);
  return kept;
}

/** Zostawia moce w limicie. Gdy zadeklarowane PV już go przekracza, zostaje ta deklaracja i flaga z audytu. */
export function pvSizesKeepingDeclared(
  existingKwp: number,
  candidates: readonly number[],
  maxKwp: number | undefined,
): number[] {
  const within = pvSizesWithinLimit(candidates, maxKwp, false);
  return within.length > 0 ? within : [existingKwp];
}
