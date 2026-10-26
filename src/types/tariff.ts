/**
 * Typ taryfy energetycznej dla klientów indywidualnych w Polsce.
 */
export type TariffType = "G11" | "G12" | "G12w" | "G13";

/**
 * Cena strefy rozbita na dwa niezależne składniki — patrz komentarz przy
 * `ZonePriceComponents` niżej. Rozdzielenie umożliwia użytkownikowi
 * skorygowanie tylko ceny energii (która różni się między sprzedawcami)
 * bez ruszania stawek dystrybucyjnych (urzędowych, takich samych dla
 * wszystkich klientów danego OSD i taryfy).
 */
export interface TariffZone {
  /** Nazwa strefy (np. "szczyt", "pozaszyt", "noc", "jednolita") */
  readonly name: string;
  /** Składnik sprzedażowy: cena samej energii [PLN/kWh] */
  readonly energyPricePerKwh: number;
  /** Składnik dystrybucyjny (OSD): stawka sieciowa zmienna [PLN/kWh] */
  readonly distributionPricePerKwh: number;
  /** Suma obu składników [PLN/kWh] — to, co faktycznie płaci się za 1 kWh z sieci */
  readonly pricePerKwh: number;
}

/** Ceny dwóch składników dla jednej strefy taryfowej. */
export interface ZonePriceComponents {
  readonly energyPricePerKwh: number;
  readonly distributionPricePerKwh: number;
}

/**
 * Definicja cen dla poszczególnych stref taryfy.
 */
export interface TariffPrices {
  readonly type: TariffType;
  /** Ceny per strefa — klucz to nazwa strefy */
  readonly zones: Readonly<Record<string, ZonePriceComponents>>;
}

/**
 * Harmonogram taryfowy — rozwiązuje cenę dla danego timestampu.
 */
export interface TariffSchedule {
  readonly type: TariffType;
  /** Zwraca strefę taryfową (z ceną) dla danego momentu czasowego */
  resolve(timestamp: Date): TariffZone;
}

// ─── Domyślne ceny (orientacyjne, Q3 2026) ───────────────────

/**
 * Domyślne ceny netto [PLN/kWh] dla taryf, rozbite na składnik sprzedażowy
 * (cena energii — różni się między sprzedawcami, użytkownik powinien
 * skorygować wg własnej faktury) i dystrybucyjny (OSD — stawka sieciowa
 * zmienna, urzędowo zatwierdzona, ta sama dla wszystkich klientów danego
 * OSD w danej taryfie). Wartości orientacyjne — użytkownik może je nadpisać.
 */
/** Pochodzenie stawek domyślnych — pokazywane przy tabeli stawek i w raporcie (audyt: źródło widoczne przy każdej wartości). */
export const DEFAULT_TARIFF_PRICES_SOURCE =
  "Orientacyjne wartości kalkulatora (netto), nie pochodzą z zatwierdzonej taryfy URE ani z cennika konkretnego OSD — zweryfikuj z fakturą klienta.";

export const DEFAULT_TARIFF_PRICES: Readonly<Record<TariffType, TariffPrices>> = {
  G11: {
    type: "G11",
    zones: {
      jednolita: { energyPricePerKwh: 0.55, distributionPricePerKwh: 0.35 },
    },
  },
  G12: {
    type: "G12",
    zones: {
      dzien: { energyPricePerKwh: 0.60, distributionPricePerKwh: 0.40 },
      noc: { energyPricePerKwh: 0.35, distributionPricePerKwh: 0.09 },
    },
  },
  G12w: {
    type: "G12w",
    zones: {
      dzien: { energyPricePerKwh: 0.60, distributionPricePerKwh: 0.40 },
      noc_weekend: { energyPricePerKwh: 0.35, distributionPricePerKwh: 0.09 },
    },
  },
  G13: {
    type: "G13",
    zones: {
      szczyt: { energyPricePerKwh: 0.68, distributionPricePerKwh: 0.42 },
      pozaszczyt: { energyPricePerKwh: 0.52, distributionPricePerKwh: 0.32 },
      noc: { energyPricePerKwh: 0.32, distributionPricePerKwh: 0.09 },
    },
  },
} as const;

function resolveZone(name: string, components: ZonePriceComponents | undefined, fallback: ZonePriceComponents): TariffZone {
  const c = components ?? fallback;
  return {
    name,
    energyPricePerKwh: c.energyPricePerKwh,
    distributionPricePerKwh: c.distributionPricePerKwh,
    pricePerKwh: c.energyPricePerKwh + c.distributionPricePerKwh,
  };
}

// ─── Factory do tworzenia TariffSchedule ────────────────────

/**
 * Tworzy TariffSchedule na podstawie typu taryfy i opcjonalnych cen.
 */
export function createTariffSchedule(
  type: TariffType,
  customPrices?: TariffPrices,
): TariffSchedule {
  const prices = customPrices ?? DEFAULT_TARIFF_PRICES[type];
  const defaults = DEFAULT_TARIFF_PRICES[type];

  switch (type) {
    case "G11":
      return {
        type: "G11",
        resolve: () => resolveZone("jednolita", prices.zones["jednolita"], defaults.zones["jednolita"]!),
      };

    case "G12":
      return {
        type: "G12",
        resolve: (timestamp: Date) => {
          // Profil trzyma godzinę ścienną w polach UTC, więc strefa nie zależy od zegara komputera.
          const hour = timestamp.getUTCHours();
          // Dzień: 6:00–22:00, Noc: 22:00–6:00
          if (hour >= 6 && hour < 22) {
            return resolveZone("dzien", prices.zones["dzien"], defaults.zones["dzien"]!);
          }
          return resolveZone("noc", prices.zones["noc"], defaults.zones["noc"]!);
        },
      };

    case "G12w":
      return {
        type: "G12w",
        resolve: (timestamp: Date) => {
          const hour = timestamp.getUTCHours();
          const day = timestamp.getUTCDay(); // 0=niedziela, 6=sobota
          const isWeekend = day === 0 || day === 6;
          // Dzień: 6:00–22:00 pon-pt, Noc+Weekend: reszta
          if (!isWeekend && hour >= 6 && hour < 22) {
            return resolveZone("dzien", prices.zones["dzien"], defaults.zones["dzien"]!);
          }
          return resolveZone("noc_weekend", prices.zones["noc_weekend"], defaults.zones["noc_weekend"]!);
        },
      };

    case "G13":
      return {
        type: "G13",
        resolve: (timestamp: Date) => {
          const hour = timestamp.getUTCHours();
          // Szczyt: 7:00–13:00 + 16:00–22:00
          // Pozaszczyt: 13:00–16:00
          // Noc: 22:00–7:00
          if ((hour >= 7 && hour < 13) || (hour >= 16 && hour < 22)) {
            return resolveZone("szczyt", prices.zones["szczyt"], defaults.zones["szczyt"]!);
          }
          if (hour >= 13 && hour < 16) {
            return resolveZone("pozaszczyt", prices.zones["pozaszczyt"], defaults.zones["pozaszczyt"]!);
          }
          return resolveZone("noc", prices.zones["noc"], defaults.zones["noc"]!);
        },
      };
  }
}
