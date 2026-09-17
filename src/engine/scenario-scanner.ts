import type { BessConfig, BessProduct } from "../types/bess.js";
import type {
  FinancialAnalysisConfig,
  FinancialResult,
  RecommendationReport,
  InputSummary,
} from "../types/financial.js";
import type { SimulationResult } from "../types/simulation.js";
import type { TimeSeriesRecord } from "../types/timeseries.js";
import type { TariffSchedule } from "../types/tariff.js";
import type { PvProfileRecord } from "../types/pvgis.js";
import type { ISimulationStrategy } from "../strategies/strategy.interface.js";
import { SimulationEngine } from "./simulation-engine.js";
import { FinancialCalculator, DEFAULT_FINANCIAL_CONFIG } from "./financial-calculator.js";
import { kwToKwhPerStep } from "../utils/energy-math.js";

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
  /** Konfiguracja analizy finansowej */
  readonly financialConfig?: FinancialAnalysisConfig;
  /** Ilość top rekomendacji do zwrócenia */
  readonly topN?: number;
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
   * @param pvBaseProfile Profil PV z PVGIS dla 1 kWp (35 040 rekordów) — null jeśli użytkownik ma dane SEMS z PV
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

        for (let moduleCount = 1; moduleCount <= maxModules; moduleCount++) {
          const bessConfig: BessConfig = { product, moduleCount };

          // Uruchom symulację
          const scenarioResult = this.engine.run(timeSeries, pvSizeKwp, 1, bessConfig);

          // Oblicz finanse — porównanie z PV baseline (ten sam PV, ale bez baterii)
          const financialResult = this.financialCalc.calculate(
            pvBaseline,
            scenarioResult,
            config.tariff,
          );

          allScenarios.push(financialResult);
        }
      }
    }

    // --- Sortuj po payback ASC (krótszy payback = lepszy) ---
    allScenarios.sort((a, b) => a.paybackYears - b.paybackYears);

    // --- Top N ---
    const top3 = allScenarios.slice(0, topN);

    // --- Tekstowa rekomendacja ---
    const recommendation = this.generateRecommendation(top3, globalBaseline, inputSummary);

    return {
      inputSummary,
      baseline: globalBaseline,
      allScenarios,
      top3,
      recommendation,
    };
  }

  /**
   * Buduje tablicę TimeSeriesRecord z profilu zużycia i profilu PV.
   *
   * Jeśli pvBaseProfile jest podany (z PVGIS dla 1 kWp), skaluje go do pvSizeKwp.
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

    // Dane OSD + profil PV z PVGIS
    const len = Math.min(loadProfile.length, pvBaseProfile.length);
    const result: TimeSeriesRecord[] = new Array<TimeSeriesRecord>(len);

    for (let i = 0; i < len; i++) {
      const load = loadProfile[i]!;
      const pv = pvBaseProfile[i]!;

      result[i] = {
        timestamp: load.timestamp,
        loadKw: load.loadKw,
        pvProductionKw: pv.pvProductionKw * pvSizeKwp, // Skalowanie: 1kWp × pvSize
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

    const deltaImport = baseline.totalGridImportKwh - bestSim.totalGridImportKwh;
    const deltaAutocons = bestSim.selfConsumptionRate - baseline.selfConsumptionRate;

    const lines: string[] = [
      `🏆 Rekomendacja #1: ${bessConfig.product.manufacturer} ${bessConfig.product.model}`,
      `   Konfiguracja: ${bessConfig.moduleCount}× moduł = ${bessConfig.product.usableCapacityKwh * bessConfig.moduleCount} kWh / ${bessConfig.product.maxChargePowerKw} kW`,
      `   PV: ${bestSim.pvSizeKwp} kWp`,
      ``,
      `   📊 Wyniki symulacji:`,
      `   • Autokonsumpcja: ${baseline.selfConsumptionRate.toFixed(0)}% → ${bestSim.selfConsumptionRate.toFixed(0)}% (+${deltaAutocons.toFixed(0)} pp)`,
      `   • Pobór z sieci: ${baseline.totalGridImportKwh.toFixed(0)} → ${bestSim.totalGridImportKwh.toFixed(0)} kWh/rok (oszczędność ${deltaImport.toFixed(0)} kWh)`,
      `   • Roczne cykle baterii: ${bestSim.annualCycles.toFixed(1)}`,
      ``,
      `   💰 Analiza finansowa:`,
      `   • Koszt inwestycji: ${best.investmentCostPln.toFixed(0)} PLN`,
      `   • Roczne oszczędności (rok 1): ${best.annualSavingsYear1Pln.toFixed(0)} PLN`,
      `   • Okres zwrotu: ${best.paybackYears === Infinity ? "nie zwraca się" : best.paybackYears.toFixed(1) + " lat"}`,
      `   • ROI (${this.financialConfig.horizonYears} lat): ${best.roiPercent.toFixed(0)}%`,
    ];

    if (best.paybackYears === Infinity || best.annualSavingsYear1Pln <= 0) {
      lines.push(``);
      lines.push(`   ⚠️  Magazyn energii nie zwraca się w rozsądnym horyzoncie czasowym.`);
      lines.push(`   Rozważ zwiększenie instalacji PV lub zmianę taryfy na wielostrefową.`);
    }

    return lines.join("\n");
  }
}
