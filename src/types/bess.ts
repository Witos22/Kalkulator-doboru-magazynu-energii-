/**
 * Produkt BESS z katalogu — realne urządzenie rynkowe.
 */
export interface BessProduct {
  /** Producent (np. "Sigenergy", "Huawei") */
  readonly manufacturer: string;
  /** Model (np. "SigenStor 5kWh", "LUNA2000-10-S0") */
  readonly model: string;
  /** Pojemność użyteczna jednego modułu [kWh] */
  readonly usableCapacityKwh: number;
  /** Maksymalna moc ładowania [kW] */
  readonly maxChargePowerKw: number;
  /** Maksymalna moc rozładowania [kW] */
  readonly maxDischargePowerKw: number;
  /** Sprawność cyklu round-trip (0–1, np. 0.95) */
  readonly roundTripEfficiency: number;
  /** Głębokość rozładowania [%] (np. 100) */
  readonly dodPercent: number;
  /** Żywotność w cyklach pełnych */
  readonly cycleLife: number;
  /** Roczna degradacja pojemności (np. 0.02 = 2%/rok) */
  readonly degradationPerYear: number;
  /** Gwarancja producenta [lata] */
  readonly warrantyYears: number;
  /** Cena brutto za jeden moduł [PLN] */
  readonly pricePerUnitPln: number;
  /** Czy produkt jest modularny (można stackować) */
  readonly isModular: boolean;
  /** Maksymalna ilość modułów w stacku */
  readonly maxModules: number;
}

/**
 * Konfiguracja baterii dla konkretnego scenariusza symulacji.
 */
export interface BessConfig {
  /** Produkt z katalogu */
  readonly product: BessProduct;
  /** Ilość modułów (1–N) */
  readonly moduleCount: number;
}

/**
 * Aktualny stan baterii w danym kroku symulacji.
 */
export interface BessState {
  /** Aktualny stan naładowania [kWh] */
  readonly socKwh: number;
  /** Aktualny stan naładowania [%] */
  readonly socPercent: number;
  /** Aktualna pojemność użyteczna po degradacji [kWh] */
  readonly usableCapacityKwh: number;
}

/**
 * Wynik pojedynczego kroku ładowania/rozładowania BESS.
 */
export interface BessStepResult {
  /** Ile energii faktycznie załadowano [kWh] (po stratach) */
  readonly chargedKwh: number;
  /** Ile energii faktycznie rozładowano i dostarczono [kWh] (po stratach) */
  readonly dischargedKwh: number;
  /** Nowy stan baterii */
  readonly newState: BessState;
  /** Czy żądana energia została obcięta (limit pojemności lub mocy) */
  readonly clipped: boolean;
}
