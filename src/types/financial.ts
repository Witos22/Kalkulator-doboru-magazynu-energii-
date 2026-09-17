import type { SimulationResult } from "./simulation.js";

/**
 * Wynik kalkulacji finansowej dla jednego scenariusza.
 */
export interface FinancialResult {
  /** Wynik symulacji energetycznej */
  readonly simulationResult: SimulationResult;
  /** Koszt zakupu magazynu [PLN] */
  readonly investmentCostPln: number;
  /** Roczne oszczędności w roku 1 [PLN] */
  readonly annualSavingsYear1Pln: number;
  /** Oszczędności rok po roku z uwzględnieniem degradacji [PLN] */
  readonly annualSavingsWithDegradation: readonly number[];
  /** Skumulowane oszczędności rok po roku [PLN] */
  readonly cumulativeSavings: readonly number[];
  /** Okres zwrotu inwestycji [lata] — Infinity jeśli nie zwraca się */
  readonly paybackYears: number;
  /** ROI na horyzoncie analizy [%] */
  readonly roiPercent: number;
  /** Koszt za jeden pełny cykl [PLN] */
  readonly costPerCyclePln: number;
  /** NPV na horyzoncie analizy [PLN] (opcjonalnie, stopa dyskontowa) */
  readonly npvPln: number;
}

/**
 * Raport rekomendacyjny — główny output systemu.
 */
export interface RecommendationReport {
  /** Podsumowanie danych wejściowych */
  readonly inputSummary: InputSummary;
  /** Wynik bazowy (bez magazynu) */
  readonly baseline: SimulationResult;
  /** Wszystkie przesymulowane scenariusze z wynikami finansowymi */
  readonly allScenarios: readonly FinancialResult[];
  /** Top 3 najlepsze konfiguracje po payback */
  readonly top3: readonly FinancialResult[];
  /** Tekstowe uzasadnienie rekomendacji */
  readonly recommendation: string;
}

/**
 * Podsumowanie danych wejściowych użytkownika.
 */
export interface InputSummary {
  readonly tariffType: string;
  readonly annualConsumptionKwh: number;
  readonly existingPvKwp: number | null;
  readonly location: {
    readonly lat: number;
    readonly lon: number;
  };
  readonly contractedPowerKw: number;
}

/**
 * Konfiguracja analizy finansowej.
 */
export interface FinancialAnalysisConfig {
  /** Horyzont analizy [lata] */
  readonly horizonYears: number;
  /** Roczna stopa dyskontowa dla NPV (np. 0.05 = 5%) */
  readonly discountRate: number;
  /** Roczny wzrost cen energii [%] (np. 0.03 = 3%) */
  readonly energyPriceInflation: number;
}
