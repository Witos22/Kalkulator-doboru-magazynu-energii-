import type { PvProfileRecord } from "../types/pv-profile.js";
import { kwToKwhPerStep } from "../utils/energy-math.js";

/** Dolna i górna granica miesięcznego współczynnika kalibracji. */
export const CALIBRATION_K_MIN = 0.6;
export const CALIBRATION_K_MAX = 1.2;

/** Czerwiec, lipiec, sierpień — k poniżej 0,8 w tych miesiącach jest ostrzeżeniem. */
const SUMMER_MONTHS = new Set([5, 6, 7]);

const MONTH_NAMES = [
  "styczniu", "lutym", "marcu", "kwietniu", "maju", "czerwcu",
  "lipcu", "sierpniu", "wrześniu", "październiku", "listopadzie", "grudniu",
];

export interface ExportDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly exportKwh: number;
}

export interface MonthCalibration {
  readonly year: number;
  readonly month: number;
  readonly k: number;
}

export interface PvCalibration {
  readonly profile: PvProfileRecord[];
  readonly months: readonly MonthCalibration[];
  readonly warnings: readonly string[];
}

function clampK(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(CALIBRATION_K_MAX, Math.max(CALIBRATION_K_MIN, value));
}

function dayKey(month: number, day: number): string {
  return `${month}-${day}`;
}

/**
 * Miesięczna kalibracja profilu PV do zmierzonego A−.
 *
 * Model słońca losuje dni pochmurne i słoneczne, więc jasny profil często
 * wpada na kalendarzowy dzień, w którym realnie prawie nie było eksportu.
 * W każdym miesiącu profile dobowe są układane od nowa: największa
 * produkcja modelu trafia na dni z największym A−. Potem jeden współczynnik
 * k skaluje cały miesiąc tak, by w 20% najsłoneczniejszych dni (najwyższe A−)
 * energia modelu zrównała się z realnym oddaniem. k zostaje w [0,6; 1,2].
 */
export function calibratePvToExport(
  profile: readonly PvProfileRecord[],
  days: readonly ExportDay[],
): PvCalibration {
  const stepsByDay = new Map<string, PvProfileRecord[]>();
  for (const record of profile) {
    const key = dayKey(record.timestamp.getUTCMonth(), record.timestamp.getUTCDate());
    const list = stepsByDay.get(key) ?? [];
    list.push(record);
    stepsByDay.set(key, list);
  }

  const powerBySlot = new Map<string, number>();
  for (const record of profile) {
    const slot = `${dayKey(record.timestamp.getUTCMonth(), record.timestamp.getUTCDate())}-${record.timestamp.getUTCHours()}-${record.timestamp.getUTCMinutes()}`;
    powerBySlot.set(slot, record.pvProductionKw);
  }

  const byMonth = new Map<string, ExportDay[]>();
  for (const day of days) {
    const key = `${day.year}-${day.month}`;
    const list = byMonth.get(key) ?? [];
    list.push(day);
    byMonth.set(key, list);
  }

  const months: MonthCalibration[] = [];
  const warnings: string[] = [];

  for (const [monthKey, monthDays] of byMonth) {
    const [yearText, monthText] = monthKey.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const unique = new Map<string, ExportDay>();
    for (const day of monthDays) unique.set(dayKey(day.month, day.day), day);
    const list = [...unique.values()];
    if (list.length === 0) continue;

    const pvOf = (day: ExportDay): number => {
      const steps = stepsByDay.get(dayKey(day.month, day.day)) ?? [];
      let energy = 0;
      for (const step of steps) energy += kwToKwhPerStep(step.pvProductionKw);
      return energy;
    };

    const byExport = [...list].sort((a, b) => b.exportKwh - a.exportKwh || a.day - b.day);
    const byPv = [...list].sort((a, b) => pvOf(b) - pvOf(a) || a.day - b.day);
    const sunnyCount = Math.max(1, Math.ceil(list.length * 0.2));
    let exportSum = 0;
    let pvSum = 0;
    for (let i = 0; i < sunnyCount; i++) {
      exportSum += byExport[i]?.exportKwh ?? 0;
      pvSum += pvOf(byPv[i]!);
    }
    const k = pvSum > 1e-6 ? clampK(exportSum / pvSum) : 1;

    for (let i = 0; i < byExport.length; i++) {
      const target = byExport[i]!;
      const source = byPv[i]!;
      const sourceSteps = stepsByDay.get(dayKey(source.month, source.day)) ?? [];
      for (const step of sourceSteps) {
        const slot = `${dayKey(target.month, target.day)}-${step.timestamp.getUTCHours()}-${step.timestamp.getUTCMinutes()}`;
        powerBySlot.set(slot, step.pvProductionKw * k);
      }
    }

    months.push({ year, month, k });
    if (SUMMER_MONTHS.has(month) && k < 0.8) {
      const name = MONTH_NAMES[month] ?? String(month + 1);
      warnings.push(
        `Kalibracja PV: w ${name} współczynnik k = ${k.toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} jest poniżej 0,8. ` +
        "Latem model oddaje wyraźnie więcej energii, niż wynika z realnego A− — sprawdź moc instalacji, kąt i zacienienie.",
      );
    }
  }

  const calibrated = profile.map((record) => {
    const slot = `${dayKey(record.timestamp.getUTCMonth(), record.timestamp.getUTCDate())}-${record.timestamp.getUTCHours()}-${record.timestamp.getUTCMinutes()}`;
    const power = powerBySlot.get(slot);
    return power === undefined || power === record.pvProductionKw
      ? record
      : { timestamp: record.timestamp, pvProductionKw: power };
  });

  return { profile: calibrated, months, warnings };
}
