import { kwToKwhPerStep } from "../utils/energy-math.js";

const SEASON_START_MONTH = 2;
const SEASON_END_MONTH = 8;

export interface StorageSuggestion {
  /** Średnie zużycie od 16:00 do 08:00 w sezonie PV [kWh]. */
  readonly suggestedCapacityKwh: number;
  /** 95. percentyl poboru między 17:00 a 22:00 [kW]. */
  readonly suggestedPowerKw: number;
}

export interface ReplacementPlan {
  /** Rok (1-indeksowany), na którego początku wpisany jest koszt wymiany. */
  readonly replacementYear: number | null;
  readonly replacementReason: string;
}

function pl(value: number, digits: number): string {
  return value.toLocaleString("pl-PL", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Wymiana w roku po upływie krótszego z dwóch limitów:
 * gwarancji albo żywotności cyklowej (cykle / cykle roczne).
 * Koszt wpada na początku następnego roku, tak jak dotychczas po gwarancji.
 */
export function replacementPlan(
  warrantyYears: number,
  cycleLife: number,
  annualCycles: number,
  horizonYears: number,
): ReplacementPlan {
  const cycleYears = annualCycles > 1e-9 ? cycleLife / annualCycles : Number.POSITIVE_INFINITY;
  const lifeYears = Math.min(warrantyYears, cycleYears);
  const replacementYear = lifeYears < horizonYears ? Math.floor(lifeYears) + 1 : null;
  const cyclesFirst = cycleYears + 1e-9 < warrantyYears;
  const same = Math.abs(cycleYears - warrantyYears) <= 1e-6;

  if (replacementYear === null) {
    const cycleText = Number.isFinite(cycleYears) ? `${pl(cycleYears, 1)} lat` : "brak zużycia cykli";
    return {
      replacementYear: null,
      replacementReason: `Magazyn nie jest wymieniany w horyzoncie ${horizonYears} lat. Żywotność to min(gwarancja ${pl(warrantyYears, 0)} lat, cykle / cykle roczne = ${cycleText}).`,
    };
  }
  if (same) {
    return {
      replacementYear,
      replacementReason: `Wymiana na początku roku ${replacementYear}: gwarancja i żywotność cyklowa kończą się po ${pl(warrantyYears, 1)} latach.`,
    };
  }
  if (cyclesFirst) {
    return {
      replacementYear,
      replacementReason: `Wymiana na początku roku ${replacementYear}, bo cykle (${pl(cycleLife, 0)} / ${pl(annualCycles, 1)} rocznie = ${pl(cycleYears, 1)} lat) kończą się przed gwarancją (${pl(warrantyYears, 0)} lat).`,
    };
  }
  const cycleText = Number.isFinite(cycleYears) ? `${pl(cycleYears, 1)} lat` : "dłużej niż gwarancja";
  return {
    replacementYear,
    replacementReason: `Wymiana na początku roku ${replacementYear}, bo kończy się gwarancja (${pl(warrantyYears, 0)} lat), zanim wyczerpią się cykle (${cycleText}).`,
  };
}

function nightKey(timestamp: Date): string | undefined {
  const hour = timestamp.getUTCHours();
  let year = timestamp.getUTCFullYear();
  let month = timestamp.getUTCMonth();
  let day = timestamp.getUTCDate();
  if (hour < 8) {
    const previous = new Date(Date.UTC(year, month, day - 1));
    year = previous.getUTCFullYear();
    month = previous.getUTCMonth();
    day = previous.getUTCDate();
  } else if (hour < 16) {
    return undefined;
  }
  if (month < SEASON_START_MONTH || month > SEASON_END_MONTH) return undefined;
  return `${year}-${month}-${day}`;
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * 0.95;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (index - lower);
}

/**
 * Sugerowany magazyn z profilu poboru.
 * Pojemność to średnie zużycie 16:00–08:00 w sezonie marzec–wrzesień.
 * Moc to 95. percentyl poboru 17:00–22:00.
 */
export function suggestStorageSize(load: readonly { readonly timestamp: Date; readonly loadKw: number }[]): StorageSuggestion {
  const nightKwh = new Map<string, number>();
  const eveningKw: number[] = [];
  for (const record of load) {
    const key = nightKey(record.timestamp);
    if (key !== undefined) {
      nightKwh.set(key, (nightKwh.get(key) ?? 0) + kwToKwhPerStep(record.loadKw));
    }
    const hour = record.timestamp.getUTCHours();
    if (hour >= 17 && hour < 22) eveningKw.push(record.loadKw);
  }
  let capacity = 0;
  if (nightKwh.size > 0) {
    let sum = 0;
    for (const value of nightKwh.values()) sum += value;
    capacity = sum / nightKwh.size;
  }
  return {
    suggestedCapacityKwh: capacity,
    suggestedPowerKw: percentile95(eveningKw),
  };
}
