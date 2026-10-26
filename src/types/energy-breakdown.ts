/**
 * Rzeczywisty (zmierzony, nie symulowany) miesięczny pobór i oddanie energii
 * w rozbiciu na strefę 1 (dzień) i strefę 2 (noc) — pochodzi wprost z raportów
 * dobowych "Pobór A+"/"Energia oddana A-" z portalu Mój Licznik (adapter
 * `moj-licznik-daily`). Używane do wykresu "ile realnie płynęło w obie strony".
 */
export interface MonthlyZoneEnergyBreakdown {
  readonly year: number;
  readonly month: number; // 0-indexed
  readonly zone1ImportKwh: number;
  readonly zone1ExportKwh: number;
  readonly zone2ImportKwh: number;
  readonly zone2ExportKwh: number;
}

/**
 * Miesięczny rozkład wykorzystania produkcji PV dla REKOMENDOWANEGO scenariusza
 * (magazyn + PV) — ile z produkcji PV zostało zużyte na miejscu bezpośrednio,
 * ile naładowało magazyn (i skąd — z nadwyżki PV vs dogrywka z sieci w taniej
 * strefie), a ile poszło do sieci. To jest wynik SYMULACJI (dla top1), nie
 * surowy pomiar — pokazuje "część wspólną", z której korzysta magazyn.
 */
export interface MonthlyPvUsageBreakdown {
  readonly year: number;
  readonly month: number; // 0-indexed
  readonly selfConsumedKwh: number;
  /** Suma: bessChargedFromPvKwh + bessChargedFromGridKwh */
  readonly bessChargedKwh: number;
  /** Z czego: naładowane z nadwyżki produkcji PV */
  readonly bessChargedFromPvKwh: number;
  /** Z czego: dograne z sieci w najtańszej strefie taryfy (arbitraż) */
  readonly bessChargedFromGridKwh: number;
  readonly gridExportKwh: number;
}

/** Ta sama zawartość co {@link MonthlyZoneEnergyBreakdown}, tylko per dzień zamiast per miesiąc. */
export interface DailyZoneEnergyBreakdown {
  /** Data w formacie ISO (YYYY-MM-DD) */
  readonly date: string;
  readonly zone1ImportKwh: number;
  readonly zone1ExportKwh: number;
  readonly zone2ImportKwh: number;
  readonly zone2ExportKwh: number;
}

/** Ta sama zawartość co {@link MonthlyPvUsageBreakdown}, tylko per dzień zamiast per miesiąc. */
export interface DailyPvUsageBreakdown {
  /** Data w formacie ISO (YYYY-MM-DD) */
  readonly date: string;
  readonly selfConsumedKwh: number;
  readonly bessChargedKwh: number;
  readonly bessChargedFromPvKwh: number;
  readonly bessChargedFromGridKwh: number;
  readonly gridExportKwh: number;
}
