import type { TimeSeriesRecord } from "../types/timeseries.js";
import type { BessStateMachine } from "../bess/bess-state-machine.js";
import type { SimulationConfig, SimulationStepResult } from "../types/simulation.js";

/**
 * Interface for all simulation strategies.
 */
export interface ISimulationStrategy {
  /**
   * Opcjonalny przebieg wstępny przed pętlą symulacji — pozwala strategii
   * zajrzeć w profil roku (np. prognoza nadwyżki PV na kolejne dni).
   * @param timeSeries Pełny profil roku
   * @param pvScaleFactor Współczynnik skalowania PV stosowany przez silnik
   */
  prepare?(timeSeries: readonly TimeSeriesRecord[], pvScaleFactor: number): void;

  /**
   * Executes a single step of the simulation.
   * @param record The time series record for the current interval
   * @param bess The battery state machine instance (null if no battery)
   * @param config The overall simulation configuration
   * @returns Result containing energy balances for the interval
   */
  execute(
    record: TimeSeriesRecord,
    bess: BessStateMachine | null,
    config: SimulationConfig,
  ): SimulationStepResult;
}
