// ─── Stałe energetyczne ──────────────────────────────────────

/** Czas trwania jednego interwału symulacji [h] */
export const STEP_DURATION_H = 0.25;

/** Ilość kroków 15-min w standardowym roku (365 × 24 × 4) */
export const STEPS_PER_YEAR = 35_040;

/** Ilość kroków 15-min w roku przestępnym (366 × 24 × 4) */
export const STEPS_PER_LEAP_YEAR = 35_136;

/** Miesiąc rozpoczęcia sezonu PV (marzec) — 0-indexed */
export const PV_SEASON_START_MONTH = 2;

/** Miesiąc zakończenia sezonu PV (wrzesień) — 0-indexed */
export const PV_SEASON_END_MONTH = 8;

// ─── Helpery ─────────────────────────────────────────────────

/**
 * Przelicza moc [kW] na energię [kWh] w jednym kroku 15-min.
 * E = P × Δt = P × 0.25h
 */
export function kwToKwhPerStep(powerKw: number): number {
  return powerKw * STEP_DURATION_H;
}

/**
 * Przelicza energię [kWh] w jednym kroku 15-min na moc średnią [kW].
 * P = E / Δt = E / 0.25h
 */
export function kwhPerStepToKw(energyKwh: number): number {
  return energyKwh / STEP_DURATION_H;
}

/**
 * Ogranicza wartość do przedziału [min, max].
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Sprawdza, czy dany timestamp przypada w sezonie PV (marzec–wrzesień).
 */
export function isPvSeason(timestamp: Date): boolean {
  const month = timestamp.getMonth(); // 0-indexed
  return month >= PV_SEASON_START_MONTH && month <= PV_SEASON_END_MONTH;
}

/**
 * Liczy ilość dni w sezonie PV (marzec–wrzesień) dla danego roku.
 */
export function pvSeasonDays(year: number): number {
  let days = 0;
  for (let month = PV_SEASON_START_MONTH; month <= PV_SEASON_END_MONTH; month++) {
    // Dzień 0 następnego miesiąca = ostatni dzień bieżącego
    days += new Date(year, month + 1, 0).getDate();
  }
  return days;
}

/**
 * Oblicza pierwiastek ze sprawności cyklu.
 * Podział strat symetrycznie: √η przy ładowaniu i √η przy rozładowaniu.
 */
export function halfRoundTripEfficiency(roundTripEfficiency: number): number {
  return Math.sqrt(roundTripEfficiency);
}
