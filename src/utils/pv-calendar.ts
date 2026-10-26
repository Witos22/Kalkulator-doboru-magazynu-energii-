import type { PvProfileRecord } from "../types/pv-profile.js";

/** Zwraca produkcję PV [kW] dla znacznika czasu (czas ścienny, jak w `PvProfileRecord`). */
export type PvLookup = (timestamp: Date) => number;

function slotKey(month: number, day: number, hour: number, quarter: number): number {
  return ((month * 31 + (day - 1)) * 24 + hour) * 4 + quarter;
}

function keyOf(ts: Date): number {
  return slotKey(ts.getUTCMonth(), ts.getUTCDate(), ts.getUTCHours(), Math.floor(ts.getUTCMinutes() / 15));
}

/**
 * Dopasowanie profilu modelu słońca (jeden typowy rok) do DATY kalendarzowej rekordu zużycia,
 * a nie do pozycji w tablicy (I1 audytu 30.09.2026). Dzięki temu dane zużycia, które nie
 * zaczynają się 1 stycznia (np. 12 miesięcy X–IX), mają produkcję PV z właściwej pory roku,
 * a luki w danych, rok przestępny i zmiana czasu nie przesuwają profilu względem kalendarza.
 *
 * Klucz = (miesiąc, dzień, godzina, kwadrans). 29 lutego dostaje wartości z 28 lutego;
 * brakujący slot (np. godzina pominięta przy zmianie czasu) bierze najbliższy wcześniejszy.
 */
export function buildPvLookup(profile: readonly PvProfileRecord[]): PvLookup {
  const bySlot = new Map<number, number>();
  for (const r of profile) {
    bySlot.set(keyOf(r.timestamp), r.pvProductionKw);
  }

  return (ts: Date): number => {
    const month = ts.getUTCMonth();
    let day = ts.getUTCDate();
    if (month === 1 && day === 29 && !bySlot.has(slotKey(1, 29, ts.getUTCHours(), 0))) day = 28;
    const hour = ts.getUTCHours();
    const quarter = Math.floor(ts.getUTCMinutes() / 15);

    const direct = bySlot.get(slotKey(month, day, hour, quarter));
    if (direct !== undefined) return direct;

    // Brakujący slot — szukamy wstecz najbliższego istniejącego (max 8 kwadransów).
    for (let back = 1; back <= 8; back++) {
      const slot = hour * 4 + quarter - back;
      if (slot < 0) break;
      const v = bySlot.get(slotKey(month, day, Math.floor(slot / 4), slot % 4));
      if (v !== undefined) return v;
    }
    return 0;
  };
}

const lookupCache = new WeakMap<readonly PvProfileRecord[], PvLookup>();

/** Jak `buildPvLookup`, z pamięcią podręczną na tej samej tablicy profilu. */
export function getPvLookup(profile: readonly PvProfileRecord[]): PvLookup {
  let lookup = lookupCache.get(profile);
  if (lookup === undefined) {
    lookup = buildPvLookup(profile);
    lookupCache.set(profile, lookup);
  }
  return lookup;
}
