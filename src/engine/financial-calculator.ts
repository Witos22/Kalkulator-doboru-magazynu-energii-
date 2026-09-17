import type { BessConfig } from "../types/bess.js";
import type { FinancialAnalysisConfig, FinancialResult } from "../types/financial.js";
import type { SimulationResult, SimulationStepResult } from "../types/simulation.js";
import type { TariffSchedule } from "../types/tariff.js";
import { STEP_DURATION_H } from "../utils/energy-math.js";

/**
 * Domyślna konfiguracja analizy finansowej.
 */
export const DEFAULT_FINANCIAL_CONFIG: FinancialAnalysisConfig = {
  horizonYears: 15,
  discountRate: 0.05,
  energyPriceInflation: 0.03,
} as const;

/**
 * Kalkulator finansowy — oblicza payback, ROI, NPV
 * z uwzględnieniem degradacji baterii i inflacji cen energii.
 */
export class FinancialCalculator {
  constructor(
    private readonly config: FinancialAnalysisConfig = DEFAULT_FINANCIAL_CONFIG,
  ) {}

  /**
   * Oblicza wynik finansowy porównując scenariusz z magazynem do baseline (bez magazynu).
   *
   * @param baseline Wynik symulacji BEZ magazynu (wariant referencyjny)
   * @param scenario Wynik symulacji Z magazynem
   * @param tariff Harmonogram taryfowy (do wyceny oszczędności per strefa)
   * @returns Kompletny wynik finansowy z payback i ROI
   */
  calculate(
    baseline: SimulationResult,
    scenario: SimulationResult,
    tariff: TariffSchedule,
  ): FinancialResult {
    const bessConfig = scenario.bessConfig;

    if (bessConfig === null) {
      // Brak baterii = brak inwestycji = brak oszczędności
      return this.createEmptyResult(scenario);
    }

    // --- Koszt inwestycji ---
    const investmentCostPln = bessConfig.product.pricePerUnitPln * bessConfig.moduleCount;

    // --- Oszczędności rok 1 (porównanie kosztów energii baseline vs scenario) ---
    const baselineEnergyCost = this.calculateAnnualEnergyCost(baseline.steps, tariff);
    const scenarioEnergyCost = this.calculateAnnualEnergyCost(scenario.steps, tariff);
    const annualSavingsYear1Pln = baselineEnergyCost - scenarioEnergyCost;

    // --- Oszczędności rok po roku z degradacją i inflacją ---
    const degradation = bessConfig.product.degradationPerYear;
    const annualSavingsWithDegradation: number[] = [];
    const cumulativeSavings: number[] = [];
    let cumulative = 0;
    let paybackYears = Infinity;
    let npvPln = -investmentCostPln;

    for (let year = 1; year <= this.config.horizonYears; year++) {
      // Degradacja zmniejsza oszczędności (mniejsza pojemność → mniej przesuniętej energii)
      const capacityFactor = Math.pow(1 - degradation, year);
      // Inflacja cen energii zwiększa wartość oszczędności
      const inflationFactor = Math.pow(1 + this.config.energyPriceInflation, year - 1);

      const savingsThisYear = annualSavingsYear1Pln * capacityFactor * inflationFactor;
      annualSavingsWithDegradation.push(savingsThisYear);

      const prevCumulative = cumulative;
      cumulative += savingsThisYear;
      cumulativeSavings.push(cumulative);

      // Payback: interpolacja liniowa w roku, kiedy kumulatywne oszczędności przekraczają koszt
      if (paybackYears === Infinity && cumulative >= investmentCostPln) {
        // Liniowa interpolacja wewnątrz roku
        const fractionOfYear = savingsThisYear > 0
          ? (investmentCostPln - prevCumulative) / savingsThisYear
          : 1;
        paybackYears = (year - 1) + fractionOfYear;
      }

      // NPV
      const discountFactor = Math.pow(1 + this.config.discountRate, year);
      npvPln += savingsThisYear / discountFactor;
    }

    // --- ROI ---
    const totalSavings = cumulative;
    const roiPercent = investmentCostPln > 0
      ? ((totalSavings - investmentCostPln) / investmentCostPln) * 100
      : 0;

    // --- Koszt per cykl ---
    const totalLifetimeCycles = scenario.annualCycles * bessConfig.product.warrantyYears;
    const costPerCyclePln = totalLifetimeCycles > 0
      ? investmentCostPln / totalLifetimeCycles
      : Infinity;

    return {
      simulationResult: scenario,
      investmentCostPln,
      annualSavingsYear1Pln,
      annualSavingsWithDegradation,
      cumulativeSavings,
      paybackYears,
      roiPercent,
      costPerCyclePln,
      npvPln,
    };
  }

  /**
   * Oblicza roczny koszt energii na podstawie kroków symulacji i taryfy.
   * Koszt = Σ (gridImportKwh × cena_strefy) - Σ (gridExportKwh × cena_eksportu)
   *
   * Dla uproszczenia: cena eksportu = 0 (net-billing w Polsce — prosument
   * dostaje depozyt, ale rozliczenie jest złożone, więc na razie zakładamy
   * że eksport ma zerową wartość — konserwatywne podejście).
   */
  private calculateAnnualEnergyCost(
    steps: readonly SimulationStepResult[],
    tariff: TariffSchedule,
  ): number {
    let totalCost = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const zone = tariff.resolve(step.timestamp);
      totalCost += step.gridImportKwh * zone.pricePerKwh;
    }

    return totalCost;
  }

  /**
   * Tworzy pusty wynik finansowy (dla wariantu bez baterii).
   */
  private createEmptyResult(scenario: SimulationResult): FinancialResult {
    return {
      simulationResult: scenario,
      investmentCostPln: 0,
      annualSavingsYear1Pln: 0,
      annualSavingsWithDegradation: [],
      cumulativeSavings: [],
      paybackYears: Infinity,
      roiPercent: 0,
      costPerCyclePln: Infinity,
      npvPln: 0,
    };
  }
}
