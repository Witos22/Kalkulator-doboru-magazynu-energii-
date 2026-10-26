/**
 * Produkt BESS z katalogu — realne urządzenie rynkowe.
 */
export interface BessProduct {
  /** Identyfikator rekordu w `public/storages.json`. */
  readonly id: string;
  /** Producent (np. "Sigenergy", "Huawei") */
  readonly manufacturer: string;
  /** Model (np. "SigenStor 5kWh", "LUNA2000-10-S0") */
  readonly model: string;
  /** Pojemność użyteczna jednej sprzedawanej sztuki [kWh] */
  readonly usableCapacityKwh: number;
  /**
   * Moc ciągła jednej sprzedawanej sztuki po limicie wieży [kW].
   * Pełną moc stosu liczy `bessPowerKw` (limit C0/C1 nie skaluje się liniowo).
   */
  readonly maxChargePowerKw: number;
  /** Maksymalna moc rozładowania jednej sztuki [kW] */
  readonly maxDischargePowerKw: number;
  /** Moc ciągła jednego modułu bateryjnego [kW], przed limitem wieży. */
  readonly modulePowerKw: number;
  /** Limit mocy jednej wieży [kW]. */
  readonly towerPowerLimitKw: number;
  /** Ile modułów bateryjnych składa się na jedną sprzedawaną sztukę. */
  readonly batteryModulesPerUnit: number;
  /** Ile modułów bateryjnych mieści jedna wieża. */
  readonly maxBatteryModulesPerTower: number;
  /** Sprawność cyklu round-trip (0–1, np. 0.95) */
  readonly roundTripEfficiency: number;
  /**
   * Głębokość rozładowania [%] (np. 100) — wyłącznie INFORMACYJNA. `usableCapacityKwh`
   * jest już pojemnością użyteczną (po DoD), więc silnik nie stosuje tego pola
   * ponownie (I3 audytu 30.09.2026).
   */
  readonly dodPercent: number;
  /** Żywotność w cyklach pełnych */
  readonly cycleLife: number;
  /** Roczna degradacja pojemności (np. 0.02 = 2%/rok) */
  readonly degradationPerYear: number;
  /** Gwarancja producenta [lata] */
  readonly warrantyYears: number;
  /** Cena NETTO za jeden moduł [PLN] — VAT dolicza `FinancialCalculator` wg segmentu klienta */
  readonly pricePerUnitPln: number;
  /** Czy produkt jest modularny (można stackować) */
  readonly isModular: boolean;
  /** Maksymalna ilość modułów w stacku */
  readonly maxModules: number;
  /**
   * Marka falownika/sterownika WYMAGANA do pracy tego magazynu (K3 audytu
   * 30.09.2026) — np. Huawei LUNA2000 wymaga falownika hybrydowego Huawei,
   * Sigenergy SigenStor wymaga sterownika Sigenergy. Jeśli klient deklaruje
   * inny istniejący falownik (`AnalysisParams.existingInverterBrand`), do
   * kosztu inwestycji dolicza się `estimatedInverterUpgradeCostPln`.
   */
  readonly requiredInverterBrand: string;
  /**
   * Orientacyjny koszt NETTO wymiany/dołożenia falownika hybrydowego + montażu
   * + zabezpieczeń, gdy istniejący falownik klienta nie jest zgodny z marką
   * wymaganą przez ten magazyn [PLN]. Wartość szacunkowa — [DO WERYFIKACJI]
   * per konkretny model, moc i lokalne stawki wykonawcze.
   */
  readonly estimatedInverterUpgradeCostPln: number;
  /**
   * Orientacyjny koszt NETTO samego montażu magazynu (bez falownika) —
   * robocizna, okablowanie, zabezpieczenia, ewentualny backup box [PLN].
   * Wartość szacunkowa — [DO WERYFIKACJI] per lokalne stawki wykonawcze.
   */
  readonly estimatedInstallationCostPln: number;
  /**
   * Pobór własny magazynu + jego falownika/EMS w czuwaniu [W] (I4 audytu 30.09.2026).
   * Pracuje 24/7, więc 30 W to ~263 kWh/rok dodatkowego poboru z sieci — dla małego
   * magazynu to kilkanaście procent rocznych oszczędności. Wartość ORIENTACYJNA
   * (audyt podaje tylko rząd wielkości) — [DO WERYFIKACJI z kartą katalogową].
   */
  readonly standbyPowerW: number;
}

/**
 * Konfiguracja baterii dla konkretnego scenariusza symulacji.
 */
export interface BessConfig {
  /** Produkt z katalogu */
  readonly product: BessProduct;
  /** Ilość modułów (1–N) */
  readonly moduleCount: number;
  /**
   * Koszt netto falownika doliczany do tej konfiguracji [PLN].
   * Ustawia decyzja o falowniku. Brak pola = stara reguła po marce.
   */
  readonly inverterCostNetPln?: number;
  /** Sprzężenie magazynu z instalacją PV w tym wariancie. */
  readonly coupling?: "DC" | "AC";
  /** Ładowanie magazynu z sieci. Fałsz wyłącza arbitraż taryfowy. */
  readonly allowGridCharge?: boolean;
  /** Maksymalna moc baterii falownika [kW]. Brak pola = brak tego limitu. */
  readonly inverterBatteryKw?: number;
  /** Zdanie do raportu: skąd wziął się koszt i sprzężenie. */
  readonly inverterDecisionLabel?: string;
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
