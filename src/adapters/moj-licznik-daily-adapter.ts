import XLSX from "xlsx";
import type { TimeSeriesRecord } from "../types/timeseries.js";
import type { PvProfileRecord } from "../types/pv-profile.js";
import type { TariffSchedule } from "../types/tariff.js";
import type { MonthlyZoneEnergyBreakdown, DailyZoneEnergyBreakdown } from "../types/energy-breakdown.js";
import { estimateLoadShapeWeight, isWeekendDay } from "../utils/load-shape.js";
import { kwToKwhPerStep, kwhPerStepToKw } from "../utils/energy-math.js";
import { getPvLookup } from "../utils/pv-calendar.js";
import { calibratePvToExport } from "./pv-export-calibration.js";

/**
 * Mapuje realną godzinę na "Strefa 1"/"Strefa 2" z pliku Mój Licznik —
 * NIE przez sztywny zakres godzin (6–22 to tylko G12, nie G12w!), tylko przez
 * porównanie z harmonogramem WYBRANEJ taryfy: "Strefa 1" to ta sama strefa,
 * co w południe w zwykły poniedziałek (zawsze strefa dzienna/szczytowa),
 * "Strefa 2" to wszystko inne. Dla G12w to poprawnie obejmuje CAŁY weekend,
 * nie tylko godziny nocne — inaczej letni eksport PV w weekendowe południe
 * trafiałby błędnie do "strefy dziennej".
 */
function classifyZone(timestamp: Date, tariff: TariffSchedule): 1 | 2 {
  const dayZoneReferenceName = tariff.resolve(new Date(Date.UTC(2024, 0, 1, 12, 0))).name; // poniedziałek, południe
  return tariff.resolve(timestamp).name === dayZoneReferenceName ? 1 : 2;
}

interface DailyZoneRaw {
  readonly year: number;
  readonly month: number; // 0-indexed
  readonly day: number;
  readonly zone1Kwh: number;
  readonly zone2Kwh: number;
}

interface DailyZoneCombined {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly zone1ImportKwh: number;
  readonly zone1ExportKwh: number;
  readonly zone2ImportKwh: number;
  readonly zone2ExportKwh: number;
}

/**
 * Diagnostyka jakości rekonstrukcji (K8 audytu 30.09.2026) — ile razy formuła
 * `max(0, pobór − oddanie + produkcjaPV)` musiała uciąć wynik do zera, bo
 * wyszedł ujemny. To się zdarza, gdy modelowana (typowa, ze wzorów) produkcja PV
 * nie pasuje do realnej pogody tego dnia — ucięcie chowa ten błąd modelu,
 * zamiast go sygnalizować. Duży odsetek/duża energia ucięta = rekonstrukcja
 * zużycia dla tej strefy/dnia jest zgadywana bardziej niż zwykle.
 */
export interface DataQualityInfo {
  /** Liczba par dzień×strefa łącznie (dni × 2 strefy) */
  readonly totalDayZoneCount: number;
  /** Ile z nich zostało uciętych do zera (wynik przed max(0,) był ujemny) */
  readonly clippedDayZoneCount: number;
  /** Suma wartości bezwzględnej ucięć [kWh] — jak dużo energii "zniknęło" */
  readonly clippedEnergyKwh: number;
}

/**
 * Adapter dla raportów DOBOWYCH "Pobór A+" i "Energia oddana A-" z portalu
 * Mój Licznik (widok Rok/Miesiąc, rozdzielczość dzienna, w rozbiciu na strefę
 * 1/2 taryfy) — po 12 plików (jeden na miesiąc) na każdą z dwóch wielkości.
 *
 * Rekonstrukcja zużycia — dla KAŻDEGO DNIA i KAŻDEJ STREFY z osobna:
 *   zużycie_strefa = max(0, pobór_strefa − oddanie_strefa + produkcjaPV_strefa)
 * (bilans energii bez magazynu: load = self-consumed + import = (PV - export) + import)
 * Produkcja PV brana z lokalnego modelu słońca. Wynik dzienny
 * per strefa jest rozkładany na kroki 15-min generycznym szablonem kształtu
 * doby, ograniczonym do godzin danej strefy — więc założenie dotyczy już tylko
 * KSZTAŁTU w obrębie 16h dnia / 8h nocy, a nie całej doby na podstawie miesiąca.
 */
export class MojLicznikDailyAdapter {
  async parse(
    aPlusFilePaths: readonly string[],
    aMinusFilePaths: readonly string[],
    pvModeled: readonly PvProfileRecord[],
    tariff: TariffSchedule,
    options?: { readonly calibrate?: boolean },
  ): Promise<{
    records: TimeSeriesRecord[];
    monthlyZoneBreakdown: MonthlyZoneEnergyBreakdown[];
    dailyZoneBreakdown: DailyZoneEnergyBreakdown[];
    dataQuality: DataQualityInfo;
    /** Ostrzeżenia, gdy letni współczynnik kalibracji spada poniżej 0,8. */
    calibrationWarnings: readonly string[];
  }> {
    const aPlusDaily = aPlusFilePaths.flatMap((p) => this.parseDailyZoneFile(p));
    const aMinusDaily = aMinusFilePaths.flatMap((p) => this.parseDailyZoneFile(p));

    const combined = this.combineImportExport(aPlusDaily, aMinusDaily);
    if (combined.length === 0) {
      return {
        records: [], monthlyZoneBreakdown: [], dailyZoneBreakdown: [],
        dataQuality: { totalDayZoneCount: 0, clippedDayZoneCount: 0, clippedEnergyKwh: 0 },
        calibrationWarnings: [],
      };
    }

    const calibrated = options?.calibrate === false
      ? { profile: pvModeled, warnings: [] as readonly string[] }
      : calibratePvToExport(pvModeled, combined.map((d) => ({
        year: d.year,
        month: d.month,
        day: d.day,
        exportKwh: d.zone1ExportKwh + d.zone2ExportKwh,
      })));
    const { records, dataQuality } = this.reconstructRecords(combined, calibrated.profile, tariff);
    const monthlyZoneBreakdown = this.aggregateMonthly(combined);
    const dailyZoneBreakdown = combined.map((d) => ({
      date: this.isoDate(d.year, d.month, d.day),
      zone1ImportKwh: d.zone1ImportKwh,
      zone1ExportKwh: d.zone1ExportKwh,
      zone2ImportKwh: d.zone2ImportKwh,
      zone2ExportKwh: d.zone2ExportKwh,
    }));

    return { records, monthlyZoneBreakdown, dailyZoneBreakdown, dataQuality, calibrationWarnings: calibrated.warnings };
  }

  private isoDate(year: number, month: number, day: number): string {
    return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  /** Parsuje jeden plik dobowy: kolumny `Data, Strefa 1 [kWh], Strefa 2 [kWh], Strefa 3 [kWh], Suma`. */
  private parseDailyZoneFile(filePath: string): DailyZoneRaw[] {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]!]!;
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });

    const results: DailyZoneRaw[] = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]!;
      const dateStr = String(row[0] ?? "").trim();
      const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!match) continue;

      results.push({
        year: parseInt(match[1]!, 10),
        month: parseInt(match[2]!, 10) - 1,
        day: parseInt(match[3]!, 10),
        zone1Kwh: this.toNumber(row[1]),
        zone2Kwh: this.toNumber(row[2]),
      });
    }
    return results;
  }

  private toNumber(value: unknown): number {
    if (value === null || value === undefined || value === "") return 0;
    const n = typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }

  /** Łączy dzienne A+ i A- po dacie (klucz rok-miesiąc-dzień) w jeden rekord na dzień. */
  private combineImportExport(
    aPlusDaily: readonly DailyZoneRaw[],
    aMinusDaily: readonly DailyZoneRaw[],
  ): DailyZoneCombined[] {
    const key = (d: { year: number; month: number; day: number }): string => `${d.year}-${d.month}-${d.day}`;

    const aMinusByKey = new Map<string, DailyZoneRaw>();
    for (const d of aMinusDaily) aMinusByKey.set(key(d), d);

    const combined: DailyZoneCombined[] = [];
    for (const imp of aPlusDaily) {
      const exp = aMinusByKey.get(key(imp));
      combined.push({
        year: imp.year,
        month: imp.month,
        day: imp.day,
        zone1ImportKwh: imp.zone1Kwh,
        zone2ImportKwh: imp.zone2Kwh,
        zone1ExportKwh: exp?.zone1Kwh ?? 0,
        zone2ExportKwh: exp?.zone2Kwh ?? 0,
      });
    }

    return combined.sort((a, b) =>
      a.year - b.year || a.month - b.month || a.day - b.day,
    );
  }

  private reconstructRecords(
    daily: readonly DailyZoneCombined[],
    pvModeled: readonly PvProfileRecord[],
    tariff: TariffSchedule,
  ): { records: TimeSeriesRecord[]; dataQuality: DataQualityInfo } {
    const records: TimeSeriesRecord[] = [];
    // PV dopasowane po DACIE kalendarzowej, nie po pozycji (I1 audytu): dane mogą zaczynać się w dowolnym miesiącu.
    const pvAt = getPvLookup(pvModeled);
    let clippedDayZoneCount = 0;
    let clippedEnergyKwh = 0;

    for (const d of daily) {
      const weekend = isWeekendDay(new Date(Date.UTC(d.year, d.month, d.day)));

      const steps: Array<{ timestamp: Date; pvKw: number; zone: 1 | 2; weight: number }> = [];
      let pvZone1Kwh = 0;
      let pvZone2Kwh = 0;
      let weightZone1Sum = 0;
      let weightZone2Sum = 0;

      for (let hour = 0; hour < 24; hour++) {
        const zone = classifyZone(new Date(Date.UTC(d.year, d.month, d.day, hour)), tariff);
        const weight = estimateLoadShapeWeight(hour, weekend);

        for (let q = 0; q < 4; q++) {
          const timestamp = new Date(Date.UTC(d.year, d.month, d.day, hour, q * 15));
          const pvKw = pvAt(timestamp);

          steps.push({ timestamp, pvKw, zone, weight });
          const pvKwh = kwToKwhPerStep(pvKw);
          if (zone === 1) {
            pvZone1Kwh += pvKwh;
            weightZone1Sum += weight;
          } else {
            pvZone2Kwh += pvKwh;
            weightZone2Sum += weight;
          }
        }
      }

      // load = zużycie własne + pobór = (PV − oddanie) + pobór, per strefie.
      // Ujemna strefa znaczy, że modelowana produkcja w jej godzinach nie pokryła oddania.
      const rawZone1Kwh = d.zone1ImportKwh - d.zone1ExportKwh + pvZone1Kwh;
      const rawZone2Kwh = d.zone2ImportKwh - d.zone2ExportKwh + pvZone2Kwh;
      const rawDayKwh = rawZone1Kwh + rawZone2Kwh;
      if (rawZone1Kwh < 0) {
        clippedDayZoneCount++;
        clippedEnergyKwh += -rawZone1Kwh;
      }
      if (rawZone2Kwh < 0) {
        clippedDayZoneCount++;
        clippedEnergyKwh += -rawZone2Kwh;
      }
      // Suma stref jest bilansem doby i nie zależy od tego, czy weekend
      // jest w G12, czy w G12w. Ujemna strefa przy dodatniej dobie to zły
      // rozdział godzin, nie brak energii — dobowa suma zostaje.
      let loadZone1Kwh: number;
      let loadZone2Kwh: number;
      if (weightZone1Sum === 0 || weightZone2Sum === 0) {
        const loadDayKwh = Math.max(0, rawDayKwh);
        loadZone1Kwh = weightZone1Sum === 0 ? 0 : loadDayKwh;
        loadZone2Kwh = weightZone2Sum === 0 ? 0 : loadDayKwh;
      } else if (rawZone1Kwh >= 0 && rawZone2Kwh >= 0) {
        loadZone1Kwh = rawZone1Kwh;
        loadZone2Kwh = rawZone2Kwh;
      } else {
        const loadDayKwh = Math.max(0, rawDayKwh);
        const weightSum = weightZone1Sum + weightZone2Sum;
        loadZone1Kwh = (loadDayKwh * weightZone1Sum) / weightSum;
        loadZone2Kwh = loadDayKwh - loadZone1Kwh;
      }

      for (const step of steps) {
        const zoneTotalKwh = step.zone === 1 ? loadZone1Kwh : loadZone2Kwh;
        const zoneWeightSum = step.zone === 1 ? weightZone1Sum : weightZone2Sum;
        const loadShareKwh = zoneWeightSum > 0 ? (zoneTotalKwh * step.weight) / zoneWeightSum : 0;

        records.push({
          timestamp: step.timestamp,
          loadKw: kwhPerStepToKw(loadShareKwh),
          pvProductionKw: step.pvKw,
        });
      }
    }

    return {
      records,
      dataQuality: {
        totalDayZoneCount: daily.length * 2,
        clippedDayZoneCount,
        clippedEnergyKwh,
      },
    };
  }

  private aggregateMonthly(daily: readonly DailyZoneCombined[]): MonthlyZoneEnergyBreakdown[] {
    const byMonth = new Map<string, MonthlyZoneEnergyBreakdown>();

    for (const d of daily) {
      const key = `${d.year}-${d.month}`;
      const existing = byMonth.get(key);
      const acc: MonthlyZoneEnergyBreakdown = existing ?? {
        year: d.year,
        month: d.month,
        zone1ImportKwh: 0,
        zone1ExportKwh: 0,
        zone2ImportKwh: 0,
        zone2ExportKwh: 0,
      };

      byMonth.set(key, {
        ...acc,
        zone1ImportKwh: acc.zone1ImportKwh + d.zone1ImportKwh,
        zone1ExportKwh: acc.zone1ExportKwh + d.zone1ExportKwh,
        zone2ImportKwh: acc.zone2ImportKwh + d.zone2ImportKwh,
        zone2ExportKwh: acc.zone2ExportKwh + d.zone2ExportKwh,
      });
    }

    return [...byMonth.values()].sort((a, b) => a.year - b.year || a.month - b.month);
  }
}
