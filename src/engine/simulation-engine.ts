import type { BessConfig } from "../types/bess.js";
import type {
  SimulationResult,
  SimulationStepResult,
} from "../types/simulation.js";
import type { TimeSeriesRecord } from "../types/timeseries.js";
import type { ISimulationStrategy } from "../strategies/strategy.interface.js";
import { BessStateMachine } from "../bess/bess-state-machine.js";
import {
  isPvSeason,
  kwToKwhPerStep,
  pvSeasonDays,
  STEP_DURATION_H,
} from "../utils/energy-math.js";

/**
 * Silnik symulacji — wykonuje pętlę 35 040 kroków (15-min)
 * dla jednej konfiguracji PV + BESS z wybraną strategią.
 */
export class SimulationEngine {
  constructor(
    private readonly strategy: ISimulationStrategy,
  ) {}

  /**
   * Uruchamia symulację roczną.
   *
   * @param timeSeries Profil zużycia obiektu (35 040 rekordów 15-min)
   * @param pvSizeKwp Moc PV [kWp] — jeśli 0, pvProductionKw z timeSeries jest użyte as-is
   * @param pvScaleFactor Współczynnik skalowania PV (np. jeśli timeSeries ma PV dla 1 kWp, a chcemy 6 kWp → factor=6)
   * @param bessConfig Konfiguracja baterii (null = brak magazynu, wariant baseline)
   * @returns Zagregowane wyniki roczne
   */
  run(
    timeSeries: readonly TimeSeriesRecord[],
    pvSizeKwp: number,
    pvScaleFactor: number,
    bessConfig: BessConfig | null,
  ): SimulationResult {
    const bess = bessConfig !== null
      ? new BessStateMachine(bessConfig)
      : null;

    const stepCount = timeSeries.length;
    const steps: SimulationStepResult[] = new Array<SimulationStepResult>(stepCount);

    // --- Główna pętla symulacji ---
    for (let i = 0; i < stepCount; i++) {
      const record = timeSeries[i]!;

      // Skalowanie PV jeśli potrzebne
      const scaledRecord: TimeSeriesRecord = pvScaleFactor !== 1
        ? {
            timestamp: record.timestamp,
            loadKw: record.loadKw,
            pvProductionKw: record.pvProductionKw * pvScaleFactor,
          }
        : record;

      steps[i] = this.strategy.execute(
        scaledRecord,
        bess,
        { pvSizeKwp, bessConfig, contractedPowerKw: 0 },
      );
    }

    return this.aggregate(steps, pvSizeKwp, bessConfig, bess);
  }

  /**
   * Agreguje wyniki poszczególnych kroków do rocznych KPI.
   */
  private aggregate(
    steps: SimulationStepResult[],
    pvSizeKwp: number,
    bessConfig: BessConfig | null,
    bess: BessStateMachine | null,
  ): SimulationResult {
    let totalLoadKwh = 0;
    let totalPvProductionKwh = 0;
    let totalSelfConsumedKwh = 0;
    let totalGridImportKwh = 0;
    let totalGridExportKwh = 0;
    let totalBessChargedKwh = 0;
    let totalBessDischargedKwh = 0;
    let peakGridImportKw = 0;

    let pvSeasonChargedKwh = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;

      totalLoadKwh += kwToKwhPerStep(step.loadKw);
      totalPvProductionKwh += kwToKwhPerStep(step.pvProductionKw);
      totalSelfConsumedKwh += step.selfConsumedKwh;
      totalGridImportKwh += step.gridImportKwh;
      totalGridExportKwh += step.gridExportKwh;
      totalBessChargedKwh += step.bessChargedKwh;
      totalBessDischargedKwh += step.bessDischargedKwh;

      // Szczytowy pobór z sieci [kW]
      const gridImportKw = step.gridImportKwh / STEP_DURATION_H;
      if (gridImportKw > peakGridImportKw) {
        peakGridImportKw = gridImportKw;
      }

      // Cykle w sezonie PV
      if (isPvSeason(step.timestamp)) {
        pvSeasonChargedKwh += step.bessChargedKwh;
      }
    }

    // --- Wskaźniki BESS ---
    const usableCapacity = bessConfig !== null
      ? bessConfig.product.usableCapacityKwh * bessConfig.moduleCount
      : 0;

    const annualCycles = usableCapacity > 0
      ? totalBessChargedKwh / usableCapacity
      : 0;

    // Cykle dziennie w sezonie PV (III–IX)
    const year = steps.length > 0 ? steps[0]!.timestamp.getFullYear() : new Date().getFullYear();
    const seasonDays = pvSeasonDays(year);
    const pvSeasonCycles = usableCapacity > 0
      ? pvSeasonChargedKwh / usableCapacity
      : 0;
    const dailyCyclesSeasonPv = seasonDays > 0
      ? pvSeasonCycles / seasonDays
      : 0;

    // Maksymalne możliwe cykle (1 cykl/dzień × 365 dni)
    const maxPossibleCycles = 365;
    const storageUtilizationPercent = maxPossibleCycles > 0
      ? (annualCycles / maxPossibleCycles) * 100
      : 0;

    // --- Wskaźniki procentowe ---
    const selfConsumptionRate = totalPvProductionKwh > 0
      ? (totalSelfConsumedKwh / totalPvProductionKwh) * 100
      : 0;

    const autarkyRate = totalLoadKwh > 0
      ? ((totalSelfConsumedKwh + totalBessDischargedKwh) / totalLoadKwh) * 100
      : 0;

    return {
      bessConfig,
      pvSizeKwp,
      totalLoadKwh,
      totalPvProductionKwh,
      totalSelfConsumedKwh,
      totalGridImportKwh,
      totalGridExportKwh,
      totalBessChargedKwh,
      totalBessDischargedKwh,
      selfConsumptionRate,
      autarkyRate,
      peakGridImportKw,
      annualCycles,
      dailyCyclesSeasonPv,
      storageUtilizationPercent,
      steps,
    };
  }
}
