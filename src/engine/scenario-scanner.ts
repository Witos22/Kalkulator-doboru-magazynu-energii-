import type { BessConfig, BessProduct } from "../types/bess.js";
import { bessPowerKw } from "../bess/bess-power.js";
import { loadDeviceDatabase } from "../catalog/device-database.js";
import { bessConfigForPath, inverterPaths } from "../catalog/inverter-decision.js";
import type { RoofInverter } from "../catalog/inverter-decision.js";
import type {
  ClientSegment,
  FinancialAnalysisConfig,
  FinancialResult,
  InverterAlternative,
  PvOnlyResult,
  SensitivityRow,
  RecommendationReport,
  InputSummary,
  TariffChangeEffect,
} from "../types/financial.js";
import type { MonthlyPvUsageBreakdown, DailyPvUsageBreakdown } from "../types/energy-breakdown.js";
import type { SimulationResult } from "../types/simulation.js";
import type { TimeSeriesRecord } from "../types/timeseries.js";
import type { TariffSchedule } from "../types/tariff.js";
import type { PvProfileRecord } from "../types/pv-profile.js";
import type { ISimulationStrategy } from "../strategies/strategy.interface.js";
import { SimulationEngine } from "./simulation-engine.js";
import { FinancialCalculator, DEFAULT_FINANCIAL_CONFIG } from "./financial-calculator.js";
import { suggestStorageSize } from "./storage-sizing.js";
import { kwToKwhPerStep } from "../utils/energy-math.js";
import { getPvLookup } from "../utils/pv-calendar.js";

/**
 * Konfiguracja scenariuszy do przeskanowania.
 */
export interface ScannerConfig {
  /** Moce PV do przetestowania [kWp]. Jeśli użytkownik ma PV, to [existingPvKwp]. */
  readonly pvSizesToTest: readonly number[];
  /** Produkty BESS z katalogu */
  readonly products: readonly BessProduct[];
  /** Harmonogram taryfowy */
  readonly tariff: TariffSchedule;
  /**
   * Taryfa OBECNA i jej nazwa — gdy różni się od docelowej (`tariff`), raport
   * dostaje osobny efekt zmiany taryfy (I7 audytu 30.09.2026).
   */
  readonly currentTariff?: { readonly schedule: TariffSchedule; readonly name: string; readonly targetName: string } | undefined;
  /** Obecna (już opłacona) moc PV [kWp] — 0, jeśli klient nie ma PV */
  readonly existingPvKwp?: number;
  /** Konfiguracja analizy finansowej */
  readonly financialConfig?: FinancialAnalysisConfig;
  /** Ilość top rekomendacji do zwrócenia */
  readonly topN?: number;
  /** Segment klienta — decyduje, czy ceny magazynu/PV są netto czy brutto (domyślnie: prosument) */
  readonly clientSegment?: ClientSegment;
  /**
   * Marka istniejącego falownika klienta (K3 audytu 30.09.2026) — jeśli podana
   * i zgodna z `BessProduct.requiredInverterBrand` danego magazynu, koszt
   * falownika w tym scenariuszu wynosi 0 (klient ma już kompatybilny sprzęt).
   * Jeśli pominięta, silnik BEZPIECZNIE zakłada, że falownik trzeba dokupić.
   */
  readonly existingInverterBrands?: readonly string[] | undefined;
  /** Falowniki na połaciach. Model jest potrzebny, żeby odróżnić hybrydę od on-grid. */
  readonly inverterPlanes?: readonly RoofInverter[] | undefined;
  /** Liczba faz przyłącza — dobór hybrydy, gdy model istniejącego falownika jest nieznany. */
  readonly connectionPhases?: 1 | 3 | undefined;
}

/**
 * Scenario Scanner — iteruje po kombinacjach PV × BESS × moduleCount,
 * uruchamia symulację dla każdej i zwraca ranking posortowany po payback.
 */
export class ScenarioScanner {
  private readonly engine: SimulationEngine;
  private readonly financialCalc: FinancialCalculator;
  private readonly financialConfig: FinancialAnalysisConfig;

  constructor(strategy: ISimulationStrategy, financialConfig?: FinancialAnalysisConfig) {
    this.engine = new SimulationEngine(strategy);
    this.financialConfig = financialConfig ?? DEFAULT_FINANCIAL_CONFIG;
    this.financialCalc = new FinancialCalculator(this.financialConfig);
  }

  /**
   * Skanuje wszystkie kombinacje PV × BESS i zwraca raport rekomendacyjny.
   *
   * @param loadProfile Profil zużycia z CSV (35 040 rekordów)
   * @param pvBaseProfile Profil PV z modelu słońca dla 1 kWp (35 040 rekordów) — null jeśli użytkownik ma dane SEMS z PV
   * @param config Konfiguracja skanera
   * @param inputSummary Podsumowanie danych wejściowych użytkownika
   * @returns Kompletny raport rekomendacyjny
   */
  scan(
    loadProfile: readonly TimeSeriesRecord[],
    pvBaseProfile: readonly PvProfileRecord[] | null,
    config: ScannerConfig,
    inputSummary: InputSummary,
  ): RecommendationReport {
    const topN = config.topN ?? 3;
    const allScenarios: FinancialResult[] = [];
    const deviceDb = loadDeviceDatabase();
    const storageById = new Map(deviceDb.storages.map((item) => [item.id, item]));
    const inverterPlanes = config.inverterPlanes
      ?? (config.existingInverterBrands ?? []).map((brand) => ({ brand }));

    // --- Global baseline: bez PV, bez magazynu ---
    const baselineTimeSeries = this.buildTimeSeries(loadProfile, pvBaseProfile, 0);
    const globalBaseline = this.engine.run(baselineTimeSeries, 0, 1, null);

    // --- Skanuj każdy rozmiar PV ---
    for (const pvSizeKwp of config.pvSizesToTest) {
      // Przygotuj profil danych wejściowych z odpowiednią mocą PV
      const timeSeries = this.buildTimeSeries(loadProfile, pvBaseProfile, pvSizeKwp);

      // --- Baseline per PV size: z PV ale bez magazynu ---
      const pvBaseline = this.engine.run(timeSeries, pvSizeKwp, 1, null);

      // --- Każdy produkt × ilość modułów ---
      for (const product of config.products) {
        const maxModules = product.maxModules;

        const storage = storageById.get(product.id);
        if (storage === undefined) {
          throw new Error(`Baza urządzeń: brak magazynu ${product.id}`);
        }

        for (let moduleCount = 1; moduleCount <= maxModules; moduleCount++) {
          const paths = inverterPaths({
            hasExistingPv: (config.existingPvKwp ?? 0) > 0,
            planes: inverterPlanes,
            phases: config.connectionPhases,
            pvKwp: pvSizeKwp,
            compatibleInverterIds: storage.compatibleInverterIds,
            builtInInverter: storage.builtInInverter,
            replacementCostNetPln: product.estimatedInverterUpgradeCostPln,
            inverters: deviceDb.inverters,
          });
          const evaluated = paths.map((path) => {
            const bessConfig = bessConfigForPath(product, moduleCount, path);
            const scenarioResult = this.engine.run(timeSeries, pvSizeKwp, 1, bessConfig);
            const financialResult = this.financialCalc.calculate(
              pvBaseline,
              scenarioResult,
              config.tariff,
              config.existingPvKwp ?? 0,
              config.clientSegment ?? "prosument",
              config.existingInverterBrands,
            );
            return { path, financialResult };
          });
          evaluated.sort((a, b) => {
            if (b.financialResult.npvPln !== a.financialResult.npvPln) {
              return b.financialResult.npvPln - a.financialResult.npvPln;
            }
            return a.path.coupling === "DC" ? -1 : 1;
          });
          const winner = evaluated[0]!;
          const loser = evaluated[1];
          const alternative: InverterAlternative | undefined = loser === undefined ? undefined : {
            coupling: loser.path.coupling,
            label: loser.path.label,
            inverterUpgradeCostPln: loser.financialResult.inverterUpgradeCostPln,
            npvPln: loser.financialResult.npvPln,
            paybackYears: loser.financialResult.paybackYears,
          };

          // Kroki 15-min (35 040 rekordów) są potrzebne tylko chwilowo, do
          // policzenia kosztu energii powyżej — przy setkach scenariuszy
          // jednoczesne trzymanie ich wszystkich w pamięci wyczerpuje heap.
          // Zwalniamy je od razu, zanim wynik trafi do listy `allScenarios`.
          allScenarios.push({
            ...winner.financialResult,
            simulationResult: { ...winner.financialResult.simulationResult, steps: [] },
            ...(alternative !== undefined ? { inverterAlternative: alternative } : {}),
          });
        }
      }
    }

    // --- Sortuj po payback ASC (krótszy payback = lepszy) ---
    // Remis (np. wszystkie z nieskończonym payback) rozstrzyga wyższe ROI —
    // bez tego `Infinity - Infinity = NaN` zostawiałoby kolejność przypadkową.
    allScenarios.sort((a, b) =>
      a.paybackYears === b.paybackYears
        ? b.roiPercent - a.roiPercent
        : a.paybackYears - b.paybackYears,
    );

    // --- Top N ---
    const top3 = allScenarios.slice(0, topN);

    // --- Wariant "samo PV" dla mocy PV z top1 (I9 audytu 30.09.2026) ---
    // Jeden dodatkowy przebieg bez magazynu, tylko dla jednej mocy PV.
    let pvOnly: PvOnlyResult | undefined;
    const bestSim = allScenarios[0]?.simulationResult;
    if (bestSim !== undefined && bestSim.pvSizeKwp > (config.existingPvKwp ?? 0)) {
      const pvTimeSeries = this.buildTimeSeries(loadProfile, pvBaseProfile, bestSim.pvSizeKwp);
      const pvOnlySim = this.engine.run(pvTimeSeries, bestSim.pvSizeKwp, 1, null);
      // Punkt odniesienia = obiekt z samym ISTNIEJĄCYM PV (bez magazynu) — inaczej zyski z już
      // opłaconego PV wpadłyby do oszczędności z dokładanego (płacimy tylko za dołożone).
      const existingKwp = config.existingPvKwp ?? 0;
      const referenceSim = existingKwp > 0
        ? this.engine.run(this.buildTimeSeries(loadProfile, pvBaseProfile, existingKwp), existingKwp, 1, null)
        : globalBaseline;
      pvOnly = this.financialCalc.calculatePvOnly(
        referenceSim, pvOnlySim, config.tariff, config.existingPvKwp ?? 0, config.clientSegment ?? "prosument",
      ) ?? undefined;
    }

    // --- Efekt samej zmiany taryfy (I7) ---
    let tariffChange: TariffChangeEffect | undefined;
    if (config.currentTariff !== undefined) {
      const existingKwp = config.existingPvKwp ?? 0;
      const referenceSim = existingKwp > 0
        ? this.engine.run(this.buildTimeSeries(loadProfile, pvBaseProfile, existingKwp), existingKwp, 1, null)
        : globalBaseline;
      tariffChange = this.financialCalc.calculateTariffChangeEffect(
        referenceSim, config.currentTariff.schedule, config.tariff,
        config.currentTariff.name, config.currentTariff.targetName, config.clientSegment ?? "prosument",
      );
    }

    // --- Analiza wrażliwości rekomendowanego wariantu (audyt: wykres tornado) ---
    const sensitivity = allScenarios[0] !== undefined && allScenarios[0].simulationResult.bessConfig !== null
      ? this.computeSensitivity(loadProfile, pvBaseProfile, allScenarios[0], config)
      : undefined;

    // --- Drugi ranking: po NPV (I8 audytu 30.09.2026) ---
    // Ranking po payback faworyzuje najmniejszy, najtańszy magazyn — ma krótki
    // zwrot, ale mały łączny zysk. NPV pokazuje, który wariant daje klientowi
    // najwięcej wartości w całym horyzoncie. Bierzemy tylko warianty, które się
    // zwracają w horyzoncie (inaczej "najlepszy NPV" mógłby być nadal ujemny).
    const top3ByNpv = allScenarios
      .filter((s) => Number.isFinite(s.paybackYears) && s.paybackYears <= this.financialConfig.horizonYears)
      .sort((a, b) => b.npvPln - a.npvPln)
      .slice(0, topN);

    // --- Najlepsza konfiguracja każdego producenta (lista jest już posortowana) ---
    const bestPerManufacturer = this.pickBestPerManufacturer(allScenarios);

    // --- Tekstowa rekomendacja ---
    const recommendation = this.generateRecommendation(top3, globalBaseline, inputSummary, config.existingPvKwp ?? 0);
    const sizing = suggestStorageSize(loadProfile);
    const replacementReason = top3[0]?.replacementReason ?? "Brak rekomendowanego magazynu.";

    return {
      inputSummary,
      baseline: { ...globalBaseline, steps: [] },
      allScenarios,
      top3,
      top3ByNpv,
      pvOnly,
      tariffChange,
      sensitivity,
      bestPerManufacturer,
      recommendation,
      replacementReason,
      suggestedCapacityKwh: sizing.suggestedCapacityKwh,
      suggestedPowerKw: sizing.suggestedPowerKw,
    };
  }

  /**
   * Analiza wrażliwości NPV dla jednego wariantu: każde założenie przesuwane osobno
   * w dół i w górę. Zmiany czysto finansowe liczą tylko finanse na tych samych
   * przebiegach energii; sprawność magazynu wymaga ponownej symulacji.
   */
  private computeSensitivity(
    loadProfile: readonly TimeSeriesRecord[],
    pvBaseProfile: readonly PvProfileRecord[] | null,
    best: FinancialResult,
    config: ScannerConfig,
  ): { baseNpvPln: number; rows: SensitivityRow[] } {
    const bessConfig = best.simulationResult.bessConfig!;
    const pvSizeKwp = best.simulationResult.pvSizeKwp;
    const timeSeries = this.buildTimeSeries(loadProfile, pvBaseProfile, pvSizeKwp);
    const pvBaseline = this.engine.run(timeSeries, pvSizeKwp, 1, null);
    const scenario = this.engine.run(timeSeries, pvSizeKwp, 1, bessConfig);

    const npvFor = (
      cfg: FinancialAnalysisConfig,
      sim: SimulationResult = scenario,
    ): number => new FinancialCalculator(cfg).calculate(
      pvBaseline, sim, config.tariff, config.existingPvKwp ?? 0,
      config.clientSegment ?? "prosument", config.existingInverterBrands,
    ).npvPln;

    const base = this.financialConfig;
    const fmt2 = (x: number): string => x.toFixed(2).replace(".", ",");
    const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
    const rows: SensitivityRow[] = [];

    const exportLow = base.exportPricePerKwh * 0.5;
    const exportHigh = base.exportPricePerKwh * 1.5;
    rows.push({
      parameter: "Wartość eksportu do sieci",
      lowLabel: `${fmt2(exportLow)} zł/kWh`, highLabel: `${fmt2(exportHigh)} zł/kWh`,
      npvLowPln: npvFor({ ...base, exportPricePerKwh: exportLow }),
      npvHighPln: npvFor({ ...base, exportPricePerKwh: exportHigh }),
    });

    rows.push({
      parameter: "Wzrost cen energii rocznie",
      lowLabel: "0%", highLabel: "6%",
      npvLowPln: npvFor({ ...base, energyPriceInflation: 0 }),
      npvHighPln: npvFor({ ...base, energyPriceInflation: 0.06 }),
    });

    rows.push({
      parameter: "Stopa dyskontowa",
      lowLabel: "8%", highLabel: "3%",
      npvLowPln: npvFor({ ...base, discountRate: 0.08 }),
      npvHighPln: npvFor({ ...base, discountRate: 0.03 }),
    });

    const withProduct = (patch: Partial<BessProduct>): BessConfig => ({
      ...bessConfig,
      product: { ...bessConfig.product, ...patch },
    });

    const baseEff = bessConfig.product.roundTripEfficiency;
    const effLow = Math.max(0.5, baseEff - 0.05);
    const effHigh = Math.min(0.99, baseEff + 0.03);
    rows.push({
      parameter: "Sprawność magazynu (round-trip)",
      lowLabel: pct(effLow), highLabel: pct(effHigh),
      npvLowPln: npvFor(base, this.engine.run(timeSeries, pvSizeKwp, 1, withProduct({ roundTripEfficiency: effLow }))),
      npvHighPln: npvFor(base, this.engine.run(timeSeries, pvSizeKwp, 1, withProduct({ roundTripEfficiency: effHigh }))),
    });

    const price = bessConfig.product.pricePerUnitPln;
    rows.push({
      parameter: "Cena magazynu",
      lowLabel: "+20%", highLabel: "−20%",
      npvLowPln: npvFor(base, this.engine.run(timeSeries, pvSizeKwp, 1, withProduct({ pricePerUnitPln: price * 1.2 }))),
      npvHighPln: npvFor(base, this.engine.run(timeSeries, pvSizeKwp, 1, withProduct({ pricePerUnitPln: price * 0.8 }))),
    });

    rows.sort((a, b) => Math.abs(b.npvHighPln - b.npvLowPln) - Math.abs(a.npvHighPln - a.npvLowPln));
    return { baseNpvPln: best.npvPln, rows };
  }

  /** Pierwszy (czyli najlepszy) wynik dla każdego producenta z posortowanej listy. */
  private pickBestPerManufacturer(sortedScenarios: readonly FinancialResult[]): FinancialResult[] {
    const seen = new Set<string>();
    const best: FinancialResult[] = [];

    for (const scenario of sortedScenarios) {
      const manufacturer = scenario.simulationResult.bessConfig?.product.manufacturer;
      if (manufacturer === undefined || seen.has(manufacturer)) continue;
      seen.add(manufacturer);
      best.push(scenario);
    }

    return best;
  }

  /**
   * Sprawdza jeden, ustalony magazyn (`bessConfig`) dla listy rozmiarów PV.
   * Używane do pytania "ile PV trzeba dołożyć, żeby TEN magazyn się zwrócił?" —
   * w przeciwieństwie do `scan()`, który przeszukuje wszystkie magazyny na raz.
   */
  scanPvRangeForBess(
    loadProfile: readonly TimeSeriesRecord[],
    pvBaseProfile: readonly PvProfileRecord[] | null,
    bessConfig: BessConfig,
    pvSizesToTest: readonly number[],
    tariff: TariffSchedule,
    existingPvKwp: number = 0,
    clientSegment: ClientSegment = "prosument",
    existingInverterBrands?: readonly string[],
  ): FinancialResult[] {
    return pvSizesToTest.map((pvSizeKwp) => {
      const timeSeries = this.buildTimeSeries(loadProfile, pvBaseProfile, pvSizeKwp);
      const pvBaseline = this.engine.run(timeSeries, pvSizeKwp, 1, null);
      const scenarioResult = this.engine.run(timeSeries, pvSizeKwp, 1, bessConfig);
      return this.financialCalc.calculate(pvBaseline, scenarioResult, tariff, existingPvKwp, clientSegment, existingInverterBrands);
    });
  }

  /**
   * Ponownie uruchamia symulację dla JEDNEGO, już wybranego scenariusza
   * (typowo: top1 z `scan()`), tym razem zachowując kroki 15-min, żeby
   * zagregować miesięczny rozkład wykorzystania PV: ile zużyte na miejscu,
   * ile naładowało magazyn, ile oddane do sieci. `scan()` sam tego nie zwraca,
   * bo `steps` są tam zwalniane od razu po każdym scenariuszu (setki
   * scenariuszy × 35 040 kroków wyczerpałoby pamięć) — tu chodzi o jeden,
   * konkretny scenariusz, więc jednorazowy dodatkowy przebieg jest tani.
   */
  computeMonthlyPvUsageBreakdown(
    loadProfile: readonly TimeSeriesRecord[],
    pvBaseProfile: readonly PvProfileRecord[] | null,
    bessConfig: BessConfig,
    pvSizeKwp: number,
  ): { monthly: MonthlyPvUsageBreakdown[]; daily: DailyPvUsageBreakdown[] } {
    const timeSeries = this.buildTimeSeries(loadProfile, pvBaseProfile, pvSizeKwp);
    const result = this.engine.run(timeSeries, pvSizeKwp, 1, bessConfig);

    const byMonth = new Map<string, MonthlyPvUsageBreakdown>();
    const byDay = new Map<string, DailyPvUsageBreakdown>();

    for (const step of result.steps) {
      const year = step.timestamp.getUTCFullYear();
      const month = step.timestamp.getUTCMonth();
      const day = step.timestamp.getUTCDate();
      const monthKey = `${year}-${month}`;
      const dayKey = `${year}-${month}-${day}`;
      const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

      const monthAcc = byMonth.get(monthKey) ?? {
        year, month, selfConsumedKwh: 0, bessChargedKwh: 0,
        bessChargedFromPvKwh: 0, bessChargedFromGridKwh: 0, gridExportKwh: 0,
      };
      byMonth.set(monthKey, {
        year,
        month,
        selfConsumedKwh: monthAcc.selfConsumedKwh + step.selfConsumedKwh,
        bessChargedKwh: monthAcc.bessChargedKwh + step.bessChargedKwh,
        bessChargedFromPvKwh: monthAcc.bessChargedFromPvKwh + step.bessChargedFromPvKwh,
        bessChargedFromGridKwh: monthAcc.bessChargedFromGridKwh + step.bessChargedFromGridKwh,
        gridExportKwh: monthAcc.gridExportKwh + step.gridExportKwh,
      });

      const dayAcc = byDay.get(dayKey) ?? {
        date, selfConsumedKwh: 0, bessChargedKwh: 0,
        bessChargedFromPvKwh: 0, bessChargedFromGridKwh: 0, gridExportKwh: 0,
      };
      byDay.set(dayKey, {
        date,
        selfConsumedKwh: dayAcc.selfConsumedKwh + step.selfConsumedKwh,
        bessChargedKwh: dayAcc.bessChargedKwh + step.bessChargedKwh,
        bessChargedFromPvKwh: dayAcc.bessChargedFromPvKwh + step.bessChargedFromPvKwh,
        bessChargedFromGridKwh: dayAcc.bessChargedFromGridKwh + step.bessChargedFromGridKwh,
        gridExportKwh: dayAcc.gridExportKwh + step.gridExportKwh,
      });
    }

    return {
      monthly: [...byMonth.values()].sort((a, b) => a.year - b.year || a.month - b.month),
      daily: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  /**
   * Buduje tablicę TimeSeriesRecord z profilu zużycia i profilu PV.
   *
   * Jeśli pvBaseProfile jest podany (model słońca dla 1 kWp), skaluje go do pvSizeKwp.
   * Jeśli pvBaseProfile jest null (dane SEMS z realną produkcją PV), używa danych as-is.
   */
  private buildTimeSeries(
    loadProfile: readonly TimeSeriesRecord[],
    pvBaseProfile: readonly PvProfileRecord[] | null,
    pvSizeKwp: number,
  ): TimeSeriesRecord[] {
    if (pvBaseProfile === null) {
      // Dane SEMS — PV już jest w loadProfile
      return loadProfile as TimeSeriesRecord[];
    }

    // Dane OSD + profil PV z modelu słońca — dopasowanie po DACIE kalendarzowej rekordu, nie po pozycji
    // w tablicy (I1 audytu): zużycie nie musi zaczynać się 1 stycznia ani mieć tyle samo dni co profil PV.
    const pvAt = getPvLookup(pvBaseProfile);
    const len = loadProfile.length;
    const result: TimeSeriesRecord[] = new Array<TimeSeriesRecord>(len);

    for (let i = 0; i < len; i++) {
      const load = loadProfile[i]!;

      result[i] = {
        timestamp: load.timestamp,
        loadKw: load.loadKw,
        pvProductionKw: pvAt(load.timestamp) * pvSizeKwp, // Skalowanie: 1kWp × pvSize
      };
    }

    return result;
  }

  /**
   * Generuje tekstowe uzasadnienie rekomendacji w języku polskim.
   */
  private generateRecommendation(
    top3: readonly FinancialResult[],
    baseline: SimulationResult,
    inputSummary: InputSummary,
    existingPvKwp: number = 0,
  ): string {
    if (top3.length === 0) {
      return "Nie znaleziono opłacalnej konfiguracji magazynu energii dla podanych parametrów.";
    }

    const best = top3[0]!;
    const bestSim = best.simulationResult;
    const bessConfig = bestSim.bessConfig;

    if (bessConfig === null) {
      return "Magazyn energii nie jest opłacalny przy aktualnych cenach energii i parametrach obiektu.";
    }

    // Efekt MAGAZYNU liczymy względem tego samego obiektu z tym samym PV, ale bez magazynu
    // (a nie względem obiektu bez PV, co wliczałoby w zasługę magazynu także samo PV).
    const deltaImport = best.referenceGridImportKwh - bestSim.totalGridImportKwh;
    const deltaAutocons = bestSim.selfConsumptionRate - best.referenceSelfConsumptionRate;

    const pvExpansionKwp = bestSim.pvSizeKwp - existingPvKwp;

    const lines: string[] = [
      `🏆 Rekomendacja #1: ${bessConfig.product.manufacturer} ${bessConfig.product.model}`,
      `   Konfiguracja: ${bessConfig.moduleCount}× moduł = ${bessConfig.product.usableCapacityKwh * bessConfig.moduleCount} kWh / ${bessPowerKw(bessConfig.product, bessConfig.moduleCount, bessConfig.inverterBatteryKw)} kW`,
      `   PV: ${bestSim.pvSizeKwp} kWp` +
        (pvExpansionKwp > 0.01 ? ` (rozbudowa o ${pvExpansionKwp.toFixed(1)} kWp względem obecnej instalacji ${existingPvKwp} kWp)` : ""),
      ``,
      `   📊 Wyniki symulacji:`,
      `   • Autokonsumpcja (samo PV → z magazynem): ${best.referenceSelfConsumptionRate.toFixed(0)}% → ${bestSim.selfConsumptionRate.toFixed(0)}% (+${deltaAutocons.toFixed(0)} pp)`,
      `   • Pobór z sieci (samo PV → z magazynem): ${best.referenceGridImportKwh.toFixed(0)} → ${bestSim.totalGridImportKwh.toFixed(0)} kWh/rok (oszczędność ${deltaImport.toFixed(0)} kWh)`,
      `   • Roczne cykle baterii: ${bestSim.annualCycles.toFixed(1)}`,
      ``,
      `   💰 Analiza finansowa:`,
      `   • Koszt magazynu: ${best.bessInvestmentCostPln.toFixed(0)} PLN` +
        (best.pvInvestmentCostPln > 0 ? ` + koszt rozbudowy PV: ${best.pvInvestmentCostPln.toFixed(0)} PLN` : ""),
      ...(bessConfig.inverterDecisionLabel !== undefined ? [`   • ${bessConfig.inverterDecisionLabel}`] : []),
      ...(best.inverterUpgradeCostPln > 0 ? [`   • Koszt falownika: ${best.inverterUpgradeCostPln.toFixed(0)} PLN`] : []),
      ...(best.inverterAlternative !== undefined
        ? [`   • Drugi wariant: ${best.inverterAlternative.label} NPV ${best.inverterAlternative.npvPln.toFixed(0)} PLN, koszt falownika ${best.inverterAlternative.inverterUpgradeCostPln.toFixed(0)} PLN.`]
        : []),
      `   • Koszt montażu: ${best.installationCostPln.toFixed(0)} PLN (orientacyjnie)`,
      `   • Koszt inwestycji łącznie: ${best.investmentCostPln.toFixed(0)} PLN`,
      `   • Roczne oszczędności (rok 1): ${best.annualSavingsYear1Pln.toFixed(0)} PLN`,
      `   • Okres zwrotu: ${best.paybackYears === Infinity ? "nie zwraca się" : best.paybackYears.toFixed(1) + " lat"}`,
      `   • ROI (${this.financialConfig.horizonYears} lat): ${best.roiPercent.toFixed(0)}%`,
      ...(best.replacementYear !== null
        ? [`   • ${best.replacementReason} Koszt wymiany ${best.replacementCostPln.toFixed(0)} PLN.`]
        : [`   • ${best.replacementReason}`]),
    ];

    if (best.paybackYears === Infinity || best.annualSavingsYear1Pln <= 0) {
      lines.push(``);
      lines.push(`   ⚠️  Magazyn energii nie zwraca się w rozsądnym horyzoncie czasowym.`);
      lines.push(`   Rozważ zwiększenie instalacji PV lub zmianę taryfy na wielostrefową.`);
    }

    return lines.join("\n");
  }
}
