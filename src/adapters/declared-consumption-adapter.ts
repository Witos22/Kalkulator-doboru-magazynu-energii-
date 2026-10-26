import type { TimeSeriesRecord } from "../types/timeseries.js";
import { estimateLoadShapeWeight, isWeekendDay } from "../utils/load-shape.js";
import { kwhPerStepToKw } from "../utils/energy-math.js";

/** Odbiorniki, które zmieniają kształt dobowy i sezonowy zużycia (spec. audytu 30.09.2026, sekcja "Zużycie"). */
export type Appliance = "heat-pump" | "ev" | "ac" | "boiler" | "remote-work";

export const APPLIANCES: readonly Appliance[] = ["heat-pump", "ev", "ac", "boiler", "remote-work"];

/**
 * Udział rocznego zużycia przypisany odbiornikowi, gdy klient go zadeklaruje.
 * Wartości ORIENTACYJNE (typowe dla domu jednorodzinnego) — nie pomiar, [DO WERYFIKACJI].
 * `remote-work` nie dodaje energii, tylko podnosi zużycie w dni robocze w ciągu dnia.
 */
const APPLIANCE_ANNUAL_SHARE: Readonly<Record<Exclude<Appliance, "remote-work">, number>> = {
  "heat-pump": 0.35,
  ev: 0.15,
  ac: 0.05,
  boiler: 0.10,
};

// Przybliżone stopniodni grzewcze per miesiąc dla Polski (max(0, 16 °C − średnia temp.)) — kształt sezonowości pompy ciepła.
const HEATING_DEGREE_BY_MONTH = [17, 16, 12, 7, 2, 0, 0, 0, 2, 7, 12, 15] as const;
// Sezonowość zużycia podstawowego: zimą wyższe (światło, grzanie wody), latem niższe.
const BASE_SEASON_BY_MONTH = [1.15, 1.1, 1.05, 1.0, 0.95, 0.9, 0.88, 0.9, 0.95, 1.0, 1.08, 1.15] as const;
// Klimatyzacja: tylko ciepłe miesiące.
const AC_SEASON_BY_MONTH = [0, 0, 0, 0, 0.3, 1, 1, 1, 0.3, 0, 0, 0] as const;

const YEAR = 2023; // zgodnie z rokiem profilu PV (365 dni, bez 29 lutego)

function hourWeight(appliance: Exclude<Appliance, "remote-work">, hour: number): number {
  switch (appliance) {
    case "heat-pump":
      return hour >= 5 && hour < 8 ? 1.3 : hour >= 17 && hour < 22 ? 1.3 : 1;
    case "ev":
      return hour >= 18 || hour < 6 ? 1 : 0.1; // ładowanie głównie wieczorem i w nocy
    case "ac":
      return hour >= 12 && hour < 20 ? 1 : 0.1;
    case "boiler":
      return (hour >= 5 && hour < 8) || (hour >= 18 && hour < 22) ? 1 : 0.15;
  }
}

function seasonWeight(appliance: Exclude<Appliance, "remote-work">, month: number): number {
  switch (appliance) {
    case "heat-pump": return HEATING_DEGREE_BY_MONTH[month]!;
    case "ac": return AC_SEASON_BY_MONTH[month]!;
    case "ev":
    case "boiler": return 1;
  }
}

/**
 * Generuje roczny profil zużycia 15-min z DEKLARACJI klienta (roczne zużycie z faktur
 * + lista odbiorników) — poziom 4 hierarchii źródeł danych z audytu. Kształt doby
 * i sezonowość są założone modelowo, nie zmierzone, więc wynik jest mniej
 * wiarygodny niż przy profilach z licznika; raport pokazuje to wprost.
 */
export class DeclaredConsumptionAdapter {
  generate(annualConsumptionKwh: number, appliances: readonly Appliance[]): TimeSeriesRecord[] {
    const selected = new Set(appliances);
    const energyAppliances = (Object.keys(APPLIANCE_ANNUAL_SHARE) as Array<keyof typeof APPLIANCE_ANNUAL_SHARE>)
      .filter((a) => selected.has(a));
    const remoteWork = selected.has("remote-work");

    const baseShare = 1 - energyAppliances.reduce((sum, a) => sum + APPLIANCE_ANNUAL_SHARE[a], 0);

    const timestamps: Date[] = [];
    const baseWeights: number[] = [];
    const applianceWeights = new Map<string, number[]>(energyAppliances.map((a) => [a, []]));

    for (let month = 0; month < 12; month++) {
      const daysInMonth = new Date(Date.UTC(YEAR, month + 1, 0)).getUTCDate();
      for (let day = 1; day <= daysInMonth; day++) {
        const weekend = isWeekendDay(new Date(Date.UTC(YEAR, month, day)));
        for (let hour = 0; hour < 24; hour++) {
          let shape = estimateLoadShapeWeight(hour, weekend);
          // Praca zdalna: w dni robocze dom nie stoi pusty w ciągu dnia.
          if (remoteWork && !weekend && hour >= 8 && hour < 16) shape = 1.2;
          for (let q = 0; q < 4; q++) {
            timestamps.push(new Date(Date.UTC(YEAR, month, day, hour, q * 15)));
            baseWeights.push(shape * BASE_SEASON_BY_MONTH[month]!);
            for (const a of energyAppliances) {
              applianceWeights.get(a)!.push(hourWeight(a, hour) * seasonWeight(a, month));
            }
          }
        }
      }
    }

    const kwhPerStep = new Float64Array(timestamps.length);
    const addComponent = (weights: readonly number[], annualKwh: number): void => {
      const sum = weights.reduce((s, w) => s + w, 0);
      if (sum <= 0) return;
      for (let i = 0; i < weights.length; i++) kwhPerStep[i]! += (weights[i]! / sum) * annualKwh;
    };

    addComponent(baseWeights, annualConsumptionKwh * baseShare);
    for (const a of energyAppliances) {
      addComponent(applianceWeights.get(a)!, annualConsumptionKwh * APPLIANCE_ANNUAL_SHARE[a]);
    }

    return timestamps.map((timestamp, i) => ({
      timestamp,
      loadKw: kwhPerStepToKw(kwhPerStep[i]!),
      pvProductionKw: 0,
    }));
  }
}
