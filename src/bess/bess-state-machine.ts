import type { BessConfig, BessState, BessStepResult } from "../types/bess.js";
import { halfRoundTripEfficiency, STEP_DURATION_H } from "../utils/energy-math.js";

/**
 * Battery state machine handling BESS physics, limits, and degradation.
 */
export class BessStateMachine {
  private config: BessConfig;
  private currentUsableCapacityKwh: number;
  private socKwh: number;

  /**
   * Initializes a new battery state machine.
   * @param config Configuration for the BESS
   */
  constructor(config: BessConfig) {
    this.config = config;
    this.currentUsableCapacityKwh = config.product.usableCapacityKwh * config.moduleCount;
    this.socKwh = this.currentUsableCapacityKwh * 0.5; // Initial SoC = 50%
  }

  /**
   * Tries to charge the battery with the requested energy [kWh].
   * @param requestedKwh Energy requested to charge from the source
   * @returns Result containing actual charged energy and new state
   */
  public charge(requestedKwh: number): BessStepResult {
    const totalMaxPowerKw = this.config.product.maxChargePowerKw * this.config.moduleCount;
    const maxKwhPerStep = totalMaxPowerKw * STEP_DURATION_H;
    
    // Limit by power
    const powerLimitedKwh = Math.min(requestedKwh, maxKwhPerStep);
    
    // Efficiency on charge side (energy actually stored internally)
    const eff = halfRoundTripEfficiency(this.config.product.roundTripEfficiency);
    const internalEnergyAdded = powerLimitedKwh * eff;
    
    // Limit by capacity
    const availableSpaceKwh = this.currentUsableCapacityKwh - this.socKwh;
    
    let actualInternalAdded = internalEnergyAdded;
    let clipped = false;
    
    if (actualInternalAdded > availableSpaceKwh) {
      actualInternalAdded = availableSpaceKwh;
      clipped = true;
    }
    
    if (powerLimitedKwh < requestedKwh) {
      clipped = true;
    }

    this.socKwh += actualInternalAdded;

    // External energy drawn (before efficiency losses)
    const externalChargedKwh = actualInternalAdded / eff;

    return {
      chargedKwh: externalChargedKwh,
      dischargedKwh: 0,
      newState: this.getState(),
      clipped
    };
  }

  /**
   * Tries to discharge the battery by the requested energy [kWh].
   * @param requestedKwh Energy requested to be delivered to the load
   * @returns Result containing actual discharged energy and new state
   */
  public discharge(requestedKwh: number): BessStepResult {
    const totalMaxPowerKw = this.config.product.maxDischargePowerKw * this.config.moduleCount;
    const maxKwhPerStep = totalMaxPowerKw * STEP_DURATION_H;
    
    // Limit by power
    const powerLimitedKwh = Math.min(requestedKwh, maxKwhPerStep);
    
    // Efficiency on discharge side (internal energy needed to deliver powerLimitedKwh)
    const eff = halfRoundTripEfficiency(this.config.product.roundTripEfficiency);
    const internalEnergyRemoved = powerLimitedKwh / eff;
    
    // Limit by Depth of Discharge (DoD)
    const minSocKwh = this.currentUsableCapacityKwh * (1 - this.config.product.dodPercent / 100);
    const availableEnergyKwh = Math.max(0, this.socKwh - minSocKwh);
    
    let actualInternalRemoved = internalEnergyRemoved;
    let clipped = false;
    
    if (actualInternalRemoved > availableEnergyKwh) {
      actualInternalRemoved = availableEnergyKwh;
      clipped = true;
    }
    
    if (powerLimitedKwh < requestedKwh) {
      clipped = true;
    }

    this.socKwh -= actualInternalRemoved;
    
    // External energy delivered (after efficiency losses)
    const externalDischargedKwh = actualInternalRemoved * eff;

    return {
      chargedKwh: 0,
      dischargedKwh: externalDischargedKwh,
      newState: this.getState(),
      clipped
    };
  }

  /**
   * Gets the current state of the battery.
   * @returns A readonly snapshot of the current state
   */
  public getState(): Readonly<BessState> {
    return {
      socKwh: this.socKwh,
      socPercent: this.currentUsableCapacityKwh > 0 
        ? (this.socKwh / this.currentUsableCapacityKwh) * 100 
        : 0,
      usableCapacityKwh: this.currentUsableCapacityKwh
    };
  }

}
