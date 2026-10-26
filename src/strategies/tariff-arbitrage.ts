import type { ISimulationStrategy } from "./strategy.interface.js";
import type { TimeSeriesRecord } from "../types/timeseries.js";
import type { BessStateMachine } from "../bess/bess-state-machine.js";
import { bessPowerKw } from "../bess/bess-power.js";
import type { SimulationConfig, SimulationStepResult } from "../types/simulation.js";
import type { TariffSchedule } from "../types/tariff.js";
import { halfRoundTripEfficiency, kwToKwhPerStep, STEP_DURATION_H } from "../utils/energy-math.js";

const HALF_DAY_MS = 12 * 3_600_000;

function dayKey(ts: Date): string {
  return ts.toISOString().slice(0, 10);
}

/**
 * Strategia autokonsumpcji rozszerzona o arbitraż taryfowy: oprócz ładowania
 * z nadwyżki PV, dogrywa magazyn z sieci w najtańszej strefie taryfy (np. noc
 * w G12/G12w/G13), żeby uniknąć zakupu w drogiej strefie później.
 *
 * Zasady:
 * - W strefie NIE-najtańszej: zachowanie identyczne jak `SelfConsumptionStrategy`
 *   (ładowanie z nadwyżki PV, rozładowanie do pokrycia deficytu zużycia).
 * - W strefie najtańszej: magazyn NIE jest rozładowywany do pokrycia zużycia
 *   (deficyt kupowany wprost z sieci po niskiej cenie — rozładowanie tu
 *   marnowałoby "tanią" energię, którą lepiej zachować na drogą strefę).
 *   Zamiast tego magazyn jest dogrywany z sieci do limitu mocy/pojemności,
 *   ponad to, co już naładowała nadwyżka PV w tym kroku.
 * - Arbitraż włącza się tylko, gdy jest to opłacalne po uwzględnieniu STRAT
 *   sprawności ORAZ zużycia ogniw (K9 audytu 30.09.2026):
 *   cena_tania / roundTripEfficiency + koszt_cyklu_za_kWh < cena_droga.
 *   `koszt_cyklu_za_kWh` to orientacyjny koszt zdegradowania baterii o 1 kWh
 *   przełożonej energii: cena_magazynu_netto / (cykle_żywotności × pojemność_kWh).
 *   Bez tego warunku magazyn ładowałby się z sieci nawet wtedy, gdy różnica cen
 *   ledwo pokrywa straty sprawności, a nie pokrywa już zużycia samych ogniw —
 *   pozornie "opłacalny" arbitraż, który w praktyce skraca żywotność magazynu
 *   bez realnego zysku. Dla taryfy jednostrefowej (G11) warunek i tak nigdy nie
 *   jest spełniony — magazyn zachowuje się wtedy jak przy czystej autokonsumpcji.
 */
/** Limity mocy spoza magazynu (I6 audytu 30.09.2026). Brak pola = brak limitu. */
export interface GridLimits {
  /** Maks. moc poboru z sieci [kW] (moc przyłączeniowa / zabezpieczenie przedlicznikowe) */
  readonly maxGridImportKw?: number | undefined;
  /** Maks. moc oddawania do sieci [kW]; 0 = zero export. Nadwyżka ponad limit jest ucinana (PV dławione). */
  readonly maxExportKw?: number | undefined;
}

export class TariffArbitrageStrategy implements ISimulationStrategy {
  private readonly cheapPricePerKwh: number;
  private readonly expensivePricePerKwh: number;
  /** Prognozowana nadwyżka PV [kWh] w każdym dniu — rezerwa miejsca w magazynie na darmowe ładowanie. */
  private surplusByDay = new Map<string, number>();

  /**
   * @param enableGridArbitrage `false` wyłącza ładowanie z sieci (czysta autokonsumpcja) —
   *   używane w systemie opustów, gdzie energia z sieci rozliczana jest kredytem strefowym.
   */
  constructor(
    private readonly tariff: TariffSchedule,
    private readonly enableGridArbitrage: boolean = true,
    private readonly limits: GridLimits = {},
  ) {
    const { min, max } = TariffArbitrageStrategy.sampleZonePriceRange(tariff);
    this.cheapPricePerKwh = min;
    this.expensivePricePerKwh = max;
  }

  /**
   * Próbkuje `tariff.resolve()` co godzinę przez 8 kolejnych dni (pełny
   * tydzień + zapas), żeby wychwycić wszystkie strefy niezależnie od tego,
   * czy taryfa różnicuje ceny wg pory dnia, dnia tygodnia (G12w) czy obu.
   * Nie zależy od konkretnych nazw stref — działa też dla cen skorygowanych
   * ręcznie przez użytkownika w formularzu.
   */
  private static sampleZonePriceRange(tariff: TariffSchedule): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    const base = Date.UTC(2024, 0, 1, 0, 0); // dowolny poniedziałek — wzorzec tygodniowy

    for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
      for (let hour = 0; hour < 24; hour++) {
        const price = tariff.resolve(new Date(base + dayOffset * 86_400_000 + hour * 3_600_000)).pricePerKwh;
        if (price < min) min = price;
        if (price > max) max = price;
      }
    }

    return { min, max };
  }

  /**
   * Liczy dobową nadwyżkę PV (PV ponad zużycie). Ładowanie z sieci nie może
   * zajmować miejsca, które nazajutrz wypełniłaby darmowa energia z PV —
   * inaczej nadwyżka jest eksportowana po niskiej cenie, a magazyn został
   * wcześniej napełniony droższą energią z sieci.
   */
  public prepare(timeSeries: readonly TimeSeriesRecord[], pvScaleFactor: number): void {
    this.surplusByDay = new Map<string, number>();
    for (const r of timeSeries) {
      const surplusKw = r.pvProductionKw * pvScaleFactor - r.loadKw;
      if (surplusKw <= 0) continue;
      const key = dayKey(r.timestamp);
      this.surplusByDay.set(key, (this.surplusByDay.get(key) ?? 0) + kwToKwhPerStep(surplusKw));
    }
  }

  public execute(
    record: TimeSeriesRecord,
    bess: BessStateMachine | null,
    config: SimulationConfig,
  ): SimulationStepResult {
    // Pobór własny magazynu/falownika w czuwaniu (I4 audytu 30.09.2026) — pracuje
    // 24/7 i jest dodatkowym obciążeniem obiektu, ale TYLKO w scenariuszach z
    // magazynem (wariant bazowy bez magazynu go nie ma). Pokrywany tak samo jak
    // reszta zużycia: z PV, magazynu lub sieci.
    const standbyKw = config.bessConfig !== null ? config.bessConfig.product.standbyPowerW / 1000 : 0;
    const loadKwh = kwToKwhPerStep(record.loadKw + standbyKw);
    const pvProductionKwh = kwToKwhPerStep(record.pvProductionKw);
    const netLoadKwh = loadKwh - pvProductionKwh;

    let selfConsumedKwh = 0;
    let gridImportKwh = 0;
    let gridExportKwh = 0;
    let bessChargedKwh = 0;
    let bessChargedFromPvKwh = 0;
    let bessChargedFromGridKwh = 0;
    let bessDischargedKwh = 0;

    const bessConfig = config.bessConfig;
    const roundTripEfficiency = bessConfig?.product.roundTripEfficiency ?? 1;
    // Orientacyjny koszt zużycia ogniw za 1 kWh przełożonej energii — patrz K9
    // w komentarzu klasy. Niezależny od liczby modułów (cena i pojemność obie
    // skalują się z modułami, więc stosunek zostaje ten sam) i od segmentu
    // klienta (netto — konserwatywne przybliżenie: realny brutto koszt tylko
    // podniósłby ten próg, czyniąc arbitraż jeszcze ostrożniejszym).
    const costPerCycleKwh = bessConfig !== null
      ? bessConfig.product.pricePerUnitPln / (bessConfig.product.cycleLife * bessConfig.product.usableCapacityKwh)
      : 0;
    const zonePricePerKwh = this.tariff.resolve(record.timestamp).pricePerKwh;
    const isCheapestZone = zonePricePerKwh <= this.cheapPricePerKwh + 1e-9;
    const arbitrageWorthwhile = (this.cheapPricePerKwh / roundTripEfficiency) + costPerCycleKwh
      < this.expensivePricePerKwh - 1e-9;
    // Arbitraż z sieci tylko wtedy, gdy falownik tego wariantu umie ładować magazyn z sieci.
    const gridChargeAllowed = bessConfig?.allowGridCharge !== false;
    const arbitrageActive = this.enableGridArbitrage && gridChargeAllowed && bess !== null && bessConfig !== null && isCheapestZone && arbitrageWorthwhile;

    if (netLoadKwh > 0) {
      // Deficyt: zużycie większe niż produkcja PV.
      selfConsumedKwh = pvProductionKwh;

      if (bess !== null && !arbitrageActive) {
        // Poza najtańszą strefą (albo arbitraż nieopłacalny) — jak przy czystej autokonsumpcji.
        const dischargeResult = bess.discharge(netLoadKwh);
        bessDischargedKwh = dischargeResult.dischargedKwh;
        gridImportKwh = netLoadKwh - bessDischargedKwh;
      } else {
        // Najtańsza strefa: nie rozładowujemy magazynu — kupujemy deficyt
        // wprost z sieci po niskiej cenie, żeby zachować naładowaną energię
        // na drogą strefę.
        gridImportKwh = netLoadKwh;
        // Ochrona limitu przyłącza: ponad limit poboru pokrywa magazyn.
        const importCapKwh = this.limits.maxGridImportKw !== undefined ? this.limits.maxGridImportKw * STEP_DURATION_H : Infinity;
        if (bess !== null && gridImportKwh > importCapKwh) {
          const covered = bess.discharge(gridImportKwh - importCapKwh).dischargedKwh;
          bessDischargedKwh += covered;
          gridImportKwh -= covered;
        }
      }
    } else if (netLoadKwh < 0) {
      // Nadwyżka PV — ładowanie jak przy czystej autokonsumpcji.
      selfConsumedKwh = loadKwh;
      const surplusKwh = -netLoadKwh;

      if (bess !== null) {
        const chargeResult = bess.charge(surplusKwh);
        bessChargedKwh = chargeResult.chargedKwh;
        bessChargedFromPvKwh = chargeResult.chargedKwh;
        gridExportKwh = surplusKwh - bessChargedKwh;
      } else {
        gridExportKwh = surplusKwh;
      }
    } else {
      selfConsumedKwh = loadKwh;
    }

    // Dogranie magazynu z sieci w najtańszej strefie, ponad to, co naładowała
    // już nadwyżka PV w tym kroku — ograniczone limitem mocy ładowania.
    if (arbitrageActive && bess !== null && bessConfig !== null) {
      const maxChargeKwhPerStep = bessPowerKw(bessConfig.product, bessConfig.moduleCount, bessConfig.inverterBatteryKw) * STEP_DURATION_H;
      // Rezerwa na nadchodzącą nadwyżkę PV: przed południem — dzisiejsza, po południu — jutrzejsza.
      const upcomingSurplusKwh = this.surplusByDay.get(dayKey(new Date(record.timestamp.getTime() + HALF_DAY_MS))) ?? 0;
      const state = bess.getState();
      const ceilingSocKwh = Math.max(0, state.usableCapacityKwh - upcomingSurplusKwh);
      const roomForGridKwh = Math.max(0, ceilingSocKwh - state.socKwh)
        / halfRoundTripEfficiency(roundTripEfficiency);
      const gridHeadroomKwh = this.limits.maxGridImportKw !== undefined
        ? Math.max(0, this.limits.maxGridImportKw * STEP_DURATION_H - gridImportKwh)
        : Infinity;
      const remainingPowerBudgetKwh = Math.min(
        Math.max(0, maxChargeKwhPerStep - bessChargedKwh),
        roomForGridKwh,
        gridHeadroomKwh,
      );

      if (remainingPowerBudgetKwh > 0) {
        const topUpResult = bess.charge(remainingPowerBudgetKwh);
        bessChargedKwh += topUpResult.chargedKwh;
        bessChargedFromGridKwh += topUpResult.chargedKwh;
        gridImportKwh += topUpResult.chargedKwh;
      }
    }

    // Limit eksportu / zero export: nadwyżka ponad limit jest ucinana (nie sprzedana).
    let curtailedKwh = 0;
    if (this.limits.maxExportKw !== undefined) {
      const exportCapKwh = this.limits.maxExportKw * STEP_DURATION_H;
      if (gridExportKwh > exportCapKwh) {
        curtailedKwh = gridExportKwh - exportCapKwh;
        gridExportKwh = exportCapKwh;
      }
    }

    return {
      timestamp: record.timestamp,
      loadKw: record.loadKw,
      pvProductionKw: record.pvProductionKw,
      selfConsumedKwh,
      gridImportKwh,
      gridExportKwh,
      curtailedKwh,
      bessChargedKwh,
      bessChargedFromPvKwh,
      bessChargedFromGridKwh,
      bessDischargedKwh,
      bessState: bess !== null ? bess.getState() : null,
    };
  }
}
