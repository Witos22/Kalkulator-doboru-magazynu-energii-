/**
 * Surowy rekord godzinowy z odpowiedzi PVGIS API.
 */
export interface PvgisHourlyRecord {
  /** Timestamp w formacie "YYYYMMDD:HHMM" (UTC) */
  readonly time: string;
  /** Moc wyjściowa PV [W] */
  readonly P: number;
  /** Globalne napromieniowanie na płaszczyznę nachyloną [W/m²] */
  readonly "G(i)": number;
  /** Temperatura powietrza na 2m [°C] */
  readonly T2m: number;
  /** Prędkość wiatru na 10m [m/s] */
  readonly WS10m: number;
  /** Wysokość Słońca nad horyzontem [°] */
  readonly H_sun: number;
  /** 1 = dane interpolowane/zrekonstruowane */
  readonly Int: number;
}

/**
 * Pełna odpowiedź JSON z PVGIS API v5.3 (seriescalc).
 */
export interface PvgisResponse {
  readonly inputs: {
    readonly location: {
      readonly latitude: number;
      readonly longitude: number;
      readonly elevation: number;
    };
    readonly meteo_data: {
      readonly radiation_db: string;
      readonly meteo_db: string;
      readonly year_min: number;
      readonly year_max: number;
      readonly use_horizon: boolean;
    };
    readonly mounting_system: {
      readonly fixed: {
        readonly slope: { readonly value: number; readonly optimal: boolean };
        readonly azimuth: { readonly value: number; readonly optimal: boolean };
        readonly type: string;
      };
    };
    readonly pv_module: {
      readonly technology: string;
      readonly peak_power: number;
      readonly system_loss: number;
    };
  };
  readonly outputs: {
    readonly hourly: readonly PvgisHourlyRecord[];
  };
}

/**
 * Przetworzony rekord 15-minutowy profilu PV
 * (po interpolacji danych godzinowych z PVGIS).
 */
export interface PvProfileRecord {
  /** Timestamp w lokalnej strefie czasowej */
  readonly timestamp: Date;
  /** Moc produkcji PV [kW] */
  readonly pvProductionKw: number;
}
