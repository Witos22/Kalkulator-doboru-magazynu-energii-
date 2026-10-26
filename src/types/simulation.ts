import type { BessConfig, BessState } from "./bess.js";

/**
 * Konfiguracja pojedynczego scenariusza symulacji.
 */
export interface SimulationConfig {
  /** Moc instalacji PV [kWp] — 0 jeśli brak PV */
  readonly pvSizeKwp: number;
  /** Konfiguracja baterii (produkt + ilość modułów) */
  readonly bessConfig: BessConfig | null;
  /** Moc umowna obiektu [kW] (dla strategii Peak Shaving) */
  readonly contractedPowerKw: number;
}

/**
 * Wynik jednego kroku symulacji (15-min interwał).
 */
export interface SimulationStepResult {
  readonly timestamp: Date;
  /** Pobór obiektu [kW] */
  readonly loadKw: number;
  /** Produkcja PV [kW] */
  readonly pvProductionKw: number;
  /** Energia PV zużyta bezpośrednio na miejscu [kWh] */
  readonly selfConsumedKwh: number;
  /** Energia pobrana z sieci [kWh] */
  readonly gridImportKwh: number;
  /** Energia PV, której nie wolno było oddać (limit eksportu / zero export) i która została ucięta [kWh] */
  readonly curtailedKwh?: number | undefined;
  /** Energia oddana do sieci [kWh] */
  readonly gridExportKwh: number;
  /** Energia załadowana do baterii [kWh] (suma: z nadwyżki PV + z sieci w taniej strefie) */
  readonly bessChargedKwh: number;
  /** Z czego: energia załadowana z nadwyżki produkcji PV [kWh] */
  readonly bessChargedFromPvKwh: number;
  /** Z czego: energia dograna z sieci w najtańszej strefie taryfy (arbitraż) [kWh] */
  readonly bessChargedFromGridKwh: number;
  /** Energia rozładowana z baterii [kWh] */
  readonly bessDischargedKwh: number;
  /** Stan baterii po kroku */
  readonly bessState: BessState | null;
}

/**
 * Zagregowane wyniki rocznej symulacji.
 */
export interface SimulationResult {
  /** Konfiguracja BESS użyta w symulacji */
  readonly bessConfig: BessConfig | null;
  /** Moc PV [kWp] */
  readonly pvSizeKwp: number;

  // --- Sumy energetyczne [kWh] ---
  readonly totalLoadKwh: number;
  readonly totalPvProductionKwh: number;
  readonly totalSelfConsumedKwh: number;
  readonly totalGridImportKwh: number;
  readonly totalGridExportKwh: number;
  /** Energia PV ucięta przez limit eksportu [kWh] */
  readonly totalCurtailedKwh: number;
  readonly totalBessChargedKwh: number;
  readonly totalBessDischargedKwh: number;

  // --- Wskaźniki [%] ---
  /** Autokonsumpcja: ile PV zostało zużyte na miejscu */
  readonly selfConsumptionRate: number;
  /** Autarkia: ile zapotrzebowania pokryte z PV + BESS */
  readonly autarkyRate: number;

  // --- Szczyty ---
  /** Szczytowy pobór z sieci [kW] */
  readonly peakGridImportKw: number;

  // --- BESS metryki ---
  /** Roczna ilość pełnych cykli ekwiwalentnych */
  readonly annualCycles: number;
  /** Średnia ilość cykli dziennie w sezonie PV (III–IX) */
  readonly dailyCyclesSeasonPv: number;
  /** Wykorzystanie magazynu [%] */
  readonly storageUtilizationPercent: number;

  // --- Dane do wykresów ---
  /** Wszystkie kroki 15-min (35 040 rekordów) */
  readonly steps: SimulationStepResult[];
}
