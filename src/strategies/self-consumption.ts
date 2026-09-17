import type { ISimulationStrategy } from "./strategy.interface.js";
import type { TimeSeriesRecord } from "../types/timeseries.js";
import type { BessStateMachine } from "../bess/bess-state-machine.js";
import type { SimulationConfig, SimulationStepResult } from "../types/simulation.js";
import { kwToKwhPerStep } from "../utils/energy-math.js";

/**
 * Strategy focusing on maximizing PV self-consumption.
 */
export class SelfConsumptionStrategy implements ISimulationStrategy {
  /**
   * Executes a simulation step using self-consumption logic.
   * @param record Time series data for the step
   * @param bess Battery state machine (if available)
   * @param config Simulation config
   * @returns Simulation step result
   */
  public execute(
    record: TimeSeriesRecord,
    bess: BessStateMachine | null,
    config: SimulationConfig
  ): SimulationStepResult {
    const loadKwh = kwToKwhPerStep(record.loadKw);
    const pvProductionKwh = kwToKwhPerStep(record.pvProductionKw);
    
    const netLoadKwh = loadKwh - pvProductionKwh;
    
    let selfConsumedKwh = 0;
    let gridImportKwh = 0;
    let gridExportKwh = 0;
    let bessChargedKwh = 0;
    let bessDischargedKwh = 0;
    
    if (netLoadKwh > 0) {
      // Deficit: load is greater than PV production
      selfConsumedKwh = pvProductionKwh;
      
      if (bess !== null) {
        const dischargeResult = bess.discharge(netLoadKwh);
        bessDischargedKwh = dischargeResult.dischargedKwh;
        gridImportKwh = netLoadKwh - bessDischargedKwh;
      } else {
        gridImportKwh = netLoadKwh;
      }
    } else if (netLoadKwh < 0) {
      // Surplus: PV production is greater than load
      selfConsumedKwh = loadKwh;
      const surplusKwh = -netLoadKwh;
      
      if (bess !== null) {
        const chargeResult = bess.charge(surplusKwh);
        bessChargedKwh = chargeResult.chargedKwh;
        gridExportKwh = surplusKwh - bessChargedKwh;
      } else {
        gridExportKwh = surplusKwh;
      }
    } else {
      // Perfect balance: PV production exactly matches load
      selfConsumedKwh = loadKwh;
    }
    
    return {
      timestamp: record.timestamp,
      loadKw: record.loadKw,
      pvProductionKw: record.pvProductionKw,
      selfConsumedKwh,
      gridImportKwh,
      gridExportKwh,
      bessChargedKwh,
      bessDischargedKwh,
      bessState: bess !== null ? bess.getState() : null
    };
  }
}
