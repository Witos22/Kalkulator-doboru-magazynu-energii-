import type { BessConfig } from "../types/bess.js";
import type { ClientSegment, FinancialAnalysisConfig, FinancialResult, PvOnlyResult, TariffChangeEffect } from "../types/financial.js";
import type { SimulationResult, SimulationStepResult } from "../types/simulation.js";
import type { TariffSchedule } from "../types/tariff.js";
import { STEP_DURATION_H } from "../utils/energy-math.js";
import { replacementPlan } from "./storage-sizing.js";

/**
 * Domyślna konfiguracja analizy finansowej.
 */
export const DEFAULT_FINANCIAL_CONFIG: FinancialAnalysisConfig = {
  horizonYears: 15,
  discountRate: 0.05,
  energyPriceInflation: 0.03,
  pvCostPerKwp: 4100,
  pvFixedCostPln: 4000,
  exportPricePerKwh: 0.30,
  vatRatePercent: 0.23,
  settlementSystem: "net-billing",
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
   * @param existingPvKwp Obecna (już opłacona) moc PV [kWp] — 0, jeśli klient nie ma PV
   * @param clientSegment Segment klienta — decyduje, czy ceny magazynu/PV I ceny energii
   *   z taryfy liczone są netto (firma, bo odlicza VAT) czy brutto z doliczonym VAT
   *   (prosument/b2c, bo to realny koszt, jaki poniosą). Katalog produktów, `pvCostPerKwp`
   *   ORAZ stawki taryfy przechowują ceny NETTO (tak jak na fakturze OSD — patrz kolumna
   *   "Cena jednostk. netto") — to jedyne miejsce, gdzie VAT jest doliczany (K6 audytu 30.09.2026:
   *   wcześniej ceny energii nie miały żadnego oznaczenia netto/brutto i VAT nigdy nie był
   *   doliczany do nich, tylko do CAPEX — niespójna baza).
   * @returns Kompletny wynik finansowy z payback i ROI
   */
  calculate(
    baseline: SimulationResult,
    scenario: SimulationResult,
    tariff: TariffSchedule,
    existingPvKwp: number = 0,
    clientSegment: ClientSegment = "prosument",
    existingInverterBrands?: readonly string[],
  ): FinancialResult {
    const bessConfig = scenario.bessConfig;

    // Klienci firmowi płacą i widzą ceny netto (odliczają VAT); prosumenci i
    // klienci B2C — ceny brutto, bo to realny koszt, jaki poniosą. Ta sama
    // stawka dotyczy CAPEX (magazyn/PV) i cen energii z taryfy — patrz K6.
    const vatMultiplier = clientSegment === "firma" ? 1 : 1 + this.config.vatRatePercent;

    if (bessConfig === null) {
      // Brak baterii = brak inwestycji = brak oszczędności
      return this.createEmptyResult(scenario, clientSegment);
    }

    // --- Koszt inwestycji ---
    const bessInvestmentCostPln = bessConfig.product.pricePerUnitPln * bessConfig.moduleCount * vatMultiplier;
    const additionalPvKwp = Math.max(0, scenario.pvSizeKwp - existingPvKwp);
    const pvInvestmentCostPln = additionalPvKwp > 0
      ? (this.config.pvFixedCostPln + additionalPvKwp * this.config.pvCostPerKwp) * vatMultiplier
      : 0;

    // Koszt falownika ustala decyzja o sprzężeniu i trafia na konfigurację.
    // Brak tej kwoty zostawia starszą regułę: 0 zł przy zgodnej marce, inaczej szacunek z katalogu.
    const required = bessConfig.product.requiredInverterBrand.toLowerCase();
    const hasCompatibleInverter = (existingInverterBrands ?? []).some((b) => b.trim().toLowerCase() === required);
    const inverterCostNetPln = bessConfig.inverterCostNetPln !== undefined
      ? bessConfig.inverterCostNetPln
      : hasCompatibleInverter ? 0 : bessConfig.product.estimatedInverterUpgradeCostPln;
    const inverterUpgradeCostPln = inverterCostNetPln * vatMultiplier;
    const installationCostPln = bessConfig.product.estimatedInstallationCostPln * vatMultiplier;

    const investmentCostPln = bessInvestmentCostPln + pvInvestmentCostPln + inverterUpgradeCostPln + installationCostPln;

    // Wymiana po krótszym z limitów: gwarancja albo cykle / cykle roczne.
    // Koszt (magazyn + montaż, bez falownika i PV) wpada na początku następnego roku.
    const plan = replacementPlan(
      bessConfig.product.warrantyYears,
      bessConfig.product.cycleLife,
      scenario.annualCycles,
      this.config.horizonYears,
    );
    const replacementYear = plan.replacementYear;
    const replacementReason = plan.replacementReason;
    const replacementCostPln = replacementYear !== null ? bessInvestmentCostPln + installationCostPln : 0;

    // --- Oszczędności rok 1 (porównanie kosztów energii baseline vs scenario) ---
    const baselineEnergyCost = this.calculateAnnualEnergyCost(baseline.steps, tariff, vatMultiplier, scenario.pvSizeKwp);
    const scenarioEnergyCost = this.calculateAnnualEnergyCost(scenario.steps, tariff, vatMultiplier, scenario.pvSizeKwp);
    const annualSavingsYear1Pln = baselineEnergyCost - scenarioEnergyCost;

    // --- Oszczędności rok po roku z degradacją i inflacją ---
    const degradation = bessConfig.product.degradationPerYear;
    const annualSavingsWithDegradation: number[] = [];
    const cumulativeSavings: number[] = [];
    let cumulative = 0;
    // Śledzimy PEŁNY przepływ pieniężny (nie same oszczędności), żeby poprawnie
    // uwzględnić koszt wymiany w roku `replacementYear` — payback to moment,
    // kiedy ten przepływ po raz pierwszy staje się nieujemny.
    let netCashFlowPln = -investmentCostPln;
    let paybackYears = Infinity;
    let npvPln = -investmentCostPln;

    for (let year = 1; year <= this.config.horizonYears; year++) {
      // Po wymianie magazyn "odmładza się" — degradacja liczona od roku wymiany.
      const yearsSincePurchaseOrReplacement = replacementYear !== null && year > replacementYear
        ? year - replacementYear
        : year;
      // Degradacja zmniejsza oszczędności (mniejsza pojemność → mniej przesuniętej energii)
      const capacityFactor = Math.pow(1 - degradation, yearsSincePurchaseOrReplacement);
      // Inflacja cen energii zwiększa wartość oszczędności
      const inflationFactor = Math.pow(1 + this.config.energyPriceInflation, year - 1);

      const savingsThisYear = annualSavingsYear1Pln * capacityFactor * inflationFactor;
      annualSavingsWithDegradation.push(savingsThisYear);

      const replacementThisYear = year === replacementYear ? replacementCostPln : 0;
      const prevNetCashFlow = netCashFlowPln;
      // Koszt wymiany poniesiony na starcie roku, przed doliczeniem tegorocznych oszczędności.
      netCashFlowPln -= replacementThisYear;
      netCashFlowPln += savingsThisYear;

      cumulative += savingsThisYear;
      cumulativeSavings.push(cumulative);

      // Payback: interpolacja liniowa w roku, kiedy przepływ pieniężny po raz pierwszy staje się nieujemny.
      if (paybackYears === Infinity && netCashFlowPln >= 0) {
        const netChangeThisYear = netCashFlowPln - prevNetCashFlow;
        const fractionOfYear = netChangeThisYear > 0
          ? (-prevNetCashFlow) / netChangeThisYear
          : 1;
        paybackYears = (year - 1) + Math.min(1, Math.max(0, fractionOfYear));
      }

      // NPV — oszczędności i ewentualny koszt wymiany, oba zdyskontowane do roku 0.
      const discountFactor = Math.pow(1 + this.config.discountRate, year);
      npvPln += (savingsThisYear - replacementThisYear) / discountFactor;
    }

    // --- ROI --- (uwzględnia koszt wymiany, jeśli wystąpiła w horyzoncie)
    const totalSavings = cumulative;
    const totalInvestedPln = investmentCostPln + replacementCostPln;
    const roiPercent = totalInvestedPln > 0
      ? ((totalSavings - totalInvestedPln) / totalInvestedPln) * 100
      : 0;

    // --- Koszt per cykl ---
    const cycleYears = scenario.annualCycles > 1e-9
      ? bessConfig.product.cycleLife / scenario.annualCycles
      : Number.POSITIVE_INFINITY;
    const serviceYears = Math.min(bessConfig.product.warrantyYears, cycleYears);
    const totalLifetimeCycles = Number.isFinite(serviceYears) ? scenario.annualCycles * serviceYears : 0;
    const costPerCyclePln = totalLifetimeCycles > 0
      ? investmentCostPln / totalLifetimeCycles
      : Infinity;

    return {
      simulationResult: scenario,
      investmentCostPln,
      bessInvestmentCostPln,
      referenceGridImportKwh: baseline.totalGridImportKwh,
      referenceSelfConsumptionRate: baseline.selfConsumptionRate,
      pvInvestmentCostPln,
      inverterUpgradeCostPln,
      installationCostPln,
      replacementYear,
      replacementReason,
      replacementCostPln,
      annualSavingsYear1Pln,
      annualSavingsWithDegradation,
      cumulativeSavings,
      paybackYears,
      roiPercent,
      costPerCyclePln,
      npvPln,
      priceBasis: clientSegment === "firma" ? "netto" : "brutto",
    };
  }

  /**
   * Wariant "samo PV, bez magazynu" (I9 audytu 30.09.2026): porównuje obiekt BEZ NOWEGO PV
   * (czyli z samym już istniejącym PV albo bez PV) z obiektem z dołożonym PV, bez magazynu —
   * oszczędności dotyczą wyłącznie DOŁOŻONEJ mocy, bo tylko za nią płaci inwestycja. Zwraca `null`, gdy scenariusz nie dokłada PV
   * (klient ma już opłacone PV albo moc scenariusza = moc istniejąca).
   * Degradacja modułów PV przyjęta orientacyjnie 0,5%/rok — [DO WERYFIKACJI].
   */
  /**
   * Efekt zmiany taryfy dla obiektu bez nowej inwestycji (I7). `reference` to
   * symulacja bez magazynu (taryfa nie wpływa na jej przepływy energii).
   */
  calculateTariffChangeEffect(
    reference: SimulationResult,
    currentTariff: TariffSchedule,
    targetTariff: TariffSchedule,
    currentTariffName: string,
    targetTariffName: string,
    clientSegment: ClientSegment,
  ): TariffChangeEffect {
    const vatMultiplier = clientSegment === "firma" ? 1 : 1 + this.config.vatRatePercent;
    const annualCostCurrentPln = this.calculateAnnualEnergyCost(reference.steps, currentTariff, vatMultiplier, reference.pvSizeKwp);
    const annualCostTargetPln = this.calculateAnnualEnergyCost(reference.steps, targetTariff, vatMultiplier, reference.pvSizeKwp);
    return {
      currentTariff: currentTariffName,
      targetTariff: targetTariffName,
      annualCostCurrentPln,
      annualCostTargetPln,
      annualEffectPln: annualCostCurrentPln - annualCostTargetPln,
    };
  }

  calculatePvOnly(
    baselineWithoutNewPv: SimulationResult,
    pvOnlyScenario: SimulationResult,
    tariff: TariffSchedule,
    existingPvKwp: number = 0,
    clientSegment: ClientSegment = "prosument",
  ): PvOnlyResult | null {
    const additionalPvKwp = Math.max(0, pvOnlyScenario.pvSizeKwp - existingPvKwp);
    if (additionalPvKwp <= 0) return null;

    const vatMultiplier = clientSegment === "firma" ? 1 : 1 + this.config.vatRatePercent;
    const investmentCostPln = (this.config.pvFixedCostPln + additionalPvKwp * this.config.pvCostPerKwp) * vatMultiplier;

    const annualSavingsYear1Pln =
      this.calculateAnnualEnergyCost(baselineWithoutNewPv.steps, tariff, vatMultiplier, existingPvKwp) -
      this.calculateAnnualEnergyCost(pvOnlyScenario.steps, tariff, vatMultiplier, pvOnlyScenario.pvSizeKwp);

    const PV_DEGRADATION_PER_YEAR = 0.005;
    let netCashFlowPln = -investmentCostPln;
    let cumulativeSavings = 0;
    let npvPln = -investmentCostPln;
    let paybackYears = Infinity;

    for (let year = 1; year <= this.config.horizonYears; year++) {
      const savingsThisYear = annualSavingsYear1Pln
        * Math.pow(1 - PV_DEGRADATION_PER_YEAR, year)
        * Math.pow(1 + this.config.energyPriceInflation, year - 1);
      const prev = netCashFlowPln;
      netCashFlowPln += savingsThisYear;
      cumulativeSavings += savingsThisYear;
      npvPln += savingsThisYear / Math.pow(1 + this.config.discountRate, year);
      if (paybackYears === Infinity && netCashFlowPln >= 0) {
        const change = netCashFlowPln - prev;
        paybackYears = (year - 1) + (change > 0 ? Math.min(1, Math.max(0, -prev / change)) : 1);
      }
    }

    return {
      pvSizeKwp: pvOnlyScenario.pvSizeKwp,
      investmentCostPln,
      annualSavingsYear1Pln,
      paybackYears,
      npvPln,
      roiPercent: investmentCostPln > 0 ? ((cumulativeSavings - investmentCostPln) / investmentCostPln) * 100 : 0,
    };
  }

  /**
   * Oblicza roczny koszt energii na podstawie kroków symulacji i taryfy.
   * Koszt = Σ (gridImportKwh × cena_strefy) − Σ (gridExportKwh × cena_eksportu)
   *
   * Cena eksportu (`exportPricePerKwh`) jest odejmowana SYMETRYCZNIE — zarówno
   * w wariancie bazowym, jak i ze scenariuszem — więc energia, którą magazyn
   * "zjada" z nadwyżki PV (a inaczej poszłaby na eksport), poprawnie traci swoją
   * wartość eksportową w rachunku oszczędności. Wcześniej cena eksportu = 0
   * zawyżała oszczędności magazynu, bo ta utracona wartość nigdzie nie była
   * odejmowana. `exportPricePerKwh` to nadal wartość orientacyjna (nie realna
   * RCEm) — patrz komentarz przy `FinancialAnalysisConfig.exportPricePerKwh`.
   *
   * `vatMultiplier` dolicza VAT do ceny energii z taryfy (przechowywanej jako
   * netto) dla segmentów prosument/b2c, tak samo jak przy CAPEX — patrz K6 audytu.
   * Cena eksportu NIE jest mnożona przez VAT (depozyt prosumencki nie działa
   * jak zwykła sprzedaż z VAT-em).
   */
  private calculateAnnualEnergyCost(
    steps: readonly SimulationStepResult[],
    tariff: TariffSchedule,
    vatMultiplier: number,
    installedPvKwp: number,
  ): number {
    if (this.config.settlementSystem === "opusty") {
      return this.calculateAnnualEnergyCostNetMetering(steps, tariff, vatMultiplier, installedPvKwp);
    }

    let totalCost = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const zone = tariff.resolve(step.timestamp);
      totalCost += step.gridImportKwh * zone.pricePerKwh * vatMultiplier;
      totalCost -= step.gridExportKwh * this.config.exportPricePerKwh;
    }

    return totalCost;
  }

  /**
   * Roczny koszt energii w systemie OPUSTÓW (net-metering, sprzed 1.04.2022).
   *
   * Zasady (uproszczony model — [DO WERYFIKACJI] ustawa OZE art. 4 i umowa z OSD):
   * - energia oddana do sieci daje kredyt w kWh, nie pieniądze,
   * - odebrać można nieodpłatnie 80% oddanej energii (instalacje do 10 kW) albo
   *   70% (powyżej 10 kW, do 50 kW) — reszta to "opłata" za magazynowanie w sieci,
   * - kredyt pomniejsza energię pobraną; płaci się tylko za nadwyżkę poboru ponad kredyt.
   *
   * Przybliżenia: bilans ROCZNY (kredyt z lata pokrywa import zimy — zgodnie z
   * możliwością odbioru w ciągu 365 dni) liczony OSOBNO PER STREFA TARYFOWA
   * (energia oddana w strefie pokrywa pobór w tej samej strefie; zasady rozliczenia
   * międzystrefowego bywają różne u OSD). Płaci się cenę strefy za energię pobraną
   * ponad kredyt (z VAT wg segmentu). `exportPricePerKwh` NIE jest tu używane —
   * oddana energia to kredyt, nie gotówka. Skutek dla magazynu: gdy roczny kredyt
   * pokrywa cały pobór, magazyn oszczędza ~0 zł; zyskuje tylko tam, gdzie pobór
   * przekracza kredyt, i tylko na różnicy sprawności magazynu (np. 0,95) vs
   * współczynnika opustu (0,8) — stąd "znikoma wartość" magazynu w opustach.
   */
  private calculateAnnualEnergyCostNetMetering(
    steps: readonly SimulationStepResult[],
    tariff: TariffSchedule,
    vatMultiplier: number,
    installedPvKwp: number,
  ): number {
    const creditRatio = installedPvKwp <= 10 ? 0.8 : 0.7;

    const perZone = new Map<string, { importKwh: number; exportKwh: number; pricePerKwh: number }>();
    for (const step of steps) {
      const zone = tariff.resolve(step.timestamp);
      const acc = perZone.get(zone.name) ?? { importKwh: 0, exportKwh: 0, pricePerKwh: zone.pricePerKwh };
      acc.importKwh += step.gridImportKwh;
      acc.exportKwh += step.gridExportKwh;
      perZone.set(zone.name, acc);
    }

    let totalCost = 0;
    for (const z of perZone.values()) {
      const paidImportKwh = Math.max(0, z.importKwh - creditRatio * z.exportKwh);
      totalCost += paidImportKwh * z.pricePerKwh * vatMultiplier;
    }
    return totalCost;
  }

  /**
   * Tworzy pusty wynik finansowy (dla wariantu bez baterii).
   */
  private createEmptyResult(scenario: SimulationResult, clientSegment: ClientSegment): FinancialResult {
    return {
      simulationResult: scenario,
      investmentCostPln: 0,
      bessInvestmentCostPln: 0,
      referenceGridImportKwh: scenario.totalGridImportKwh,
      referenceSelfConsumptionRate: scenario.selfConsumptionRate,
      pvInvestmentCostPln: 0,
      inverterUpgradeCostPln: 0,
      installationCostPln: 0,
      replacementYear: null,
      replacementReason: "Brak magazynu, więc nie ma wymiany.",
      replacementCostPln: 0,
      annualSavingsYear1Pln: 0,
      annualSavingsWithDegradation: [],
      cumulativeSavings: [],
      paybackYears: Infinity,
      roiPercent: 0,
      costPerCyclePln: Infinity,
      npvPln: 0,
      priceBasis: clientSegment === "firma" ? "netto" : "brutto",
    };
  }
}
