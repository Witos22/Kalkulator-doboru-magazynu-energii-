/**
 * Generyczny, udokumentowany szablon dobowego kształtu zużycia domu
 * jednorodzinnego — używany jako WAGA do rozłożenia znanej sumy energii
 * (np. miesięcznej) na poszczególne kroki 15-min, gdy nie mamy realnego
 * pomiaru zużycia w tej rozdzielczości.
 *
 * To jest świadome, modelowe założenie (tak samo jak model słońca
 * dla produkcji PV) — NIE pomiar. Profil:
 *  - Noc (22:00–6:00): zużycie bazowe (lodówka, standby)
 *  - Poranek (6:00–8:00): podwyższone (pobudka, prysznic, śniadanie)
 *  - Dzień (8:00–16:00): niskie (typowo dom pusty)
 *  - Popołudnie/wieczór (16:00–22:00): najwyższe (gotowanie, TV, pranie)
 *  - Weekendy: +30% w ciągu dnia (dom niepusty)
 *
 * Ten sam wzorzec co w `scripts/generate-test-data.ts`, wydzielony tu do
 * wspólnego użycia przez adaptery, które muszą rozłożyć znaną sumę energii
 * na kroki czasowe bez realnych danych o profilu dobowym.
 */
export function estimateLoadShapeWeight(hour: number, isWeekend: boolean): number {
  let base: number;

  if (hour >= 22 || hour < 6) {
    base = 0.3; // Noc
  } else if (hour >= 6 && hour < 8) {
    base = 1.5; // Poranek
  } else if (hour >= 8 && hour < 16) {
    base = 0.5; // Dzień (dom pusty)
  } else {
    base = 2.0; // Popołudnie/wieczór
  }

  if (isWeekend && hour >= 8 && hour < 16) {
    base *= 1.5;
  }

  return base;
}

export function isWeekendDay(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}
