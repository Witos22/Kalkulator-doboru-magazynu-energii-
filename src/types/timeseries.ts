/**
 * Zunifikowany rekord 15-minutowy — wspólne DTO z adapterów.
 * Reprezentuje pojedynczy punkt danych w szeregu czasowym.
 */
export interface TimeSeriesRecord {
  /** Timestamp początku interwału 15-min */
  readonly timestamp: Date;
  /** Pobór obiektu [kW] — zawsze dodatni */
  readonly loadKw: number;
  /** Produkcja PV [kW] — 0 jeśli brak PV lub dane z OSD */
  readonly pvProductionKw: number;
}

/**
 * Surowy wiersz z pliku CSV OSD (np. Tauron, PGE).
 * Wszystkie pola jako stringi — przed parsowaniem.
 */
export interface RawOsdRow {
  readonly date: string;
  readonly time: string;
  /** Pobór energii z sieci [kWh] w interwale */
  readonly consumption: string;
  /** Oddanie energii do sieci [kWh] w interwale (prosumenci) */
  readonly feedIn?: string;
}

/**
 * Surowy wiersz z eksportu SEMS (GoodWe / Sigenergy).
 * Zawiera zarówno zużycie jak i produkcję PV.
 */
export interface RawSemsRow {
  readonly timestamp: string;
  /** Moc poboru obiektu [kW] lub energia [kWh] — zależy od eksportu */
  readonly load: string;
  /** Moc produkcji PV [kW] lub energia [kWh] */
  readonly pvProduction: string;
  /** Opcjonalnie: moc ładowania/rozładowania baterii */
  readonly batteryPower?: string;
}
