/**
 * Rekord 15-minutowy profilu produkcji PV.
 * Znacznik czasu niesie czas ścienny zapisany jako UTC (godzina z zegara, nie z instantu UTC).
 */
export interface PvProfileRecord {
  readonly timestamp: Date;
  /** Moc produkcji PV po stratach i clippingu AC [kW] */
  readonly pvProductionKw: number;
}
